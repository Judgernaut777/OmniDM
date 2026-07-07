/**
 * Purchase store — the persistent record of "which tenant has bought which
 * pack", written by Stripe webhook fulfillment and read by the entitlements
 * gate. This is the piece that turns the hosted entitlements STUB (a static
 * allowlist in config) into a real, live source of truth: a paying tenant's
 * unlock lands here the moment their checkout completes, with no redeploy.
 *
 * Reads are SYNCHRONOUS on purpose: the entitlements gate (`isUnlocked`) is
 * called inline on the hot path (loading a pack, listing packs) and is sync, so
 * a store keeps an in-memory view and answers reads from it. Writes (`grant`)
 * persist and update the view; a durable implementation loads its view once at
 * boot (see `load()` on the Node file store) before the gate is ever consulted.
 *
 * Keyed by {@link tenantKey} (`"<platform>:<channelId>"`) — the same tenant id
 * the rest of the entitlements layer uses (see `entitlements.ts`).
 *
 * Browser-safe: this module is pure (Map + strings), no `node:` imports. The
 * durable file-backed implementation lives in the Node-only `store-node.ts`.
 */

/** The persistent unlock record for a hosted, multi-tenant deployment. */
export interface PurchaseStore {
  /** Sync: is `packId` unlocked for this tenant? Answered from the in-memory view. */
  isUnlocked(tenantKey: string, packId: string): boolean;
  /** All packs unlocked for a tenant (for a "your unlocks" surface). */
  list(tenantKey: string): string[];
  /** Persist an unlock (idempotent) — called by webhook fulfillment. */
  grant(tenantKey: string, packId: string): Promise<void>;
}

/** The serializable shape a durable store round-trips: tenantKey → unlocked pack ids. */
export type PurchaseRecord = Record<string, string[]>;

/** Merge a granted (tenantKey, packId) into a record in place; returns true if it was new. */
export function applyGrant(record: PurchaseRecord, tenantKey: string, packId: string): boolean {
  const list = record[tenantKey] ?? (record[tenantKey] = []);
  if (list.includes(packId)) return false;
  list.push(packId);
  return true;
}

/**
 * An in-memory {@link PurchaseStore} — the default for tests and for a
 * single-process hosted deployment that doesn't need unlocks to survive a
 * restart. The Node file store extends the same contract with durability.
 */
export class MemoryPurchaseStore implements PurchaseStore {
  protected record: PurchaseRecord;

  constructor(seed: PurchaseRecord = {}) {
    // Defensive copy so a caller's object can't mutate our view out from under us.
    this.record = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, [...v]]));
  }

  isUnlocked(tenantKey: string, packId: string): boolean {
    const list = this.record[tenantKey];
    return Boolean(list && (list.includes('*') || list.includes(packId)));
  }

  list(tenantKey: string): string[] {
    return [...(this.record[tenantKey] ?? [])];
  }

  async grant(tenantKey: string, packId: string): Promise<void> {
    applyGrant(this.record, tenantKey, packId);
  }
}
