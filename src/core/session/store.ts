/**
 * Session persistence — the Node implementation of SessionStorage.
 *
 * Following the "plain files as truth" approach from open-tabletop-gm and
 * NarrativeEngine-P: each session is a JSON file under DATA_DIR. Simple,
 * inspectable, git-friendly. Swap this class for a DB- or browser-backed one
 * at the composition root — the engine only depends on the interface.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GameSession } from '../types.js';
import type { SessionStorage } from './storage.js';

/**
 * Pretty-print the session, but keep all-number arrays (embedding vectors,
 * dice rolls) on one line each: `JSON.stringify(…, 2)` would otherwise emit an
 * embedding as ~1500 lines, bloating a file that's rewritten every turn.
 */
function stringifySession(session: GameSession): string {
  const nonce = Math.random().toString(36).slice(2); // so player text can't fake a placeholder
  const inlined: string[] = [];
  const json = JSON.stringify(
    session,
    (_key, value) =>
      Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'number')
        ? `@arr:${nonce}:${inlined.push(JSON.stringify(value)) - 1}@`
        : value,
    2,
  );
  return json.replace(new RegExp(`"@arr:${nonce}:(\\d+)@"`, 'g'), (_m, i: string) => inlined[Number(i)]);
}

export class NodeFileStorage implements SessionStorage {
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
      session.memories ??= [];
      this.cache.set(key, session);
      return session;
    } catch {
      return null;
    }
  }

  async save(key: string, session: GameSession): Promise<void> {
    this.cache.set(key, session);
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.writeFile(this.file(key), stringifySession(session), 'utf8');
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
    await fs.rm(this.file(key), { force: true });
  }
}
