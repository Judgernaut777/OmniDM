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
 * After a reconnect, `/dm join <name>` re-claims the old party seat under the
 * new userId (session-manager migrates the entry), so round-robin and
 * whispers keep working.
 *
 * Binds to loopback by default ON PURPOSE: there is no TLS and (unless
 * WEB_PASSWORD is set) no auth. To expose it beyond localhost, put a reverse
 * proxy with HTTPS + auth in front and set WEB_HOST=0.0.0.0 deliberately.
 *
 * Robustness: malformed frames get an { type:'error' } reply, never a crash;
 * a closing socket leaves the roster; a per-connection rate limit
 * (RATE_LIMIT_PER_SEC) keeps one client from spamming the LLM. Abuse limits
 * hold even against raw sockets: frames are size-capped (MAX_FRAME_BYTES),
 * fields are length-capped server-side, connections are counted against a cap,
 * a socket that never completes hello is reaped after a deadline, and a
 * pre-hello frame flood drops the socket instead of being answered forever.
 */
import { createServer, type IncomingMessage as HttpRequest, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../core/types.js';

/** Max `say` frames per joined connection per rolling second; excess gets an error frame. */
export const RATE_LIMIT_PER_SEC = 5;
/** Frames tolerated per rolling second from a socket that has not completed hello; excess drops it (replying would amplify a flood). */
export const UNJOINED_FRAMES_PER_SEC = 10;
/** Hard cap on any single WebSocket frame (`ws` maxPayload — its default is 100 MB). */
export const MAX_FRAME_BYTES = 32 * 1024;
/** Server-side field caps — the client's maxlength attributes are advisory only. */
export const MAX_NAME_CHARS = 40;
export const MAX_ROOM_CHARS = 64;
export const MAX_TEXT_CHARS = 4000;

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
    private readonly maxConnections = 128,
    private readonly helloTimeoutMs = 10_000,
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
    this.http = createServer((req, res) => this.serveStatic(req, res).catch(() => res.destroy()));
    this.wss = new WebSocketServer({ server: this.http, path: '/ws', maxPayload: MAX_FRAME_BYTES });
    this.wss.on('connection', (ws) => {
      if (this.wss!.clients.size > this.maxConnections) {
        this.error(ws, 'Server full — try again later.');
        return ws.close();
      }
      // Reap a socket that never completes hello — it is bound by no seat-level
      // limit and would otherwise be held open forever, for free.
      const reaper = setTimeout(() => { if (!this.seats.has(ws)) ws.terminate(); }, this.helloTimeoutMs);
      const preHello: number[] = []; // frame timestamps before a seat exists
      ws.on('message', (data) => this.onFrame(ws, String(data), preHello));
      ws.on('close', () => { clearTimeout(reaper); this.dropSeat(ws); });
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
  private onFrame(ws: WebSocket, raw: string, preHello: number[]): void {
    if (!this.seats.has(ws)) {
      // No seat yet, so no seat-level rate limit applies: give un-joined
      // sockets a small frame budget and drop them beyond it.
      const now = Date.now();
      while (preHello.length && now - preHello[0] >= 1000) preHello.shift();
      if (preHello.push(now) > UNJOINED_FRAMES_PER_SEC) return ws.terminate();
    }
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
    if (userName.length > MAX_NAME_CHARS || channelId.length > MAX_ROOM_CHARS)
      return this.error(ws, `hello fields too long (userName ≤ ${MAX_NAME_CHARS}, channelId ≤ ${MAX_ROOM_CHARS} chars).`);
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
    if (text.length > MAX_TEXT_CHARS) return this.error(ws, `say text too long (max ${MAX_TEXT_CHARS} chars).`);
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
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      return void res.writeHead(400).end(); // Node's parser accepts request-targets WHATWG URL rejects (e.g. "//[")
    }
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
