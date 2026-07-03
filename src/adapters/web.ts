/**
 * Web adapter — the seam for browser/desktop/mobile UIs. Serves the static
 * client from web/ over plain node:http and speaks a small JSON-frame protocol
 * on a WebSocket at /ws (server side via `ws` — Node has no built-in
 * server-side WebSocket).
 *
 * Protocol:  client → { type:'hello', userName, channelId, password? }
 *                     { type:'say', text }
 *            server → { type:'welcome', userId, channelId }   (your seat)
 *                     { type:'roster', users }                (room membership)
 *                     { type:'msg', speaker?, text, private?: true }
 *                     { type:'error', error }
 * `channelId` is a room code, so multiple parties can share one server; each
 * connection gets a fresh stable userId, and fog-of-war whispers
 * (`targetUserId`) go only to that user's socket(s), flagged `private:true`.
 *
 * Binds to loopback by default ON PURPOSE: there is no TLS and (unless
 * WEB_PASSWORD is set) no auth. To expose it beyond localhost, put a reverse
 * proxy with HTTPS + auth in front and set WEB_HOST=0.0.0.0 deliberately.
 *
 * Robustness: malformed frames get an { type:'error' } reply, never a crash;
 * a closing socket leaves the roster; a per-connection rate limit
 * (RATE_LIMIT_PER_SEC) keeps one client from spamming the LLM.
 */
import { createServer, type IncomingMessage as HttpRequest, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../core/types.js';

/** Max `say` frames per connection per rolling second; excess gets an error frame. */
export const RATE_LIMIT_PER_SEC = 5;

const WEB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** One joined seat: a socket that has completed the hello handshake. */
interface Seat {
  ws: WebSocket;
  userId: string;
  userName: string;
  channelId: string;
  saidAt: number[]; // recent `say` timestamps, for the rate limit
}

export class WebAdapter implements PlatformAdapter {
  readonly name = 'web';
  private handler?: (msg: IncomingMessage) => void | Promise<void>;
  private http?: Server;
  private wss?: WebSocketServer;
  private seats = new Map<WebSocket, Seat>();

  constructor(
    private readonly host = '127.0.0.1',
    private readonly configuredPort = 8787,
    private readonly password = '',
  ) {}

  /** The actual bound port — differs from the configured one when it was 0 (ephemeral). */
  get port(): number {
    const addr = this.http?.address();
    return addr && typeof addr === 'object' ? (addr as AddressInfo).port : this.configuredPort;
  }

  onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.http = createServer((req, res) => void this.serveStatic(req, res));
    this.wss = new WebSocketServer({ server: this.http, path: '/ws' });
    this.wss.on('connection', (ws) => {
      ws.on('message', (data) => this.onFrame(ws, String(data)));
      ws.on('close', () => this.dropSeat(ws));
      ws.on('error', () => ws.close());
    });
    await new Promise<void>((resolve, reject) => {
      this.http!.once('error', reject);
      this.http!.listen(this.configuredPort, this.host, resolve);
    });
    console.log(
      `🌐 Web adapter on http://${this.host}:${this.port} — open it in a browser and share the room code.\n` +
        `   (Loopback-only by default; expose it via a reverse proxy with HTTPS/auth, not by itself.)`,
    );
  }

  async stop(): Promise<void> {
    for (const ws of this.seats.keys()) ws.close();
    this.wss?.close();
    this.http?.closeAllConnections(); // idle keep-alive HTTP connections would otherwise stall close()
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
  }

  async send(msg: OutgoingMessage): Promise<void> {
    const frame = JSON.stringify({
      type: 'msg',
      speaker: msg.speaker,
      text: msg.text,
      ...(msg.targetUserId ? { private: true } : {}),
    });
    for (const seat of this.seats.values()) {
      if (seat.channelId !== msg.channelId) continue;
      if (msg.targetUserId && seat.userId !== msg.targetUserId) continue; // fog-of-war whisper
      seat.ws.send(frame);
    }
  }

  /** One inbound frame. Every failure mode answers with an error frame — never a crash. */
  private onFrame(ws: WebSocket, raw: string): void {
    let frame: { type?: unknown; userName?: unknown; channelId?: unknown; password?: unknown; text?: unknown };
    try {
      frame = JSON.parse(raw);
    } catch {
      return this.error(ws, 'Malformed frame: not JSON.');
    }
    if (frame?.type === 'hello') return this.hello(ws, frame);
    if (frame?.type === 'say') return this.say(ws, frame);
    this.error(ws, `Unknown frame type ${JSON.stringify(frame?.type ?? null)} — expected "hello" or "say".`);
  }

  /** Join a room: check the password, assign a userId, announce the roster. */
  private hello(ws: WebSocket, frame: { userName?: unknown; channelId?: unknown; password?: unknown }): void {
    if (this.password && frame.password !== this.password) {
      this.error(ws, 'Wrong or missing password.');
      return ws.close();
    }
    const userName = typeof frame.userName === 'string' ? frame.userName.trim() : '';
    const channelId = typeof frame.channelId === 'string' ? frame.channelId.trim() : '';
    if (!userName || !channelId) return this.error(ws, 'hello needs a non-empty userName and channelId.');
    if (this.seats.has(ws)) return this.error(ws, 'Already joined — one hello per connection.');
    const seat: Seat = { ws, userId: `web-${nanoid(8)}`, userName, channelId, saidAt: [] };
    this.seats.set(ws, seat);
    ws.send(JSON.stringify({ type: 'welcome', userId: seat.userId, channelId }));
    this.broadcastRoster(channelId);
  }

  /** A chat line: rate-limit, relay to the room, hand to the bot core. */
  private say(ws: WebSocket, frame: { text?: unknown }): void {
    const seat = this.seats.get(ws);
    if (!seat) return this.error(ws, 'Say hello first: { type:"hello", userName, channelId }.');
    const text = typeof frame.text === 'string' ? frame.text.trim() : '';
    if (!text) return this.error(ws, 'say needs a non-empty text.');
    const now = Date.now();
    seat.saidAt = seat.saidAt.filter((t) => now - t < 1000);
    if (seat.saidAt.length >= RATE_LIMIT_PER_SEC) return this.error(ws, 'Rate limit: slow down (5 messages/second).');
    seat.saidAt.push(now);
    // Relay the player's line to the room (the web UI has no native chat layer),
    // then dispatch it to the engine. A handler rejection must not kill the server.
    const relay = JSON.stringify({ type: 'msg', speaker: seat.userName, text });
    for (const s of this.seats.values()) if (s.channelId === seat.channelId) s.ws.send(relay);
    Promise.resolve(
      this.handler?.({ platform: 'web', channelId: seat.channelId, userId: seat.userId, userName: seat.userName, text }),
    ).catch((err) => console.error('[web] message handling failed:', (err as Error)?.message ?? err));
  }

  /** Remove a closed socket's seat and re-announce its room's roster. */
  private dropSeat(ws: WebSocket): void {
    const seat = this.seats.get(ws);
    if (!seat) return;
    this.seats.delete(ws);
    this.broadcastRoster(seat.channelId);
  }

  private broadcastRoster(channelId: string): void {
    const inRoom = [...this.seats.values()].filter((s) => s.channelId === channelId);
    const frame = JSON.stringify({ type: 'roster', users: inRoom.map((s) => ({ userId: s.userId, userName: s.userName })) });
    for (const s of inRoom) s.ws.send(frame);
  }

  private error(ws: WebSocket, error: string): void {
    ws.send(JSON.stringify({ type: 'error', error }));
  }

  /** Serve the static client from web/ — GET/HEAD only, no path traversal. */
  private async serveStatic(req: HttpRequest, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return void res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    }
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    const file = path.normalize(path.join(WEB_ROOT, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(WEB_ROOT + path.sep)) return void res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  }
}
