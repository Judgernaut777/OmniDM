/**
 * RoomEngine — the transport-agnostic heart of the multiplayer "table".
 *
 * All the room/protocol SEMANTICS that used to live inside the Node web adapter
 * live here now, with NO node:http/ws/fs and no Buffer: seat/roster management,
 * the hello/say/move frame protocol, roster enrichment (character, portrait
 * descriptor, class/bio, card summary), the shared token-board scene
 * (reconciliation, spawn layout, round-robin actor, dice pop), roll framing, and
 * fog-of-war routing. It drives a Bot's message handler and reads sessions from a
 * SessionStorage, emitting protocol FRAMES to connections through a tiny
 * {@link RoomConnection} seam.
 *
 * This is the single implementation of the protocol both transports reuse:
 *   - src/adapters/web.ts wraps it in an HTTP + WebSocket server (Node), and
 *   - the in-app LocalTransport (next feature) wraps the SAME engine in-process.
 * So there is exactly one place the room rules are defined.
 *
 * Portrait BYTES (upload/serve) are inherently transport-specific (HTTP), so the
 * engine only computes descriptors + resolves the stored image as {mime,base64};
 * the transport turns that into wire bytes.
 */
import { nanoid } from 'nanoid';
import type { GameSession, IncomingMessage, OutgoingMessage, OutgoingRoll, Player } from '../types.js';
import type { Portrait } from '../cards/card-parse.js';
import type { SessionStorage } from '../session/storage.js';
import { MAX_BIO_CHARS } from '../portraits.js';

// ─── Protocol constants (shared by every transport) ──────────────────────────

/** Max `say` frames per joined connection per rolling second; excess gets an error frame. */
export const RATE_LIMIT_PER_SEC = 5;
/** Token `move` frames per joined connection per rolling second — looser than `say` (dragging is chatty). */
export const MOVE_RATE_LIMIT_PER_SEC = 30;
/** Server-side field caps — a client's maxlength attributes are advisory only over a raw socket. */
export const MAX_NAME_CHARS = 40;
export const MAX_ROOM_CHARS = 64;
/** Bound on the client-supplied seat-ownership token (a ~24-char nanoid). */
export const MAX_RESUME_TOKEN_CHARS = 64;
export const MAX_TEXT_CHARS = 4000;
/** Web userIds are `web-<nanoid>` (~12 chars); bound the path component anyway. */
export const MAX_USER_CHARS = 128;
/** Per-seat card summary length in the enriched roster — keep the frame well under the cap. */
export const MAX_CARD_SUMMARY_CHARS = 240;

// ─── Wire + transport types ──────────────────────────────────────────────────

/** A JSON protocol frame. */
export type Frame = { type: string; [k: string]: unknown };

/** One transport connection: how the engine pushes frames to a client and drops it. */
export interface RoomConnection {
  /** Deliver one frame to this connection. The transport serializes it. */
  send(frame: Frame): void;
  /** Drop this connection (e.g. after a failed password). */
  close(): void;
}

/** A parsed inbound frame — fields are `unknown` until validated. */
export interface InboundFrame {
  type?: unknown;
  userName?: unknown;
  channelId?: unknown;
  password?: unknown;
  resumeToken?: unknown;
  text?: unknown;
  id?: unknown;
  x?: unknown;
  y?: unknown;
}

export interface RoomEngineOptions {
  /** Shared session storage — the SAME instance the Bot uses (enriched roster, portraits). */
  storage?: SessionStorage;
  /** Optional shared room password checked at hello; '' = open. */
  password?: string;
  /** Platform label for storage keys + dispatched messages. Defaults to 'web'. */
  platform?: string;
  /** How the roster references an image portrait. Defaults to the web `/portrait/…` path. */
  portraitUrl?: (channelId: string, userId: string) => string;
}

/** The result of accepting a portrait upload into the session. */
export type SetPortraitResult = 'ok' | 'no-session' | 'no-player';

/** One joined seat: a connection that completed the hello handshake. */
interface Seat {
  conn: RoomConnection;
  userId: string;
  userName: string;
  channelId: string;
  /** Per-seat secret minted at hello, delivered only on this connection's welcome. */
  uploadToken: string;
  /**
   * The client-supplied ownership token (from the `hello` frame), forwarded on
   * every message so the session manager can authorize a seat re-claim by name
   * across a reconnect. Never rebroadcast to other seats — it stays secret.
   */
  resumeToken?: string;
  saidAt: number[]; // recent `say` timestamps, for the rate limit
  movedAt: number[]; // recent `move` timestamps, for the separate move allowance
}

/** A token on the shared board. Positions are normalized 0..1 board coordinates. */
export type TokenKind = 'pc' | 'npc';
interface Token {
  id: string;
  who: string;
  kind: TokenKind;
  x: number;
  y: number;
}

/** One channel's token board. */
interface Scene {
  tokens: Map<string, Token>;
  actor: string | null;
  lastRoll?: OutgoingRoll;
  rollSeq: number;
}

export class RoomEngine {
  private seats = new Map<RoomConnection, Seat>();
  private scenes = new Map<string, Scene>();
  private handler?: (msg: IncomingMessage) => void | Promise<void>;
  private readonly storage?: SessionStorage;
  private readonly password: string;
  private readonly platform: string;
  private readonly portraitUrl: (channelId: string, userId: string) => string;

  constructor(opts: RoomEngineOptions = {}) {
    this.storage = opts.storage;
    this.password = opts.password ?? '';
    this.platform = opts.platform ?? 'web';
    this.portraitUrl = opts.portraitUrl ?? defaultPortraitUrl;
  }

  /** Register the bot message handler that `say` dispatches to. */
  setHandler(handler: (msg: IncomingMessage) => void | Promise<void>): void {
    this.handler = handler;
  }

  /** Storage key for one channel — mirrors SessionManager's `${platform}:${channelId}`. */
  sessionKey(channelId: string): string {
    return `${this.platform}:${channelId}`;
  }

  /** True once a connection has completed hello (has a seat). */
  hasSeat(conn: RoomConnection): boolean {
    return this.seats.has(conn);
  }

  // ── Inbound frame dispatch ─────────────────────────────────────────────────

  /** Route one already-parsed inbound frame. Every failure answers with an error frame. */
  handleFrame(conn: RoomConnection, frame: InboundFrame): void {
    if (frame?.type === 'hello') return this.hello(conn, frame);
    if (frame?.type === 'say') return this.say(conn, frame);
    if (frame?.type === 'move') return this.move(conn, frame);
    this.error(conn, `Unknown frame type ${JSON.stringify(frame?.type ?? null)} — expected "hello", "say", or "move".`);
  }

  /** Join a room: check the password, assign a userId, announce the roster. */
  private hello(conn: RoomConnection, frame: InboundFrame): void {
    if (this.password && frame.password !== this.password) {
      this.error(conn, 'Wrong or missing password.');
      return conn.close();
    }
    const userName = typeof frame.userName === 'string' ? frame.userName.trim() : '';
    const channelId = typeof frame.channelId === 'string' ? frame.channelId.trim() : '';
    if (!userName || !channelId) return this.error(conn, 'hello needs a non-empty userName and channelId.');
    if (userName.length > MAX_NAME_CHARS || channelId.length > MAX_ROOM_CHARS)
      return this.error(conn, `hello fields too long (userName ≤ ${MAX_NAME_CHARS}, channelId ≤ ${MAX_ROOM_CHARS} chars).`);
    if (this.seats.has(conn)) return this.error(conn, 'Already joined — one hello per connection.');
    // Ownership token for seat re-claims across reconnects — client-owned secret,
    // never echoed back or rebroadcast. Bounded like every other hello field.
    const resumeToken = typeof frame.resumeToken === 'string' && frame.resumeToken
      ? frame.resumeToken.slice(0, MAX_RESUME_TOKEN_CHARS)
      : undefined;
    const seat: Seat = { conn, userId: `web-${nanoid(8)}`, userName, channelId, uploadToken: nanoid(24), resumeToken, saidAt: [], movedAt: [] };
    this.seats.set(conn, seat);
    conn.send({ type: 'welcome', userId: seat.userId, channelId, uploadToken: seat.uploadToken });
    void this.broadcastRoster(channelId);
  }

  /** A chat line: rate-limit, relay to the room, hand to the bot core. */
  private say(conn: RoomConnection, frame: InboundFrame): void {
    const seat = this.seats.get(conn);
    if (!seat) return this.error(conn, 'Say hello first: { type:"hello", userName, channelId }.');
    const text = typeof frame.text === 'string' ? frame.text.trim() : '';
    if (!text) return this.error(conn, 'say needs a non-empty text.');
    if (text.length > MAX_TEXT_CHARS) return this.error(conn, `say text too long (max ${MAX_TEXT_CHARS} chars).`);
    const now = Date.now();
    seat.saidAt = seat.saidAt.filter((t) => now - t < 1000);
    if (seat.saidAt.length >= RATE_LIMIT_PER_SEC) return this.error(conn, 'Rate limit: slow down (5 messages/second).');
    seat.saidAt.push(now);
    // Relay the player's line to the room, then dispatch it to the engine. A
    // handler rejection must not kill the transport.
    const relay: Frame = { type: 'msg', speaker: seat.userName, text };
    for (const s of this.seats.values()) if (s.channelId === seat.channelId) s.conn.send(relay);
    Promise.resolve(
      this.handler?.({ platform: this.platform, channelId: seat.channelId, userId: seat.userId, userName: seat.userName, text, resumeToken: seat.resumeToken }),
    )
      .catch((err) => console.error('[room] message handling failed:', (err as Error)?.message ?? err))
      // The line may have changed character/portrait/persona state; refresh the roster.
      .finally(() => void this.broadcastRoster(seat.channelId));
  }

  /** Reposition a token on the shared board — authoritative: clamp + rebroadcast. */
  private move(conn: RoomConnection, frame: InboundFrame): void {
    const seat = this.seats.get(conn);
    if (!seat) return this.error(conn, 'Say hello first: { type:"hello", userName, channelId }.');
    const now = Date.now();
    seat.movedAt = seat.movedAt.filter((t) => now - t < 1000);
    if (seat.movedAt.length >= MOVE_RATE_LIMIT_PER_SEC)
      return this.error(conn, `Rate limit: too many moves (max ${MOVE_RATE_LIMIT_PER_SEC}/second).`);
    seat.movedAt.push(now);
    const id = typeof frame.id === 'string' ? frame.id : '';
    const x = typeof frame.x === 'number' ? frame.x : NaN;
    const y = typeof frame.y === 'number' ? frame.y : NaN;
    if (!id || !Number.isFinite(x) || !Number.isFinite(y))
      return this.error(conn, 'Malformed move: needs { id:string, x:number, y:number }.');
    const scene = this.scenes.get(seat.channelId);
    const token = scene?.tokens.get(id);
    if (!token) return this.error(conn, `Unknown token id ${JSON.stringify(id)} — move ignored.`);
    token.x = clamp01(x);
    token.y = clamp01(y);
    this.broadcastScene(seat.channelId);
  }

  /** Remove a dropped connection's seat and re-announce its room's roster. */
  dropConnection(conn: RoomConnection): void {
    const seat = this.seats.get(conn);
    if (!seat) return;
    this.seats.delete(conn);
    // Reclaim the room's in-memory token board once its last member leaves.
    if (![...this.seats.values()].some((s) => s.channelId === seat.channelId)) this.scenes.delete(seat.channelId);
    void this.broadcastRoster(seat.channelId);
  }

  private error(conn: RoomConnection, error: string): void {
    conn.send({ type: 'error', error });
  }

  // ── Outbound (bot narration → room) ────────────────────────────────────────

  /**
   * Deliver a bot OutgoingMessage to the room: the narration frame, plus separate
   * `roll` frames for any resolved dice (public only), and a scene pop on the
   * board. Fog whispers (`targetUserId`) go only to that user's seats.
   */
  emit(msg: OutgoingMessage): void {
    const frame: Frame = {
      type: 'msg',
      speaker: msg.speaker,
      text: msg.text,
      ...(msg.targetUserId ? { private: true } : {}),
    };
    const rollFrames: Frame[] =
      !msg.targetUserId && msg.rolls?.length
        ? msg.rolls.map((r) => ({
            type: 'roll',
            notation: r.notation,
            dice: r.dice,
            total: r.total,
            actor: r.actor,
            ...(r.modifier !== undefined ? { modifier: r.modifier } : {}),
            ...(r.note ? { note: r.note } : {}),
          }))
        : [];
    for (const seat of this.seats.values()) {
      if (seat.channelId !== msg.channelId) continue;
      if (msg.targetUserId && seat.userId !== msg.targetUserId) continue; // fog-of-war whisper
      seat.conn.send(frame);
      for (const rf of rollFrames) seat.conn.send(rf);
    }
    // A resolved roll on public narration pops on the board near the actor's token.
    if (!msg.targetUserId && msg.rolls?.length) {
      const scene = this.scenes.get(msg.channelId);
      if (scene) {
        scene.lastRoll = msg.rolls[msg.rolls.length - 1];
        scene.rollSeq++;
        this.broadcastScene(msg.channelId);
      }
    }
  }

  // ── Roster + scene ─────────────────────────────────────────────────────────

  /** Announce a room's membership, enriched from the shared session. */
  async broadcastRoster(channelId: string): Promise<void> {
    const inRoom = [...this.seats.values()].filter((s) => s.channelId === channelId);
    if (!inRoom.length) return;
    const session = (await this.storage?.load(this.sessionKey(channelId)).catch(() => null)) ?? null;
    const users = inRoom.map((s) => this.describeSeat(s, session));
    const frame: Frame = { type: 'roster', users };
    for (const s of inRoom) s.conn.send(frame);
    // Party/npcs may have changed; reconcile + rebroadcast the token board.
    this.reconcileScene(channelId, session);
    this.broadcastScene(channelId);
  }

  /** Reconcile a channel's token board against the session party+npcs. */
  private reconcileScene(channelId: string, session: GameSession | null): Scene {
    let scene = this.scenes.get(channelId);
    if (!scene) {
      scene = { tokens: new Map(), actor: null, rollSeq: 0 };
      this.scenes.set(channelId, scene);
    }
    const desired = sceneTokens(session);
    const wanted = new Set(desired.map((d) => d.id));
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
    const frame: Frame = {
      type: 'scene',
      tokens: [...scene.tokens.values()].map((t) => ({ id: t.id, who: t.who, kind: t.kind, x: t.x, y: t.y })),
      actor: scene.actor,
      ...(scene.lastRoll ? { lastRoll: scene.lastRoll, rollSeq: scene.rollSeq } : {}),
    };
    for (const s of inRoom) s.conn.send(frame);
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
      // Mechanical state the ENGINE owns — surfaced so the roster shows a real,
      // damage/heal-marker-driven number, not just a static character sheet stat.
      ...(player?.hp !== undefined ? { hp: player.hp } : {}),
      ...(player?.maxHp !== undefined ? { maxHp: player.maxHp } : {}),
      ...(player?.conditions?.length ? { conditions: player.conditions } : {}),
      ...(player?.class ? { class: player.class } : {}),
      // Bio rides at FULL stored length (the creator round-trips it); the card
      // DESCRIPTION below stays clamped since it is display-only.
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

  /** The portrait descriptor for the roster: a preset id, or an image by URL, or null. */
  private portraitDescriptor(
    channelId: string,
    userId: string,
    player: Player | undefined,
  ): { kind: 'preset'; id: string } | { kind: 'image'; url: string } | null {
    const p = player ? effectivePortrait(player) : undefined;
    if (p?.kind === 'preset') return { kind: 'preset', id: p.id };
    if (p?.kind === 'image') return { kind: 'image', url: this.portraitUrl(channelId, userId) };
    return null;
  }

  // ── Portrait bytes (transport serves them; engine owns the session read/write) ──

  /** The seat authorized to write `userId`'s portrait in `channelId` by upload token. */
  seatForUpload(token: string, channelId: string, userId: string): boolean {
    if (!token) return false;
    for (const seat of this.seats.values()) {
      if (seat.uploadToken === token) return seat.channelId === channelId && seat.userId === userId;
    }
    return false;
  }

  /** The player's stored portrait image (upload or embedded card art) as {mime, base64}, else null. */
  async resolvePortraitImage(channelId: string, userId: string): Promise<{ mime: string; data: string } | null> {
    const session = (await this.storage?.load(this.sessionKey(channelId)).catch(() => null)) ?? null;
    const player = session?.players?.[userId];
    const p = player && effectivePortrait(player);
    if (p?.kind === 'image' && p.data) return { mime: p.mime || 'application/octet-stream', data: p.data };
    return null;
  }

  /** Store an uploaded image as `userId`'s portrait in the session; re-announce the roster. */
  async setPortrait(channelId: string, userId: string, mime: string, base64: string): Promise<SetPortraitResult> {
    const session = (await this.storage?.load(this.sessionKey(channelId)).catch(() => null)) ?? null;
    if (!session) return 'no-session';
    const player = session.players?.[userId];
    if (!player) return 'no-player';
    player.portrait = { kind: 'image', mime, data: base64 };
    await this.storage!.save(this.sessionKey(channelId), session);
    void this.broadcastRoster(channelId);
    return 'ok';
  }
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** The web transport's portrait URL scheme (components percent-encoded). */
const defaultPortraitUrl = (channelId: string, userId: string) =>
  `/portrait/${encodeURIComponent(channelId)}/${encodeURIComponent(userId)}`;

/** A player's live portrait: their own overrides the imported card's. */
const effectivePortrait = (player: Player): Portrait | undefined => player.portrait ?? player.card?.portrait;

/** Clamp a board coordinate into the normalized 0..1 range. */
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** A token's character identity (kind + case-folded name) — stable across a seat re-key. */
const identityKey = (kind: TokenKind, who: string): string => `${kind}:${who.toLowerCase()}`;

/** Clip untrusted text so an enriched roster frame stays small. */
const clampText = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The token set a session implies: one per seated player, one per imported NPC card. */
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

/** A spread-out default position for a NEW token. Existing tokens keep their own. */
function spawnPos(kind: TokenKind, existing: Map<string, Token>): { x: number; y: number } {
  let same = 0;
  for (const t of existing.values()) if (t.kind === kind) same++;
  const perRow = 4;
  const col = same % perRow;
  const row = Math.floor(same / perRow);
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
