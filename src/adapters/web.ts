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
import type { GameSession, IncomingMessage, OutgoingMessage, PlatformAdapter, Player } from '../core/types.js';
import type { Portrait } from '../core/cards/card.js';
import type { SessionStorage } from '../core/session/storage.js';

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
/** Upload cap for POST /portrait — portraits are small; bytes go over HTTP, never a WS frame. */
export const MAX_PORTRAIT_BYTES = 256 * 1024;
/** Web userIds are `web-<nanoid>` (~12 chars); bound the path component anyway. */
export const MAX_USER_CHARS = 128;
/** Per-seat card summary length in the enriched roster — keep the frame well under the cap. */
export const MAX_CARD_SUMMARY_CHARS = 240;

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
  /** In-memory portrait uploads, keyed by channel+user. Bytes never touch a WS frame. */
  private uploads = new Map<string, { mime: string; bytes: Buffer }>();

  constructor(
    private readonly host = '127.0.0.1',
    private readonly configuredPort = 8787,
    private readonly password = '',
    private readonly maxConnections = 128,
    private readonly helloTimeoutMs = 10_000,
    /**
     * Shared session storage — the SAME instance the Bot uses, so the adapter
     * can enrich the roster with each seat's character/portrait and serve
     * card-embedded portrait bytes. Omitted in bot-less tests; roster then
     * carries names only and card portraits 404.
     */
    private readonly storage?: SessionStorage,
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
    this.http = createServer((req, res) => this.route(req, res).catch(() => res.destroy()));
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
    void this.broadcastRoster(channelId);
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
    )
      .catch((err) => console.error('[web] message handling failed:', (err as Error)?.message ?? err))
      // The line may have changed character/portrait/persona state (a `/dm`
      // command or an action); refresh the enriched roster from storage.
      .finally(() => void this.broadcastRoster(seat.channelId));
  }

  /** Remove a closed socket's seat and re-announce its room's roster. */
  private dropSeat(ws: WebSocket): void {
    const seat = this.seats.get(ws);
    if (!seat) return;
    this.seats.delete(ws);
    void this.broadcastRoster(seat.channelId);
  }

  /**
   * Announce a room's membership, enriched from the shared session: each seat
   * carries its character name, a portrait DESCRIPTOR (preset id, or an image
   * referenced by /portrait URL — never inline bytes, to respect the frame
   * cap), and a bounded card summary when a persona is imported.
   */
  private async broadcastRoster(channelId: string): Promise<void> {
    const inRoom = [...this.seats.values()].filter((s) => s.channelId === channelId);
    if (!inRoom.length) return;
    const session = (await this.storage?.load(sessionKey(channelId)).catch(() => null)) ?? null;
    const users = inRoom.map((s) => this.describeSeat(s, session));
    const frame = JSON.stringify({ type: 'roster', users });
    for (const s of inRoom) s.ws.send(frame);
  }

  /** One roster entry: identity + character + portrait descriptor + bounded card summary. */
  private describeSeat(seat: Seat, session: GameSession | null): Record<string, unknown> {
    const player = session?.players?.[seat.userId];
    const card = player?.card;
    return {
      userId: seat.userId,
      userName: seat.userName,
      characterName: player?.characterName,
      portrait: this.portraitDescriptor(seat.channelId, seat.userId, player),
      ...(card
        ? {
            card: {
              name: card.name,
              description: clampText(card.description || card.personality || '', MAX_CARD_SUMMARY_CHARS),
            },
          }
        : {}),
    };
  }

  /** The portrait descriptor for the roster: an upload wins, then the player/card portrait. */
  private portraitDescriptor(
    channelId: string,
    userId: string,
    player: Player | undefined,
  ): { kind: 'preset'; id: string } | { kind: 'image'; url: string } | null {
    if (this.uploads.has(uploadKey(channelId, userId))) return { kind: 'image', url: portraitUrl(channelId, userId) };
    const p = player ? effectivePortrait(player) : undefined;
    if (p?.kind === 'preset') return { kind: 'preset', id: p.id };
    if (p?.kind === 'image') return { kind: 'image', url: portraitUrl(channelId, userId) };
    return null;
  }

  private error(ws: WebSocket, error: string): void {
    ws.send(JSON.stringify({ type: 'error', error }));
  }

  /** Route an HTTP request: /portrait/* endpoints, else the static client. */
  private async route(req: HttpRequest, res: ServerResponse): Promise<void> {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      return void res.writeHead(400).end(); // Node's parser accepts request-targets WHATWG URL rejects (e.g. "//[")
    }
    if (pathname === '/portrait' || pathname.startsWith('/portrait/')) return this.handlePortrait(req, res, pathname);
    return this.serveStatic(req, res, pathname);
  }

  /**
   * Portrait endpoint. GET/HEAD serves a user's portrait image bytes (upload,
   * else a card-embedded image); POST accepts an image upload to set it.
   *   /portrait/<channelId>/<userId>
   * Path components are decoded and guarded (no separators/NUL, bounded): they
   * key an in-memory store and a channel-scoped session lookup, so a `..` or a
   * mismatched userId can't traverse the disk or leak another room's portrait.
   */
  private async handlePortrait(req: HttpRequest, res: ServerResponse, pathname: string): Promise<void> {
    const segs = pathname.split('/').filter((s) => s.length > 0); // ['portrait', channelId, userId]
    if (segs.length !== 3) return void res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    let channelId: string;
    let userId: string;
    try {
      channelId = decodeURIComponent(segs[1]);
      userId = decodeURIComponent(segs[2]);
    } catch {
      return void res.writeHead(400).end();
    }
    if (!validPathId(channelId, MAX_ROOM_CHARS) || !validPathId(userId, MAX_USER_CHARS))
      return void res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    if (req.method === 'GET' || req.method === 'HEAD') return this.getPortrait(req, res, channelId, userId);
    if (req.method === 'POST') return this.postPortrait(req, res, channelId, userId);
    return void res.writeHead(405, { Allow: 'GET, HEAD, POST' }).end();
  }

  /** Serve a user's portrait bytes with an image content-type, or 404. */
  private async getPortrait(req: HttpRequest, res: ServerResponse, channelId: string, userId: string): Promise<void> {
    const img = await this.resolvePortrait(channelId, userId);
    if (!img) return void res.writeHead(404, { 'Content-Type': 'text/plain' }).end('No portrait');
    res.writeHead(200, {
      'Content-Type': img.mime,
      'Content-Length': String(img.bytes.length),
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : img.bytes);
  }

  /** An uploaded portrait wins; otherwise the player's/card's stored image bytes. */
  private async resolvePortrait(channelId: string, userId: string): Promise<{ mime: string; bytes: Buffer } | null> {
    const up = this.uploads.get(uploadKey(channelId, userId));
    if (up) return up;
    const session = (await this.storage?.load(sessionKey(channelId)).catch(() => null)) ?? null;
    const p = session?.players?.[userId] && effectivePortrait(session.players[userId]);
    if (p?.kind === 'image') {
      try {
        const bytes = Buffer.from(p.data, 'base64');
        if (bytes.length) return { mime: p.mime || 'application/octet-stream', bytes };
      } catch {
        /* fall through to 404 */
      }
    }
    return null;
  }

  /** Accept an `image/*` upload (size-capped; password-gated when the room has one). */
  private async postPortrait(req: HttpRequest, res: ServerResponse, channelId: string, userId: string): Promise<void> {
    if (this.password && !this.uploadAuthorized(req)) {
      return void res.writeHead(401, { 'Content-Type': 'text/plain' }).end('Unauthorized');
    }
    const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/') || contentType === 'image/') {
      return void res.writeHead(415, { 'Content-Type': 'text/plain' }).end('Content-Type must be image/*');
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_PORTRAIT_BYTES) {
      res.writeHead(413, { 'Content-Type': 'text/plain' }).end('Portrait too large');
      return void req.resume(); // discard the incoming body so the socket closes cleanly
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    for await (const chunk of req) {
      const b = chunk as Buffer;
      total += b.length;
      if (over) continue; // keep draining, stop buffering
      if (total > MAX_PORTRAIT_BYTES) {
        over = true;
        chunks.length = 0;
        continue;
      }
      chunks.push(b);
    }
    if (over) return void res.writeHead(413, { 'Content-Type': 'text/plain' }).end('Portrait too large');
    const bytes = Buffer.concat(chunks);
    if (!bytes.length) return void res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Empty body');
    this.uploads.set(uploadKey(channelId, userId), { mime: contentType, bytes });
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, url: portraitUrl(channelId, userId) }));
    void this.broadcastRoster(channelId); // clients pick up the new portrait
  }

  /** Room-password check for uploads: `?password=` query or `x-web-password` header. */
  private uploadAuthorized(req: HttpRequest): boolean {
    let query = '';
    try {
      query = new URL(req.url ?? '/', 'http://x').searchParams.get('password') ?? '';
    } catch {
      query = '';
    }
    const header = req.headers['x-web-password'];
    const given = (typeof header === 'string' && header) || query || '';
    return given === this.password;
  }

  /** Serve the static client from web/ — GET/HEAD only, no path traversal. */
  private async serveStatic(req: HttpRequest, res: ServerResponse, pathname: string): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return void res.writeHead(405, { Allow: 'GET, HEAD' }).end();
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

/** Storage key for a web room — the web adapter's platform is always 'web'. */
const sessionKey = (channelId: string) => `web:${channelId}`;

/** In-memory upload key — NUL-joined so it can't collide with real ids. */
const uploadKey = (channelId: string, userId: string) => `${channelId} ${userId}`;

/** The same-origin URL a portrait is served from (components percent-encoded). */
const portraitUrl = (channelId: string, userId: string) =>
  `/portrait/${encodeURIComponent(channelId)}/${encodeURIComponent(userId)}`;

/** A player's live portrait: their own overrides the imported card's. */
const effectivePortrait = (player: Player): Portrait | undefined => player.portrait ?? player.card?.portrait;

/** A path component safe to key stores/lookups: non-empty, bounded, no separators/NUL. */
const validPathId = (v: string, max: number): boolean => v.length > 0 && v.length <= max && !/[/\\\0]/.test(v);

/** Clip untrusted card text so an enriched roster frame stays small. */
const clampText = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
