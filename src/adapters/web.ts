/**
 * Web adapter — the seam for browser/desktop/mobile UIs. Serves the static
 * client from web/ over plain node:http and speaks a small JSON-frame protocol
 * on a WebSocket at /ws (server side via `ws` — Node has no built-in
 * server-side WebSocket).
 *
 * Protocol:  client → { type:'hello', userName, channelId, password? }
 *                     { type:'say', text }
 *            server → { type:'welcome', userId, channelId, uploadToken }  (your seat;
 *                       uploadToken authorizes POST /portrait for THIS seat only)
 *                     { type:'roster', users }                (room membership)
 *                     { type:'msg', speaker?, text, private?: true }
 *                     { type:'roll', notation, dice, total, actor, modifier?, note? }
 *                       (one per resolved die roll, sent WITH the public 'msg')
 *                     { type:'scene', tokens:[{id,who,kind,x,y}], actor, lastRoll?, rollSeq? }
 *                       (the shared token-board — see the "Scene" section below;
 *                        rollSeq bumps per new roll so a client pops each once)
 *                     { type:'error', error }
 *            client → { type:'move', id, x, y }                  (reposition a token)
 *
 * Scene (VTT-lite): the adapter holds a per-channel token board in memory. Each
 * party member and each imported NPC gets one token { id, who, kind:'pc'|'npc',
 * x, y } with x,y as normalized 0..1 board coordinates. Tokens are auto-seeded
 * and reconciled from the session party+npcs on any roster change (joins keep
 * existing positions; departures/imports add or drop tokens). `actor` mirrors
 * the round-robin turn pointer (null in immediate mode). A resolved roll is
 * stashed in `lastRoll` so the board can pop the result near the actor's token;
 * it is authoritative and persists (the most recent roll) until a newer roll
 * replaces it — the client fades its own pop. A client 'move' is clamped to
 * 0..1 server-side and rebroadcast to everyone (including the mover), so the
 * server is the single source of truth; a malformed move gets an error frame,
 * never a crash. Moves have their own rolling-second allowance
 * (MOVE_RATE_LIMIT_PER_SEC) so frequent dragging can't exhaust the `say` limit.
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
import type { GameSession, IncomingMessage, OutgoingMessage, OutgoingRoll, PlatformAdapter, Player } from '../core/types.js';
import type { Portrait } from '../core/cards/card.js';
import type { SessionStorage } from '../core/session/storage.js';
import { MAX_BIO_CHARS } from '../core/portraits.js';

/** Max `say` frames per joined connection per rolling second; excess gets an error frame. */
export const RATE_LIMIT_PER_SEC = 5;
/** Frames tolerated per rolling second from a socket that has not completed hello; excess drops it (replying would amplify a flood). */
export const UNJOINED_FRAMES_PER_SEC = 10;
/** Token `move` frames per joined connection per rolling second — separate from (and looser than) the `say` limit, since dragging a token is naturally chatty. */
export const MOVE_RATE_LIMIT_PER_SEC = 30;
/** Hard cap on any single WebSocket frame (`ws` maxPayload — its default is 100 MB). */
export const MAX_FRAME_BYTES = 32 * 1024;
/** Server-side field caps — the client's maxlength attributes are advisory only. */
export const MAX_NAME_CHARS = 40;
export const MAX_ROOM_CHARS = 64;
export const MAX_TEXT_CHARS = 4000;
/** Upload cap for POST /portrait — portraits are small; bytes go over HTTP, never a WS frame. */
export const MAX_PORTRAIT_BYTES = 256 * 1024;
/**
 * Raster image types a portrait upload may carry AND that may be served back
 * inline. `image/svg+xml` is deliberately EXCLUDED: an SVG is an active document
 * (script/onload) and, served on the app's own origin, would be a stored XSS.
 * Anything outside this set is served as an opaque attachment, never inline.
 */
export const PORTRAIT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
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
  /**
   * Per-seat secret, minted at hello and delivered ONLY on this socket's welcome
   * frame. A portrait upload must present it, so the HTTP POST is bound to the
   * authenticated WebSocket seat: userIds are broadcast to the whole room in the
   * roster, so they can't authorize anything — the token can. It never leaves
   * the owning socket, so no room member can overwrite another's portrait.
   */
  uploadToken: string;
  saidAt: number[]; // recent `say` timestamps, for the rate limit
  movedAt: number[]; // recent `move` timestamps, for the separate move allowance
}

/** A token on the shared board. Positions are normalized 0..1 board coordinates. */
export type TokenKind = 'pc' | 'npc';
interface Token {
  id: string;
  who: string; // character/user name (pc) or NPC card name
  kind: TokenKind;
  x: number;
  y: number;
}

/** One channel's token board: the tokens (keyed by id), the current actor, and the freshest roll. */
interface Scene {
  tokens: Map<string, Token>;
  actor: string | null; // round-robin current actor's name, or null in immediate mode
  lastRoll?: OutgoingRoll; // most recent resolved roll, for a dice pop near the actor
  /**
   * Monotonic per-scene counter, bumped every time `lastRoll` is replaced. It
   * rides on the scene frame so a client can pop each NEW roll exactly once:
   * distinct rolls that happen to share actor/notation/total no longer collide,
   * and a fresh client adopts the current value as a baseline instead of popping
   * a roll that predates its arrival.
   */
  rollSeq: number;
}

export class WebAdapter implements PlatformAdapter {
  readonly name = 'web';
  private handler?: (msg: IncomingMessage) => void | Promise<void>;
  private http?: Server;
  private wss?: WebSocketServer;
  private seats = new Map<WebSocket, Seat>();
  /** In-memory shared token boards, keyed by channelId. Positions live and die with the process. */
  private scenes = new Map<string, Scene>();

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
    // Structured dice ride ALONGSIDE the narration as separate 'roll' frames so
    // the transcript still reads normally while the UI can animate real rolls.
    // Only public narration carries rolls (never a whisper); totals are the
    // engine's deterministic result, passed through verbatim (no re-rolling).
    const rollFrames =
      !msg.targetUserId && msg.rolls?.length
        ? msg.rolls.map((r) =>
            JSON.stringify({
              type: 'roll',
              notation: r.notation,
              dice: r.dice,
              total: r.total,
              actor: r.actor,
              ...(r.modifier !== undefined ? { modifier: r.modifier } : {}),
              ...(r.note ? { note: r.note } : {}),
            }),
          )
        : [];
    for (const seat of this.seats.values()) {
      if (seat.channelId !== msg.channelId) continue;
      if (msg.targetUserId && seat.userId !== msg.targetUserId) continue; // fog-of-war whisper
      seat.ws.send(frame);
      for (const rf of rollFrames) seat.ws.send(rf);
    }
    // A resolved roll on public narration pops on the board near the actor's
    // token: stash the freshest one and rebroadcast the scene. It persists
    // (authoritative) until a newer roll replaces it; the client fades the pop.
    if (!msg.targetUserId && msg.rolls?.length) {
      const scene = this.scenes.get(msg.channelId);
      if (scene) {
        scene.lastRoll = msg.rolls[msg.rolls.length - 1];
        scene.rollSeq++; // a new roll — bump so clients pop it exactly once
        this.broadcastScene(msg.channelId);
      }
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
    let frame: { type?: unknown; userName?: unknown; channelId?: unknown; password?: unknown; text?: unknown; id?: unknown; x?: unknown; y?: unknown };
    try {
      frame = JSON.parse(raw);
    } catch {
      return this.error(ws, 'Malformed frame: not JSON.');
    }
    if (frame?.type === 'hello') return this.hello(ws, frame);
    if (frame?.type === 'say') return this.say(ws, frame);
    if (frame?.type === 'move') return this.move(ws, frame);
    this.error(ws, `Unknown frame type ${JSON.stringify(frame?.type ?? null)} — expected "hello", "say", or "move".`);
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
    const seat: Seat = { ws, userId: `web-${nanoid(8)}`, userName, channelId, uploadToken: nanoid(24), saidAt: [], movedAt: [] };
    this.seats.set(ws, seat);
    ws.send(JSON.stringify({ type: 'welcome', userId: seat.userId, channelId, uploadToken: seat.uploadToken }));
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

  /**
   * Reposition a token on the shared board. Moves are authoritative: the server
   * clamps x,y to 0..1, updates its own state, and rebroadcasts the whole scene
   * to the room (the mover included). A malformed frame or an unknown token id
   * gets an error frame, never a crash. Moves have their own rolling-second
   * allowance so dragging can't starve the `say` limit.
   */
  private move(ws: WebSocket, frame: { id?: unknown; x?: unknown; y?: unknown }): void {
    const seat = this.seats.get(ws);
    if (!seat) return this.error(ws, 'Say hello first: { type:"hello", userName, channelId }.');
    const now = Date.now();
    seat.movedAt = seat.movedAt.filter((t) => now - t < 1000);
    if (seat.movedAt.length >= MOVE_RATE_LIMIT_PER_SEC)
      return this.error(ws, `Rate limit: too many moves (max ${MOVE_RATE_LIMIT_PER_SEC}/second).`);
    seat.movedAt.push(now);
    const id = typeof frame.id === 'string' ? frame.id : '';
    const x = typeof frame.x === 'number' ? frame.x : NaN;
    const y = typeof frame.y === 'number' ? frame.y : NaN;
    if (!id || !Number.isFinite(x) || !Number.isFinite(y))
      return this.error(ws, 'Malformed move: needs { id:string, x:number, y:number }.');
    const scene = this.scenes.get(seat.channelId);
    const token = scene?.tokens.get(id);
    if (!token) return this.error(ws, `Unknown token id ${JSON.stringify(id)} — move ignored.`);
    token.x = clamp01(x);
    token.y = clamp01(y);
    this.broadcastScene(seat.channelId);
  }

  /** Remove a closed socket's seat and re-announce its room's roster. */
  private dropSeat(ws: WebSocket): void {
    const seat = this.seats.get(ws);
    if (!seat) return;
    this.seats.delete(ws);
    // Reclaim the room's in-memory token board once its last member leaves —
    // otherwise a public server handing out room codes accumulates one dead
    // Scene per distinct channelId forever. Portrait bytes live in the session
    // now (evicted by `/dm end`), so nothing else is stranded here.
    if (![...this.seats.values()].some((s) => s.channelId === seat.channelId)) this.scenes.delete(seat.channelId);
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
    // The party/npcs may have changed (a join/leave/import); reconcile the token
    // board against the session and rebroadcast the scene alongside the roster.
    this.reconcileScene(channelId, session);
    this.broadcastScene(channelId);
  }

  /**
   * Reconcile a channel's token board against the session party+npcs: add a
   * token for each new member/NPC (spread out by default), drop tokens for
   * anyone who left, and KEEP the position of tokens that persist. Also caches
   * the round-robin actor so a move can rebroadcast without reloading storage.
   *
   * A pc token is keyed `pc:<userId>`, but a web reconnect re-keys the seat to a
   * fresh userId (session-manager migrates the party entry) — so the OLD token id
   * vanishes and a NEW one appears for the SAME character in a single reconcile.
   * To honor the invariant that a carefully-dragged token survives a reconnect,
   * a newly-added token inherits the position of a same-identity token that this
   * pass is dropping, instead of snapping back to the default spawn slot.
   */
  private reconcileScene(channelId: string, session: GameSession | null): Scene {
    let scene = this.scenes.get(channelId);
    if (!scene) {
      scene = { tokens: new Map(), actor: null, rollSeq: 0 };
      this.scenes.set(channelId, scene);
    }
    const desired = sceneTokens(session);
    const wanted = new Set(desired.map((d) => d.id));
    // Drop departed tokens, but remember where each one sat keyed by character
    // identity (kind + name), so a re-keyed seat can reclaim its exact position.
    const vacated = new Map<string, { x: number; y: number }>();
    for (const [id, t] of [...scene.tokens]) {
      if (!wanted.has(id)) {
        vacated.set(identityKey(t.kind, t.who), { x: t.x, y: t.y });
        scene.tokens.delete(id);
      }
    }
    for (const d of desired) {
      const existing = scene.tokens.get(d.id);
      if (existing) {
        existing.who = d.who; // a rename keeps the token's slot and position
        existing.kind = d.kind;
      } else {
        const inherited = vacated.get(identityKey(d.kind, d.who)); // a reconnect re-key keeps its spot
        scene.tokens.set(d.id, { id: d.id, who: d.who, kind: d.kind, ...(inherited ?? spawnPos(d.kind, scene.tokens)) });
      }
    }
    scene.actor = actorName(session);
    return scene;
  }

  /** Broadcast a channel's current token board to everyone in the room. */
  private broadcastScene(channelId: string): void {
    const scene = this.scenes.get(channelId);
    if (!scene) return;
    const inRoom = [...this.seats.values()].filter((s) => s.channelId === channelId);
    if (!inRoom.length) return;
    const frame = JSON.stringify({
      type: 'scene',
      tokens: [...scene.tokens.values()].map((t) => ({ id: t.id, who: t.who, kind: t.kind, x: t.x, y: t.y })),
      actor: scene.actor,
      ...(scene.lastRoll ? { lastRoll: scene.lastRoll, rollSeq: scene.rollSeq } : {}),
    });
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
      // Class + bio ride on the seat (bounded), so the client can show a
      // character's identity without an imported card. Never image bytes.
      //
      // Bio rides at its FULL stored length (MAX_BIO_CHARS), not the tighter
      // card-summary clamp: the creator pre-fills its editable textarea from this
      // value, so clamping here would round-trip a truncated+ellipsised bio back
      // through `/dm bio` on the next save and silently overwrite the real one.
      // The bio is already bounded server-side (bot.ts) and is tiny next to the
      // frame cap. The card DESCRIPTION below stays clamped — it is display-only.
      ...(player?.class ? { class: player.class } : {}),
      ...(player?.bio ? { bio: clampText(player.bio, MAX_BIO_CHARS) } : {}),
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

  /**
   * The portrait descriptor for the roster: the player's effective portrait — a
   * preset id, or an image (upload OR embedded card art) referenced by its
   * /portrait URL. Uploads now live on the Player in the session (so they survive
   * a seat re-claim and are evicted with the campaign), never in a side map.
   */
  private portraitDescriptor(
    channelId: string,
    userId: string,
    player: Player | undefined,
  ): { kind: 'preset'; id: string } | { kind: 'image'; url: string } | null {
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

  /**
   * Serve a user's portrait bytes. The content-type is clamped to a raster
   * allowlist (an unknown/hostile type — e.g. a card that smuggled SVG — is
   * served as an opaque attachment, never an inline document), and
   * `nosniff` + `Content-Disposition` stop the browser from re-interpreting the
   * bytes as an active document on the app's own origin. This endpoint is the
   * one place attacker-supplied bytes are echoed back, so it must never let them
   * execute as script.
   */
  private async getPortrait(req: HttpRequest, res: ServerResponse, channelId: string, userId: string): Promise<void> {
    const img = await this.resolvePortrait(channelId, userId);
    if (!img) return void res.writeHead(404, { 'Content-Type': 'text/plain' }).end('No portrait');
    const safe = PORTRAIT_IMAGE_TYPES.has(img.mime);
    res.writeHead(200, {
      'Content-Type': safe ? img.mime : 'application/octet-stream',
      'Content-Length': String(img.bytes.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': safe ? 'inline' : 'attachment; filename="portrait"',
    });
    res.end(req.method === 'HEAD' ? undefined : img.bytes);
  }

  /** The player's stored portrait image bytes (an upload or embedded card art), else null. */
  private async resolvePortrait(channelId: string, userId: string): Promise<{ mime: string; bytes: Buffer } | null> {
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

  /**
   * Accept a raster-image upload and store it as the caller's OWN portrait.
   *
   * Authorization is by upload token, not by the URL: the token is minted per
   * seat at hello and delivered only on that socket, so the request is bound to
   * an authenticated WebSocket seat that must own the target userId. A room
   * member who knows another seat's userId (they all do — it's in the roster)
   * still can't overwrite that seat's portrait. The bytes land on the Player in
   * the shared session, so there is no unbounded side map to exhaust: it's one
   * portrait per seated player, capped in size, and evicted with the campaign.
   */
  private async postPortrait(req: HttpRequest, res: ServerResponse, channelId: string, userId: string): Promise<void> {
    const seat = this.seatForUpload(req, channelId, userId);
    if (!seat) {
      // Drain the body so the socket closes cleanly, then refuse. 401: bad/absent
      // token; the caller must upload to its own seat with its own token.
      req.resume();
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
    // Store on the Player in the session. Requires a seated player: this both
    // gives the bytes a bounded, evictable home and keeps a spectator from
    // planting art on a userId with no game presence.
    const session = (await this.storage?.load(sessionKey(channelId)).catch(() => null)) ?? null;
    const player = session?.players?.[userId];
    if (!session || !player) {
      return void res.writeHead(409, { 'Content-Type': 'text/plain' }).end('Join the party first (`/dm join <name>`) to set a portrait.');
    }
    player.portrait = { kind: 'image', mime: contentType, data: bytes.toString('base64') };
    await this.storage!.save(sessionKey(channelId), session);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, url: portraitUrl(channelId, userId) }));
    void this.broadcastRoster(channelId); // clients pick up the new portrait
  }

  /**
   * The seat authorized to write `userId`'s portrait in `channelId`: the one
   * whose upload token matches (query `token` or `x-upload-token` header) AND
   * which owns that userId in that room. Returns undefined otherwise — a token
   * only ever authorizes its own seat's portrait.
   */
  private seatForUpload(req: HttpRequest, channelId: string, userId: string): Seat | undefined {
    let query = '';
    try {
      query = new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? '';
    } catch {
      query = '';
    }
    const header = req.headers['x-upload-token'];
    const token = (typeof header === 'string' && header) || query || '';
    if (!token) return undefined;
    for (const seat of this.seats.values()) {
      if (seat.uploadToken === token) {
        return seat.channelId === channelId && seat.userId === userId ? seat : undefined;
      }
    }
    return undefined;
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

/** The same-origin URL a portrait is served from (components percent-encoded). */
const portraitUrl = (channelId: string, userId: string) =>
  `/portrait/${encodeURIComponent(channelId)}/${encodeURIComponent(userId)}`;

/** A player's live portrait: their own overrides the imported card's. */
const effectivePortrait = (player: Player): Portrait | undefined => player.portrait ?? player.card?.portrait;

/** A path component safe to key stores/lookups: non-empty, bounded, no separators/NUL. */
const validPathId = (v: string, max: number): boolean => v.length > 0 && v.length <= max && !/[/\\\0]/.test(v);

/** Clamp a board coordinate into the normalized 0..1 range. */
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** A token's character identity (kind + case-folded name) — stable across a seat re-key. */
const identityKey = (kind: TokenKind, who: string): string => `${kind}:${who.toLowerCase()}`;

/**
 * The token set a session implies: one per seated player (id `pc:<userId>`) and
 * one per imported NPC card (id `npc:<name>`, `#n`-suffixed on a name clash).
 * Stable ids let positions survive across reconciliations.
 */
function sceneTokens(session: GameSession | null): { id: string; who: string; kind: TokenKind }[] {
  if (!session) return [];
  const out: { id: string; who: string; kind: TokenKind }[] = [];
  for (const [userId, p] of Object.entries(session.players ?? {})) {
    out.push({ id: `pc:${userId}`, who: p.characterName || p.userName, kind: 'pc' });
  }
  const seen = new Map<string, number>();
  for (const npc of session.npcs ?? []) {
    const base = (npc?.name || 'NPC').trim() || 'NPC';
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push({ id: n === 0 ? `npc:${base}` : `npc:${base}#${n}`, who: base, kind: 'npc' });
  }
  return out;
}

/**
 * A spread-out default position for a NEW token: PCs cluster near the bottom of
 * the board, NPCs near the top, each laid out along a row that wraps every six.
 * Existing tokens keep their own positions — this is only for first placement.
 */
function spawnPos(kind: TokenKind, existing: Map<string, Token>): { x: number; y: number } {
  let same = 0;
  for (const t of existing.values()) if (t.kind === kind) same++;
  const perRow = 4;
  const col = same % perRow;
  const row = Math.floor(same / perRow);
  // Spread across the width with generous clearance so neither the token discs
  // nor their name labels collide; PCs on the lower half, NPCs on the upper.
  const x = clamp01(0.16 + col * 0.24);
  const y = kind === 'pc' ? clamp01(0.64 - row * 0.18) : clamp01(0.26 + row * 0.18);
  return { x, y };
}

/** The round-robin current actor's name, or null in immediate mode / an empty party. */
function actorName(session: GameSession | null): string | null {
  if (!session || session.turnMode !== 'round-robin') return null;
  const order = Object.values(session.players ?? {});
  if (!order.length) return null;
  const p = order[session.turnIndex % order.length];
  return p.characterName || p.userName;
}

/** Clip untrusted card text so an enriched roster frame stays small. */
const clampText = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
