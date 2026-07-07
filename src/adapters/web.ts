/**
 * Web adapter — a THIN HTTP + WebSocket transport over the shared RoomEngine.
 *
 * All the room/protocol semantics (roster enrichment, scene/token
 * reconciliation, roll framing, fog routing, portrait descriptors, the
 * hello/say/move protocol) live in ../core/room/room-engine.ts, with no node:
 * dependencies, so the in-app LocalTransport can reuse the SAME implementation.
 * This file is only the Node plumbing the engine can't own: a node:http server
 * serving the static client from web/, a `ws` WebSocket server, the raw-socket
 * abuse defenses (frame size cap, pre-hello flood, connection cap, hello
 * deadline), and the HTTP portrait upload/serve endpoints (bytes travel over
 * HTTP, never a WS frame). Each socket is wrapped in a `RoomConnection`; the
 * engine does the rest.
 *
 * Protocol (unchanged):
 *   client → { type:'hello', userName, channelId, password? } | { type:'say', text } | { type:'move', id, x, y }
 *   server → welcome | roster | msg | roll | scene | error
 *
 * Binds to loopback by default ON PURPOSE: no TLS and (unless WEB_PASSWORD) no
 * auth. Expose it only behind a reverse proxy with HTTPS + auth.
 */
import { createServer, type IncomingMessage as HttpRequest, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../core/types.js';
import type { SessionStorage } from '../core/session/storage.js';
import { isBillingPath, type BillingHttpRequest, type BillingHttpResponse } from '../core/billing/handler.js';
import {
  MAX_ROOM_CHARS,
  MAX_USER_CHARS,
  RoomEngine,
  type Frame,
  type InboundFrame,
  type RoomConnection,
} from '../core/room/room-engine.js';

// Re-export the protocol constants the smoke test imports from this module.
export { RATE_LIMIT_PER_SEC, MAX_NAME_CHARS, MAX_TEXT_CHARS, MAX_CARD_SUMMARY_CHARS } from '../core/room/room-engine.js';

/** Frames tolerated per rolling second from a socket that has not completed hello; excess drops it. */
export const UNJOINED_FRAMES_PER_SEC = 10;
/** Hard cap on any single WebSocket frame (`ws` maxPayload — its default is 100 MB). */
export const MAX_FRAME_BYTES = 32 * 1024;
/** Upload cap for POST /portrait — portraits are small; bytes go over HTTP, never a WS frame. */
export const MAX_PORTRAIT_BYTES = 256 * 1024;
/** Cap on a billing request body (webhook events + tiny checkout JSON are well under this). */
export const MAX_BILLING_BODY_BYTES = 512 * 1024;
/**
 * Raster image types a portrait upload may carry AND that may be served back
 * inline. `image/svg+xml` is deliberately EXCLUDED: an SVG is an active document
 * and, served on the app's own origin, would be a stored XSS.
 */
export const PORTRAIT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

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

export class WebAdapter implements PlatformAdapter {
  readonly name = 'web';
  private http?: Server;
  private wss?: WebSocketServer;
  private room: RoomEngine;
  /** One RoomConnection per live socket — the stable key the engine tracks seats by. */
  private conns = new Map<WebSocket, RoomConnection>();

  constructor(
    private readonly host = '127.0.0.1',
    private readonly configuredPort = 8787,
    password = '',
    private readonly maxConnections = 128,
    private readonly helloTimeoutMs = 10_000,
    /**
     * Shared session storage — the SAME instance the Bot uses, so the room can
     * enrich the roster and serve card-embedded portraits from the same live
     * session state. Omitted in bot-less tests; roster then carries names only.
     */
    storage?: SessionStorage,
    /**
     * Optional billing HTTP handler (Stripe checkout/webhook/status). Injected
     * by the composition root only when hosted billing is configured; when
     * absent, `/billing/*` paths 404 like any other unknown route. The handler
     * is transport-agnostic (see `core/billing/handler.ts`) — this adapter only
     * reads the raw body and forwards it.
     */
    private readonly billing?: (req: BillingHttpRequest) => Promise<BillingHttpResponse>,
  ) {
    this.room = new RoomEngine({ storage, password, platform: 'web' });
  }

  /** The actual bound port — differs from the configured one when it was 0 (ephemeral). */
  get port(): number {
    const addr = this.http?.address();
    return addr && typeof addr === 'object' ? (addr as AddressInfo).port : this.configuredPort;
  }

  onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): void {
    this.room.setHandler(handler);
  }

  async start(): Promise<void> {
    this.http = createServer((req, res) => this.route(req, res).catch(() => res.destroy()));
    this.wss = new WebSocketServer({ server: this.http, path: '/ws', maxPayload: MAX_FRAME_BYTES });
    this.wss.on('connection', (ws) => {
      if (this.wss!.clients.size > this.maxConnections) {
        this.rawError(ws, 'Server full — try again later.');
        return ws.close();
      }
      const conn: RoomConnection = {
        send: (frame: Frame) => {
          try {
            ws.send(JSON.stringify(frame));
          } catch {
            /* a racing close — nothing to do */
          }
        },
        close: () => ws.close(),
      };
      this.conns.set(ws, conn);
      // Reap a socket that never completes hello — it is bound by no seat-level limit.
      const reaper = setTimeout(() => { if (!this.room.hasSeat(conn)) ws.terminate(); }, this.helloTimeoutMs);
      const preHello: number[] = []; // frame timestamps before a seat exists
      ws.on('message', (data) => this.onFrame(ws, conn, String(data), preHello));
      ws.on('close', () => { clearTimeout(reaper); this.room.dropConnection(conn); this.conns.delete(ws); });
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
    for (const ws of this.conns.keys()) ws.close();
    this.wss?.close();
    this.http?.closeAllConnections();
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
  }

  /** Deliver a bot narration to the room via the shared engine. */
  async send(msg: OutgoingMessage): Promise<void> {
    this.room.emit(msg);
  }

  /** One inbound frame: raw-socket defenses here, protocol semantics in the engine. */
  private onFrame(ws: WebSocket, conn: RoomConnection, raw: string, preHello: number[]): void {
    if (!this.room.hasSeat(conn)) {
      const now = Date.now();
      while (preHello.length && now - preHello[0] >= 1000) preHello.shift();
      // A pre-hello flood is answered by dropping the socket outright (terminate,
      // not a graceful close) — replying frame-for-frame would amplify it.
      if (preHello.push(now) > UNJOINED_FRAMES_PER_SEC) return ws.terminate();
    }
    let frame: InboundFrame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return conn.send({ type: 'error', error: 'Malformed frame: not JSON.' });
    }
    this.room.handleFrame(conn, frame);
  }

  /** A transport-level error frame (before any seat exists). */
  private rawError(ws: WebSocket, error: string): void {
    ws.send(JSON.stringify({ type: 'error', error }));
  }

  /** Route an HTTP request: /portrait/* endpoints, else the static client. */
  private async route(req: HttpRequest, res: ServerResponse): Promise<void> {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      return void res.writeHead(400).end(); // Node accepts request-targets WHATWG URL rejects (e.g. "//[")
    }
    if (isBillingPath(pathname)) return this.handleBilling(req, res, pathname);
    if (pathname === '/portrait' || pathname.startsWith('/portrait/')) return this.handlePortrait(req, res, pathname);
    return this.serveStatic(req, res, pathname);
  }

  /**
   * Billing endpoints (`/billing/checkout|webhook|status`). Reads the raw body
   * (webhook signature verification needs the EXACT bytes Stripe signed — never
   * re-serialize), lowercases headers, and forwards to the injected handler.
   * 404s when billing isn't configured.
   */
  private async handleBilling(req: HttpRequest, res: ServerResponse, pathname: string): Promise<void> {
    if (!this.billing) return void res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'billing not enabled' }));
    const method = req.method ?? 'GET';
    let query: Record<string, string | undefined> = {};
    try {
      query = Object.fromEntries(new URL(req.url ?? '/', 'http://x').searchParams.entries());
    } catch {
      /* leave query empty */
    }

    let rawBody = '';
    if (method === 'POST' || method === 'PUT') {
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_BILLING_BODY_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'body too large' }));
        return void req.resume();
      }
      const chunks: Buffer[] = [];
      let total = 0;
      let over = false;
      for await (const chunk of req) {
        const b = chunk as Buffer;
        total += b.length;
        if (over) continue;
        if (total > MAX_BILLING_BODY_BYTES) {
          over = true;
          chunks.length = 0;
          continue;
        }
        chunks.push(b);
      }
      if (over) return void res.writeHead(413, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'body too large' }));
      rawBody = Buffer.concat(chunks).toString('utf8');
    } else {
      req.resume();
    }

    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v;

    const result = await this.billing({ method, pathname, headers, rawBody, query });
    res.writeHead(result.status, result.headers ?? { 'Content-Type': 'application/json' }).end(result.body);
  }

  /**
   * Portrait endpoint. GET/HEAD serves a user's portrait image bytes; POST accepts
   * an image upload to set it.  /portrait/<channelId>/<userId>
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

  /**
   * Serve a user's portrait bytes. Content-type is clamped to a raster allowlist
   * (a hostile type — e.g. smuggled SVG — is served as an opaque attachment),
   * with nosniff + Content-Disposition so the bytes can't execute as an active
   * document on the app's own origin.
   */
  private async getPortrait(req: HttpRequest, res: ServerResponse, channelId: string, userId: string): Promise<void> {
    const img = await this.room.resolvePortraitImage(channelId, userId);
    let bytes: Buffer | undefined;
    if (img) {
      try {
        const b = Buffer.from(img.data, 'base64');
        if (b.length) bytes = b;
      } catch {
        /* fall through to 404 */
      }
    }
    if (!img || !bytes) return void res.writeHead(404, { 'Content-Type': 'text/plain' }).end('No portrait');
    const safe = PORTRAIT_IMAGE_TYPES.has(img.mime);
    res.writeHead(200, {
      'Content-Type': safe ? img.mime : 'application/octet-stream',
      'Content-Length': String(bytes.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': safe ? 'inline' : 'attachment; filename="portrait"',
    });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }

  /**
   * Accept a raster-image upload and store it as the caller's OWN portrait.
   * Authorization is by upload token (minted per seat at hello), not by the URL:
   * a room member who knows another seat's userId still can't overwrite it.
   */
  private async postPortrait(req: HttpRequest, res: ServerResponse, channelId: string, userId: string): Promise<void> {
    if (!this.room.seatForUpload(uploadToken(req), channelId, userId)) {
      req.resume(); // drain the body so the socket closes cleanly, then refuse
      return void res.writeHead(401, { 'Content-Type': 'text/plain' }).end('Unauthorized — upload only your own portrait, with your seat token.');
    }
    const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!PORTRAIT_IMAGE_TYPES.has(contentType)) {
      req.resume();
      return void res.writeHead(415, { 'Content-Type': 'text/plain' }).end('Content-Type must be one of: ' + [...PORTRAIT_IMAGE_TYPES].join(', '));
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_PORTRAIT_BYTES) {
      res.writeHead(413, { 'Content-Type': 'text/plain' }).end('Portrait too large');
      return void req.resume();
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
    const result = await this.room.setPortrait(channelId, userId, contentType, bytes.toString('base64'));
    if (result !== 'ok') {
      return void res.writeHead(409, { 'Content-Type': 'text/plain' }).end('Join the party first (`/dm join <name>`) to set a portrait.');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, url: portraitUrl(channelId, userId) }));
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

/** The same-origin URL a portrait is served from (components percent-encoded). */
const portraitUrl = (channelId: string, userId: string) =>
  `/portrait/${encodeURIComponent(channelId)}/${encodeURIComponent(userId)}`;

/** The upload token a POST /portrait presents (query `token` or `x-upload-token` header). */
function uploadToken(req: HttpRequest): string {
  let query = '';
  try {
    query = new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? '';
  } catch {
    query = '';
  }
  const header = req.headers['x-upload-token'];
  return (typeof header === 'string' && header) || query || '';
}

/** A path component safe to key stores/lookups: non-empty, bounded, no separators/NUL. */
const validPathId = (v: string, max: number): boolean => v.length > 0 && v.length <= max && !/[/\\\0]/.test(v);
