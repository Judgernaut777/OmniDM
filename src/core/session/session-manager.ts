/**
 * Session manager — maps a platform channel to a game session and tracks the
 * party. This is half of the genuinely-novel layer (the other half is the
 * platform adapters): tying multi-user chat rooms to shared game state.
 */
import { nanoid } from 'nanoid';
import type { GameSession, IncomingMessage, Player } from '../types.js';
import { SessionStore } from './store.js';

export class SessionManager {
  constructor(
    private store: SessionStore,
    private defaultModel: string,
  ) {}

  /** Stable key for a channel across restarts. */
  key(msg: { platform: string; channelId: string }): string {
    return `${msg.platform}:${msg.channelId}`;
  }

  async get(msg: IncomingMessage): Promise<GameSession | null> {
    return this.store.load(this.key(msg));
  }

  async create(msg: IncomingMessage, systemId = 'dnd5e'): Promise<GameSession> {
    const session: GameSession = {
      id: nanoid(10),
      platform: msg.platform,
      channelId: msg.channelId,
      systemId,
      model: this.defaultModel,
      players: {},
      history: [],
      summary: '',
      turnMode: 'immediate',
      turnIndex: 0,
      createdAt: Date.now(),
    };
    await this.store.save(this.key(msg), session);
    return session;
  }

  async save(session: GameSession): Promise<void> {
    await this.store.save(`${session.platform}:${session.channelId}`, session);
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

  /** Advance the round-robin pointer to the next party member, wrapping around. */
  async advanceTurn(session: GameSession): Promise<Player | null> {
    const order = this.turnOrder(session);
    if (order.length) session.turnIndex = (session.turnIndex % order.length) + 1;
    await this.save(session);
    return this.currentPlayer(session);
  }
}
