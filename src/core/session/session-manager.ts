/**
 * Session manager — maps a platform channel to a game session and tracks the
 * party. This is half of the genuinely-novel layer (the other half is the
 * platform adapters): tying multi-user chat rooms to shared game state.
 */
import { nanoid } from 'nanoid';
import type { GameSession, IncomingMessage, LLMProvider, Player } from '../types.js';
import type { SessionStorage } from './storage.js';

export class SessionManager {
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
    }
    return session;
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
    };
    await this.store.save(this.key(msg), session);
    return session;
  }

  async save(session: GameSession): Promise<void> {
    await this.store.save(`${session.platform}:${session.channelId}`, session);
  }

  /** End the campaign in a channel — must go through the shared store so its live cache is evicted too. */
  async end(msg: { platform: string; channelId: string }): Promise<void> {
    await this.store.delete(this.key(msg));
  }

  /**
   * Add or update a player in the party. A join from a userId NOT yet in the
   * party whose character name matches an existing member is a seat RE-CLAIM
   * (the web adapter mints a fresh userId per connection, so a reconnect +
   * `/dm join <name>` would otherwise leave a ghost entry that deadlocks
   * round-robin and swallows fog whispers): the old entry migrates to the new
   * userId in its original join-order slot, keeping hp/card and the turn
   * pointer intact. A member already in the party renaming themselves never
   * takes over someone else's seat.
   */
  async join(session: GameSession, msg: IncomingMessage, characterName?: string): Promise<Player> {
    const prior = session.players[msg.userId] ?? (characterName ? this.reclaimable(session, characterName) : undefined);
    const player: Player = {
      userId: msg.userId,
      userName: msg.userName,
      characterName: characterName ?? prior?.characterName,
      hp: prior?.hp ?? 10,
      maxHp: prior?.maxHp ?? 10,
      // Class + bio are part of the character identity — carry them across a
      // seat re-claim (a reconnect mints a fresh userId), like the portrait.
      class: prior?.class,
      bio: prior?.bio,
      card: prior?.card,
      // A seat re-claim (new userId, same character) must carry the portrait
      // across too — a preset OR uploaded image lives on the Player, and the web
      // adapter mints a fresh userId per reconnect. Dropping it here reverts the
      // portrait to the default crest and strands the uploaded bytes.
      portrait: prior?.portrait,
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
