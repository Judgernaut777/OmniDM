/**
 * Browser SessionStorage — the in-app persistence seam.
 *
 * `SessionStorage` already abstracts persistence (NodeFileStorage writes JSON
 * files under DATA_DIR). This is the WebView-side implementation: it persists
 * each session as a JSON string in a durable key-value store — IndexedDB when
 * available, `localStorage` otherwise — so an in-app game survives a reload
 * without any node: dependency.
 *
 * The storage-engine detail is isolated behind {@link AsyncKeyValue}, so the
 * serialization/caching/legacy-defaulting logic (the part worth testing) can run
 * under Node against an in-memory or fake-`Storage` key-value and be exercised by
 * the offline smoke test.
 *
 * SECURITY: a session file NEVER contains the user's LLM API key — that secret
 * lives only in app storage under a separate key the engine never serializes.
 */
import type { GameSession } from '../types.js';
import type { SessionStorage } from './storage.js';

/** A minimal async key→string store. Both IndexedDB and localStorage adapt to this. */
export interface AsyncKeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Default namespace so session records don't collide with other app keys. */
const KEY_PREFIX = 'omnidm:session:';

/**
 * Fields added after v1 — default them so a session persisted by an older build
 * still loads. Mirrors NodeFileStorage.load in ./store.ts (kept in sync there).
 */
function applyDefaults(session: GameSession): GameSession {
  session.turnMode ??= 'immediate';
  session.turnIndex ??= 0;
  session.npcs ??= [];
  session.lorebook ??= [];
  session.fogOfWar ??= false;
  session.memories ??= [];
  return session;
}

export class BrowserSessionStorage implements SessionStorage {
  private cache = new Map<string, GameSession>();

  constructor(
    private kv: AsyncKeyValue,
    private prefix = KEY_PREFIX,
  ) {}

  private k(key: string): string {
    return this.prefix + key;
  }

  async load(key: string): Promise<GameSession | null> {
    if (this.cache.has(key)) return this.cache.get(key)!;
    const raw = await this.kv.get(this.k(key)).catch(() => null);
    if (!raw) return null;
    try {
      const session = applyDefaults(JSON.parse(raw) as GameSession);
      this.cache.set(key, session);
      return session;
    } catch {
      return null; // corrupt record — treat as absent rather than crash the app
    }
  }

  async save(key: string, session: GameSession): Promise<void> {
    this.cache.set(key, session);
    await this.kv.set(this.k(key), JSON.stringify(session));
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
    await this.kv.remove(this.k(key));
  }
}

// ─── Key-value adapters ──────────────────────────────────────────────────────

/** The `Storage` surface we use (a subset of the DOM's `localStorage`/`sessionStorage`). */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Adapt a synchronous Web `Storage` (localStorage) to the async KV interface. */
export function webStorageKeyValue(storage: WebStorageLike): AsyncKeyValue {
  return {
    async get(key) {
      return storage.getItem(key);
    },
    async set(key, value) {
      storage.setItem(key, value);
    },
    async remove(key) {
      storage.removeItem(key);
    },
  };
}

/**
 * Adapt IndexedDB (one object store of string values) to the async KV interface.
 * Opens the database lazily on first use. Only touches `indexedDB` when called,
 * so importing this module under Node is harmless.
 *
 * The IndexedDB DOM types aren't in this project's lib (it must stay Node-typed
 * so the shared engine builds without pulling the DOM globals in), so the store
 * request objects are locally structurally typed rather than via `IDB*` types.
 */
export function indexedDbKeyValue(dbName = 'omnidm', storeName = 'sessions'): AsyncKeyValue {
  /** The slice of an IndexedDB request we touch. */
  interface Req<T> { result: T; error: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null; onupgradeneeded?: (() => void) | null; }
  interface Store { get(k: string): Req<unknown>; put(v: string, k: string): Req<unknown>; delete(k: string): Req<unknown>; }
  interface Tx { objectStore(name: string): Store; }
  interface DB { transaction(store: string, mode: string): Tx; objectStoreNames: { contains(n: string): boolean }; createObjectStore(n: string): unknown; }

  const idb = (globalThis as { indexedDB?: { open(name: string, v: number): Req<DB> } }).indexedDB;
  if (!idb) throw new Error('IndexedDB is not available in this environment');
  let dbPromise: Promise<DB> | undefined;

  const open = (): Promise<DB> => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<DB>((resolve, reject) => {
      const req = idb.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    });
    return dbPromise;
  };

  const run = async <T>(mode: 'readonly' | 'readwrite', fn: (store: Store) => Req<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(storeName, mode).objectStore(storeName));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
    });
  };

  return {
    async get(key) {
      const v = await run<unknown>('readonly', (s) => s.get(key));
      return typeof v === 'string' ? v : null;
    },
    async set(key, value) {
      await run('readwrite', (s) => s.put(value, key));
    },
    async remove(key) {
      await run('readwrite', (s) => s.delete(key));
    },
  };
}

/**
 * Build the best available browser SessionStorage: IndexedDB if present, else
 * `localStorage`. Throws only if neither exists (not a browser). The composition
 * root of the in-app build calls this.
 */
export function createBrowserSessionStorage(): BrowserSessionStorage {
  const g = globalThis as unknown as { indexedDB?: unknown; localStorage?: WebStorageLike };
  if (g.indexedDB) return new BrowserSessionStorage(indexedDbKeyValue());
  if (g.localStorage) return new BrowserSessionStorage(webStorageKeyValue(g.localStorage));
  throw new Error('no browser storage backend (need indexedDB or localStorage)');
}
