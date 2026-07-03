/**
 * Session storage seam.
 *
 * The core (Bot, SessionManager) persists sessions only through this
 * interface, never through Node APIs directly, so it can eventually run in a
 * browser or mobile WebView — swap the implementation at the composition root
 * (src/index.ts). The JSON-file implementation (NodeFileStorage) lives in
 * ./store.ts; MemoryStorage below is the portable in-memory one.
 */
import type { GameSession } from '../types.js';

export interface SessionStorage {
  /** Session for a "platform:channelId" key, or null if none exists. */
  load(key: string): Promise<GameSession | null>;
  save(key: string, session: GameSession): Promise<void>;
  /** Remove a session everywhere it lives — including any live cache, so an ended campaign can't resurrect. */
  delete(key: string): Promise<void>;
}

/** Sessions live (and die) with the process. The future browser seam; handy in tests today. */
export class MemoryStorage implements SessionStorage {
  private sessions = new Map<string, GameSession>();

  async load(key: string): Promise<GameSession | null> {
    return this.sessions.get(key) ?? null;
  }

  async save(key: string, session: GameSession): Promise<void> {
    this.sessions.set(key, session);
  }

  async delete(key: string): Promise<void> {
    this.sessions.delete(key);
  }
}
