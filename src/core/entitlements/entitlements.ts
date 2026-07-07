/**
 * Entitlements — the pluggable "who's allowed to use this" seam that premium
 * content packs (and, later, premium features) gate behind.
 *
 * This is deliberately NOT a billing system: it is the minimal interface a
 * real billing integration would sit behind, plus two implementations that
 * work today with zero external services:
 *
 *  - {@link selfHostEntitlements}: everything unlocked. This is the default —
 *    an operator running their own OmniDM (the only mode that exists today)
 *    owns their own server and data, so there is nothing to gate.
 *  - {@link createHostedEntitlements}: a STUB for a future hosted tier. It
 *    only actually gates anything when `enforcePremium` is set (see
 *    {@link selectEntitlements}); until a real billing backend is wired in,
 *    an operator can flip it on for testing without it locking real players
 *    out by surprise.
 *
 * Browser-safe: no `node:` imports, so it can run in the in-app engine too —
 * a future hosted hybrid client could ship the same gate client-side.
 */

/** A stable id for a gated thing: a content pack's `id`, or a feature flag key. */
export type EntitlementKey = string;

/**
 * Identifies WHO an entitlement check is for, in a process that may serve
 * many tenants at once — a hosted OmniDM is typically one adapter connection
 * (one Discord bot token, one Slack app, ...) fanning out to many
 * guilds/rooms, each potentially a different paying customer. `channelId` is
 * the natural unit here because content packs (this seam's only real gated
 * thing today) are loaded into a per-channel `GameSession`, not per
 * individual player — "unlocked for this campaign/room" is the granularity
 * that actually matches what gets gated. Per-individual-player entitlements
 * within a shared room would need a different design; this scope doesn't
 * claim to solve that.
 */
export interface EntitlementScope {
  platform: string;
  channelId: string;
}

/** The stable key a tenant's per-scope unlocks are stored/looked-up under (`"<platform>:<channelId>"`). */
export function tenantKey(scope: EntitlementScope): string {
  return `${scope.platform}:${scope.channelId}`;
}

export interface Entitlements {
  /** Which implementation this is ('self-host' | 'hosted' | ...) — surfaced for logging/UI, not for branching. */
  readonly id: string;
  /**
   * True if `key` (a content pack id or feature key) is usable. `scope`
   * identifies the calling tenant (platform + channel/guild/room) so a
   * hosted, multi-tenant process can gate per-tenant instead of identically
   * for every caller; omit it only for a genuinely single-tenant/self-host
   * check where there's nobody else in the process to distinguish from.
   */
  isUnlocked(key: EntitlementKey, scope?: EntitlementScope): boolean;
}

/** Self-host default: nothing is gated. This is the ONLY mode OmniDM ships fully wired today. */
export const selfHostEntitlements: Entitlements = {
  id: 'self-host',
  isUnlocked(): boolean {
    return true;
  },
};

export interface HostedEntitlementsConfig {
  /** Explicitly unlocked keys for EVERY tenant (e.g. a pack included with every plan). `'*'` unlocks everything. */
  unlockedKeys?: EntitlementKey[];
  /**
   * Per-tenant unlocks, keyed by {@link tenantKey} (`"<platform>:<channelId>"`)
   * — what lets a hosted deployment serving many guilds/rooms from ONE
   * process unlock a premium pack for the ONE tenant that paid without
   * unlocking it for every other tenant the same process serves. Checked
   * only when a `scope` is passed to `isUnlocked`; `unlockedKeys` above still
   * applies process-wide regardless of scope. A real billing integration
   * replaces this static map with a purchase-store query keyed by the same
   * tenant id (see `tenantKey`) — or wraps `isUnlocked` entirely.
   */
  perTenantUnlockedKeys?: Record<string, EntitlementKey[]>;
  /**
   * A LIVE unlock source, checked per-tenant after the static maps above — this
   * is the seam a real billing backend plugs into. A {@link
   * ../billing/purchase-store.js PurchaseStore} satisfies it directly
   * (`store.isUnlocked`), so a Stripe webhook grant is honored by the gate the
   * instant it lands, with no redeploy. Kept structural (a callback, not a
   * store import) so this module has no dependency on the billing layer.
   */
  isPurchased?: (tenantKey: string, key: EntitlementKey) => boolean;
  /**
   * When false (default), this stub behaves exactly like self-host — a hosted
   * tier flag with no billing wired up must never lock anyone out by accident.
   * A real hosted deployment sets this true once it has an actual
   * entitlement source (a purchases DB, a subscription check, ...) behind
   * `unlockedKeys` / `perTenantUnlockedKeys`.
   */
  enforcePremium?: boolean;
}

/** A stub "hosted" implementation: gates on a static (process-wide + per-tenant) allowlist once `enforcePremium` is turned on. */
export function createHostedEntitlements(cfg: HostedEntitlementsConfig = {}): Entitlements {
  const unlocked = new Set(cfg.unlockedKeys ?? []);
  const perTenant = cfg.perTenantUnlockedKeys ?? {};
  const enforce = cfg.enforcePremium ?? false;
  return {
    id: 'hosted',
    isUnlocked(key: EntitlementKey, scope?: EntitlementScope): boolean {
      if (!enforce) return true;
      if (unlocked.has('*') || unlocked.has(key)) return true;
      if (!scope) return false;
      const tk = tenantKey(scope);
      const tenantUnlocked = perTenant[tk];
      if (tenantUnlocked && (tenantUnlocked.includes('*') || tenantUnlocked.includes(key))) return true;
      // Live source last (a paid unlock recorded by webhook fulfillment).
      return Boolean(cfg.isPurchased?.(tk, key));
    },
  };
}

/** How an operator selects entitlements — read from {@link ../../config.js}'s `monetization` block. */
export interface EntitlementsSelector {
  hosted?: boolean;
  unlockedPackIds?: string[];
  /** Per-tenant unlocks — see {@link HostedEntitlementsConfig.perTenantUnlockedKeys}. */
  tenantUnlockedPackIds?: Record<string, string[]>;
}

/** The minimal live-unlock source `selectEntitlements` will consult (a PurchaseStore satisfies it). */
export interface UnlockSource {
  isUnlocked(tenantKey: string, key: string): boolean;
}

/**
 * Build the active {@link Entitlements} from config. Self-host (the default,
 * `hosted: false`) always unlocks everything; a hosted deployment opts in by
 * setting `hosted: true` (`OMNIDM_HOSTED_TIER=1`), at which point premium
 * packs/features gate on `unlockedPackIds` (`OMNIDM_UNLOCKED_PACKS`, or `*`)
 * process-wide, plus `tenantUnlockedPackIds` (`OMNIDM_TENANT_UNLOCKED_PACKS`)
 * for per-guild/per-room unlocks.
 */
export function selectEntitlements(sel: EntitlementsSelector = {}, purchases?: UnlockSource): Entitlements {
  if (!sel.hosted) return selfHostEntitlements;
  return createHostedEntitlements({
    unlockedKeys: sel.unlockedPackIds,
    perTenantUnlockedKeys: sel.tenantUnlockedPackIds,
    // A live billing source (a PurchaseStore) unlocks a pack the moment a
    // tenant's Stripe checkout completes — no static-map edit, no redeploy.
    ...(purchases ? { isPurchased: (tk: string, key: string): boolean => purchases.isUnlocked(tk, key) } : {}),
    enforcePremium: true,
  });
}
