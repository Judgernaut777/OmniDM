/**
 * Session persistence — the Node implementation of SessionStorage.
 *
 * Following the "plain files as truth" approach from open-tabletop-gm and
 * NarrativeEngine-P: each session is a JSON file under DATA_DIR. Simple,
 * inspectable, git-friendly. Swap this class for a DB- or browser-backed one
 * at the composition root — the engine only depends on the interface.
 *
 * Durability: writes go to a temp file (fsynced) then `fs.rename` onto the
 * final path, so a crash/disk-full mid-write can never leave a truncated file
 * at the path readers use — atomic same-filesystem rename either lands the
 * whole new file or leaves the old one untouched. See src/core/billing/store-node.ts
 * for the same pattern used for the billing store.
 */
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { nanoid } from 'nanoid';
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

/** Minimal shape check: is this plausibly a GameSession, not corrupt/garbage? */
function looksLikeSession(value: unknown): value is GameSession {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.players === 'object' && v.players !== null;
}

export class NodeFileStorage implements SessionStorage {
  private cache = new Map<string, GameSession>();

  constructor(private dataDir: string) {}

  /**
   * Current (post-fix) path: filename derived from a hash of the FULL key so
   * distinct keys (e.g. "web:a/b" vs "web:a_b" vs "web:a:b") can never
   * collapse onto the same file — the old scheme sanitized the key by
   * replacing every non-alphanumeric char with `_`, so attacker-controlled
   * web channelIds could collide and overwrite another room's save. The
   * sanitized label is kept (truncated) purely so filenames stay
   * human-recognizable; uniqueness comes entirely from the hash suffix.
   */
  private file(key: string): string {
    const label = key.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 60);
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
    return path.join(this.dataDir, `session_${label}_${hash}.json`);
  }

  /**
   * Pre-fix path (sanitize-only, collision-prone). Existing deployments have
   * files here; on load, if the new hashed path is missing, fall back to this
   * one so pre-existing saves keep loading. Saves always go to the new path.
   */
  private legacyFile(key: string): string {
    const safe = key.replace(/[^a-z0-9_.-]/gi, '_');
    return path.join(this.dataDir, `session_${safe}.json`);
  }

  private backupFile(key: string): string {
    return `${this.file(key)}.bak`;
  }

  /** Parse+validate one file's contents, or throw. */
  private parseSession(raw: string): GameSession {
    const parsed: unknown = JSON.parse(raw);
    if (!looksLikeSession(parsed)) throw new Error('does not look like a GameSession (missing id/players)');
    const session = parsed;
    // Fields added after v1 — default them so pre-existing files still load.
    session.turnMode ??= 'immediate';
    session.turnIndex ??= 0;
    session.npcs ??= [];
    session.lorebook ??= [];
    session.fogOfWar ??= false;
    session.memories ??= [];
    return session;
  }

  async load(key: string): Promise<GameSession | null> {
    if (this.cache.has(key)) return this.cache.get(key)!;

    const mainPath = this.file(key);
    let raw: string | undefined;
    let readErr: NodeJS.ErrnoException | undefined;
    try {
      raw = await fs.readFile(mainPath, 'utf8');
    } catch (err) {
      readErr = err as NodeJS.ErrnoException;
    }

    if (raw === undefined) {
      if (readErr?.code === 'ENOENT') {
        // New path doesn't exist — try the pre-migration legacy path before
        // concluding there's genuinely no session.
        try {
          const legacyRaw = await fs.readFile(this.legacyFile(key), 'utf8');
          const session = this.parseSession(legacyRaw);
          this.cache.set(key, session);
          return session;
        } catch (legacyErr) {
          const le = legacyErr as NodeJS.ErrnoException;
          if (le.code === 'ENOENT') return null; // genuinely no session anywhere
          console.error(`[session] legacy save for ${key} at ${this.legacyFile(key)} is unreadable/corrupt: ${le.message}`);
          throw new Error(`Session file for "${key}" (${this.legacyFile(key)}) is corrupt or unreadable and has no backup: ${le.message}`);
        }
      }
      // Non-ENOENT error (EIO/EACCES/etc) reading the main path — do NOT
      // silently treat as "no session", that leads callers to overwrite real
      // data. Log loudly and try the backup before giving up.
      console.error(`[session] failed to read save for ${key} at ${mainPath}: ${readErr?.message}`);
      return this.loadFromBackupOrThrow(key, mainPath, readErr?.message ?? 'unknown read error');
    }

    try {
      const session = this.parseSession(raw);
      this.cache.set(key, session);
      return session;
    } catch (parseErr) {
      // Corrupt JSON / bad shape at the main path — do not return null (that
      // reads as "no campaign" and callers would overwrite it, losing data
      // silently). Log loudly and fall back to the backup, or throw.
      console.error(`[session] save for ${key} at ${mainPath} is corrupt: ${(parseErr as Error).message}`);
      return this.loadFromBackupOrThrow(key, mainPath, (parseErr as Error).message);
    }
  }

  private async loadFromBackupOrThrow(key: string, mainPath: string, reason: string): Promise<GameSession> {
    const bakPath = this.backupFile(key);
    try {
      const bakRaw = await fs.readFile(bakPath, 'utf8');
      const session = this.parseSession(bakRaw);
      console.error(`[session] recovered ${key} from backup ${bakPath}`);
      this.cache.set(key, session);
      return session;
    } catch (bakErr) {
      throw new Error(
        `Session file for "${key}" (${mainPath}) is corrupt or unreadable (${reason}) and the backup (${bakPath}) is unavailable too: ${(bakErr as Error).message}`,
      );
    }
  }

  async save(key: string, session: GameSession): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    const file = this.file(key);
    const tmp = path.join(this.dataDir, `.session_${nanoid()}.tmp`);

    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(tmp, 'w');
      await handle.writeFile(stringifySession(session), 'utf8');
      await handle.sync(); // fsync — bytes are on disk before we rename over the old file
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    } finally {
      await handle?.close().catch(() => {});
    }

    // Best-effort previous-generation backup. COPY (not rename) the current
    // file aside: renaming it away would leave the final path briefly absent,
    // and a crash in that window makes load() see ENOENT and return null (data
    // silently "gone"). copyFile leaves the original in place, so the atomic
    // rename below always replaces an existing file — the path is never absent.
    // Never fails the save — losing the ability to recover from a *future*
    // corruption is much less bad than failing to persist *this* turn.
    try {
      await fs.copyFile(file, this.backupFile(key));
    } catch {
      // no existing file to back up (first save), or backup failed — fine, proceed.
    }

    try {
      await fs.rename(tmp, file); // atomic on the same filesystem
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }

    // Best-effort directory fsync so the rename itself is durable across a
    // crash, not just the file content. Not supported/needed on all
    // platforms — ignore failures.
    try {
      const dirHandle = await fs.open(this.dataDir, 'r');
      await dirHandle.sync().catch(() => {});
      await dirHandle.close();
    } catch {
      // ignore — best effort only
    }

    // Only update the in-memory cache once the on-disk commit is confirmed —
    // otherwise a crash between the cache write and the disk write would
    // leave the cache (and anything relying on it before its own restart)
    // out of sync with what's actually durable.
    this.cache.set(key, session);
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
    await fs.rm(this.file(key), { force: true });
    await fs.rm(this.legacyFile(key), { force: true });
    await fs.rm(this.backupFile(key), { force: true });
    // Stray tmp files use a random nanoid in their name, so there's no fixed
    // path to remove per-key; save()'s own catch-blocks unlink theirs on
    // failure, and any orphan left by a hard crash is harmless (ignored by
    // load(), never read).
  }
}
