/**
 * Session manager — maps a platform channel to a game session and tracks the
 * party. This is half of the genuinely-novel layer (the other half is the
 * platform adapters): tying multi-user chat rooms to shared game state.
 */
import { nanoid } from 'nanoid';
import type { GameSession, IncomingMessage, LLMProvider, Player } from '../types.js';
import type { SessionStorage } from './storage.js';

/**
 * Server-side cap on a stored character name. The web client's input maxlength
 * (40) is advisory only — a raw socket can send `/dm join ` + arbitrary text —
 * and the name is echoed into every roster broadcast, each seat label, and the
 * DM system prompt's party roster, so an unbounded name is prompt/resource bloat
 * on every turn. Mirrors the adapter's hello userName cap.
 */
export const MAX_CHARACTER_NAME_CHARS = 40;

/** Upper bound on a stored ownership token (client sends an ~24-char nanoid). */
export const MAX_RESUME_TOKEN_CHARS = 64;

/**
 * Thrown by {@link SessionManager.join} when a fresh identity tries to take a
 * character name that is already held by another seat without presenting that
 * seat's ownership token. The adapter/bot turns this into a friendly refusal
 * instead of silently migrating the seat (which was a seat-hijack + fog-whisper
 * interception vector).
 */
export class SeatTakenError extends Error {
  constructor(public readonly characterName: string) {
    super(`Character "${characterName}" is already claimed by another player.`);
    this.name = 'SeatTakenError';
  }
}

export class SessionManager {
  /**
   * Anti-resurrection tombstone: channel keys `/dm end` has deleted. A turn
   * that was already in flight (holding the session object) when `/dm end`
   * ran would otherwise call `save()` afterward and re-create the file/cache
   * entry the delete just removed — resurrecting a campaign the owner ended.
   * `save()` refuses to write for any key in this set; `create()` clears the
   * key first, so a fresh `/dm new` in the same channel is unaffected.
   */
  private ended = new Set<string>();

  constructor(
    private store: SessionStorage,
    private defaultModel: string,
    private provider?: LLMProvider,
  ) {}

  /** Stable key for a channel across restarts. */
  key(msg: { platform: string; channelId: string }): string {
    return `${msg.platform}:${msg.channelId}`;
  }

  async get(msg: IncomingMessage): Promise<GameSession | null> {
    const session = await this.store.load(this.key(msg));
    if (session) {
      // Migration: a session pinned to a model the active provider can't serve
      // (e.g. an OpenRouter id after switching to LLM_PROVIDER=anthropic) would
      // 404 on every action — remap it to a servable default instead.
      const resolved = this.resolveModel(session.model);
      if (resolved !== session.model) {
        console.warn(`[session] model '${session.model}' is not servable by provider '${this.provider?.id}' — falling back to '${resolved}'`);
        session.model = resolved;
      }
      // Migration: a session created before `ownerId` existed has no recorded
      // campaign owner. Adopt the first joined player (join order) as a
      // stand-in GM-authority holder — lazy, persists on the session's next
      // save(). Only applies when there IS a player to adopt; an empty,
      // ownerless legacy session stays ownerless until someone joins.
      if (!session.ownerId && Object.keys(session.players).length > 0) {
        session.ownerId = Object.keys(session.players)[0];
      }
    }
    return session;
  }

  /** Reload a session straight from storage for a platform/channel — bypasses
   * any caller-held (possibly stale) reference, e.g. to re-check the current
   * truth after a concurrent `/dm end`. Unlike `get()`, this does not run the
   * model/ownerId migrations (no `IncomingMessage` to derive them from). */
  async reload(platform: string, channelId: string): Promise<GameSession | null> {
    return this.store.load(this.key({ platform, channelId }));
  }

  /**
   * Whether `userId` holds GM authority over `session`. Prefers the recorded
   * `ownerId` (set at creation, transferable via `/dm gm`); falls back to the
   * first joined player for a legacy session that predates `ownerId` and
   * hasn't been reloaded through `get()` (which would have migrated it).
   */
  isOwner(session: GameSession, userId: string): boolean {
    if (session.ownerId) return session.ownerId === userId;
    const first = Object.keys(session.players)[0];
    return first ? first === userId : false;
  }

  /** A model id the active provider can serve; providers without a `supportsModel` accept anything. */
  resolveModel(model: string): string {
    const p = this.provider;
    if (!p?.supportsModel || p.supportsModel(model)) return model;
    if (p.supportsModel(this.defaultModel)) return this.defaultModel;
    return p.defaultModel ?? this.defaultModel;
  }

  async create(msg: IncomingMessage, systemId = 'dnd5e'): Promise<GameSession> {
    const session: GameSession = {
      id: nanoid(10),
      platform: msg.platform,
      channelId: msg.channelId,
      systemId,
      model: this.resolveModel(this.defaultModel),
      players: {},
      npcs: [],
      lorebook: [],
      history: [],
      summary: '',
      memories: [],
      turnMode: 'immediate',
      turnIndex: 0,
      fogOfWar: false,
      createdAt: Date.now(),
      ownerId: msg.userId, // the creator holds GM authority until transferred (`/dm gm`)
    };
    // A fresh `/dm new` in a channel that was previously `/dm end`ed is the
    // legitimate "start over" path, not a stale in-flight turn racing the
    // delete — clear the tombstone first so this save() (and every later one
    // for this channel) isn't refused by the anti-resurrection guard below.
    this.ended.delete(this.key(msg));
    await this.store.save(this.key(msg), session);
    return session;
  }

  async save(session: GameSession): Promise<void> {
    const key = `${session.platform}:${session.channelId}`;
    if (this.ended.has(key)) {
      // A turn/command that was already holding this session object when
      // `/dm end` ran is trying to write it back out — refuse, or the delete
      // above would be silently undone (a resurrected "ended" campaign).
      console.warn('[session] refusing to resurrect ended campaign', key);
      return;
    }
    await this.store.save(key, session);
  }

  /** End the campaign in a channel — must go through the shared store so its live cache is evicted too. */
  async end(msg: { platform: string; channelId: string }): Promise<void> {
    const key = this.key(msg);
    this.ended.add(key);
    await this.store.delete(key);
  }

  /**
   * Add or update a player in the party. A join from a userId NOT yet in the
   * party whose character name matches an existing member is a seat RE-CLAIM
   * (the web adapter mints a fresh userId per connection, so a reconnect +
   * `/dm join <name>` would otherwise leave a ghost entry that deadlocks
   * round-robin and swallows fog whispers): the old entry migrates to the new
   * userId in its original join-order slot, keeping hp/card and the turn
   * pointer intact.
   *
   * SECURITY: a reclaim is authorized ONLY when the joining client presents the
   * same `resumeToken` the seat was created with. Without it — a stranger simply
   * naming someone else's character — the join is refused with {@link
   * SeatTakenError} rather than migrating the seat, which previously let any
   * room member seize a character and intercept its private fog whispers. A
   * member already in the party (matched by userId) updates their own seat and
   * never consults reclaim-by-name, so renaming never takes another seat.
   */
  async join(session: GameSession, msg: IncomingMessage, characterName?: string): Promise<Player> {
    // Clamp the incoming name before it is stored, matched for a seat re-claim,
    // or echoed anywhere — the client maxlength is not enforceable over a raw socket.
    const name = characterName === undefined ? undefined : characterName.slice(0, MAX_CHARACTER_NAME_CHARS);
    const token = typeof msg.resumeToken === 'string' && msg.resumeToken
      ? msg.resumeToken.slice(0, MAX_RESUME_TOKEN_CHARS)
      : undefined;

    // Same identity (stable-id adapter, or a rename on the same connection):
    // update in place. This branch never reclaims by name.
    let prior: Player | undefined = session.players[msg.userId];
    if (!prior && name) {
      const named = this.reclaimable(session, name);
      if (named) {
        // The name is held by another seat. Authorize the takeover only with a
        // matching, non-empty ownership token; otherwise refuse.
        if (token && named.resumeToken && token === named.resumeToken) {
          prior = named;
        } else {
          throw new SeatTakenError(named.characterName || named.userName || name);
        }
      }
    }

    const player: Player = {
      userId: msg.userId,
      userName: msg.userName,
      characterName: name ?? prior?.characterName,
      hp: prior?.hp ?? 10,
      maxHp: prior?.maxHp ?? 10,
      // Class + bio are part of the character identity — carry them across a
      // seat re-claim (a reconnect mints a fresh userId), like the portrait.
      class: prior?.class,
      bio: prior?.bio,
      initiativeMod: prior?.initiativeMod,
      ac: prior?.ac,
      attack: prior?.attack,
      card: prior?.card,
      // A seat re-claim (new userId, same character) must carry the portrait
      // across too — a preset OR uploaded image lives on the Player, and the web
      // adapter mints a fresh userId per reconnect. Dropping it here reverts the
      // portrait to the default crest and strands the uploaded bytes.
      portrait: prior?.portrait,
      // Preserve the seat's ownership secret across a reclaim; establish it from
      // the joining client's token on a brand-new seat. Stable-id adapters send
      // no token, so their seats stay non-reclaimable-by-name (undefined token
      // never satisfies the match above) — correct, they reconnect by userId.
      resumeToken: prior?.resumeToken ?? token,
    };
    if (prior && prior.userId !== msg.userId) {
      // Re-key the migrated seat in place — join order (and with it the
      // round-robin pointer) must not shift.
      session.players = Object.fromEntries(
        Object.entries(session.players).map(([k, p]): [string, Player] => (p === prior ? [msg.userId, player] : [k, p])),
      );
    } else {
      session.players[msg.userId] = player;
    }
    await this.save(session);
    return player;
  }

  /** The party member a fresh userId may re-claim by character name, if any. */
  private reclaimable(session: GameSession, characterName: string): Player | undefined {
    const wanted = characterName.toLowerCase();
    return Object.values(session.players).find((p) => (p.characterName || p.userName).toLowerCase() === wanted);
  }

  isPlayer(session: GameSession, userId: string): boolean {
    return Boolean(session.players[userId]);
  }

  /** Party in join order (object insertion order — late joiners land at the end). */
  turnOrder(session: GameSession): Player[] {
    return Object.values(session.players);
  }

  /** Whose turn it is under round-robin; null if the party is empty. */
  currentPlayer(session: GameSession): Player | null {
    const order = this.turnOrder(session);
    return order.length ? order[session.turnIndex % order.length] : null;
  }

  /**
   * Advance the round-robin pointer to the next party member, wrapping around.
   * The stored index stays normalized to [0, party size): an un-normalized
   * wrap value (== length) would point at whoever joins next, stealing the
   * already-announced turn from player 0.
   */
  async advanceTurn(session: GameSession): Promise<Player | null> {
    const order = this.turnOrder(session);
    if (order.length) session.turnIndex = ((session.turnIndex % order.length) + 1) % order.length;
    await this.save(session);
    return this.currentPlayer(session);
  }
}
