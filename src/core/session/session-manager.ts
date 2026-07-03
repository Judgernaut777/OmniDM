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

  /** Add or update a player in the party. */
  async join(session: GameSession, msg: IncomingMessage, characterName?: string): Promise<Player> {
    const existing = session.players[msg.userId];
    const player: Player = {
      userId: msg.userId,
      userName: msg.userName,
      characterName: characterName ?? existing?.characterName,
      hp: existing?.hp ?? 10,
      maxHp: existing?.maxHp ?? 10,
      card: existing?.card,
    };
    session.players[msg.userId] = player;
    await this.save(session);
    return player;
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
