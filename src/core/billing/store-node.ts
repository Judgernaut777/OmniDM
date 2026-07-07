/**
 * Node file-backed {@link PurchaseStore} — durable unlock persistence for a
 * hosted deployment. Keeps the sync in-memory view the entitlements gate reads
 * from, and writes the whole record to a JSON file on every `grant` (the record
 * is tiny — a map of tenant → pack ids — so a full rewrite is cheap and
 * atomic-enough for this volume; a real high-scale deployment would swap this
 * for a database behind the same interface).
 *
 * Node-only (`node:fs`) — billing/webhook handling runs server-side, never in
 * the browser engine.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MemoryPurchaseStore, type PurchaseRecord } from './purchase-store.js';

export class FilePurchaseStore extends MemoryPurchaseStore {
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {
    super();
  }

  /**
   * Load the persisted record into the in-memory view. MUST be awaited at boot,
   * before the entitlements gate is consulted — a missing/corrupt file starts
   * empty (a self-host operator turning billing on for the first time has no
   * purchases yet) rather than crashing the process.
   */
  async load(): Promise<this> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const clean: PurchaseRecord = {};
        for (const [tenant, ids] of Object.entries(parsed as Record<string, unknown>)) {
          if (Array.isArray(ids) && ids.every((x) => typeof x === 'string')) clean[tenant] = ids as string[];
        }
        this.record = clean;
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') console.warn(`[billing] could not read purchase store ${this.file}: ${e.message} — starting empty`);
    }
    return this;
  }

  override async grant(tenantKey: string, packId: string): Promise<void> {
    await super.grant(tenantKey, packId);
    // Serialize writes so two concurrent webhook fulfillments can't interleave
    // a read-modify-write and lose one grant.
    this.writing = this.writing.then(() => this.persist());
    await this.writing;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.record, null, 2), 'utf8');
    await fs.rename(tmp, this.file); // atomic replace
  }
}
