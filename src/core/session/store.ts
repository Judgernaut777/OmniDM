/**
 * Session persistence.
 *
 * Following the "plain files as truth" approach from open-tabletop-gm and
 * NarrativeEngine-P: each session is a JSON file under DATA_DIR. Simple,
 * inspectable, git-friendly. Swap this class for a DB-backed one later without
 * touching the engine — it only depends on the async interface.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GameSession } from '../types.js';

export class SessionStore {
  private cache = new Map<string, GameSession>();

  constructor(private dataDir: string) {}

  private file(key: string): string {
    // key is "platform:channelId" — make it filesystem-safe.
    const safe = key.replace(/[^a-z0-9_.-]/gi, '_');
    return path.join(this.dataDir, `session_${safe}.json`);
  }

  async load(key: string): Promise<GameSession | null> {
    if (this.cache.has(key)) return this.cache.get(key)!;
    try {
      const raw = await fs.readFile(this.file(key), 'utf8');
      const session = JSON.parse(raw) as GameSession;
      // Fields added after v1 — default them so pre-existing files still load.
      session.turnMode ??= 'immediate';
      session.turnIndex ??= 0;
      session.npcs ??= [];
      session.lorebook ??= [];
      session.fogOfWar ??= false;
      this.cache.set(key, session);
      return session;
    } catch {
      return null;
    }
  }

  async save(key: string, session: GameSession): Promise<void> {
    this.cache.set(key, session);
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.writeFile(this.file(key), JSON.stringify(session, null, 2), 'utf8');
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
    await fs.rm(this.file(key), { force: true });
  }
}
