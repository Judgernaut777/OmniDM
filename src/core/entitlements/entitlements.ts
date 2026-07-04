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

export interface Entitlements {
  /** Which implementation this is ('self-host' | 'hosted' | ...) — surfaced for logging/UI, not for branching. */
  readonly id: string;
  /** True if the current operator/user may use `key` (a content pack id or feature key). */
  isUnlocked(key: EntitlementKey): boolean;
}

/** Self-host default: nothing is gated. This is the ONLY mode OmniDM ships fully wired today. */
export const selfHostEntitlements: Entitlements = {
  id: 'self-host',
  isUnlocked(): boolean {
    return true;
  },
};

export interface HostedEntitlementsConfig {
  /** Explicitly unlocked keys (e.g. packs a purchase/subscription unlocked later). `'*'` unlocks everything. */
  unlockedKeys?: EntitlementKey[];
  /**
   * When false (default), this stub behaves exactly like self-host — a hosted
   * tier flag with no billing wired up must never lock anyone out by accident.
   * A real hosted deployment sets this true once it has an actual
   * entitlement source (a purchases DB, a subscription check, ...) behind
   * `unlockedKeys`.
   */
  enforcePremium?: boolean;
}

/** A stub "hosted" implementation: gates on a static allowlist once `enforcePremium` is turned on. */
export function createHostedEntitlements(cfg: HostedEntitlementsConfig = {}): Entitlements {
  const unlocked = new Set(cfg.unlockedKeys ?? []);
  const enforce = cfg.enforcePremium ?? false;
  return {
    id: 'hosted',
    isUnlocked(key: EntitlementKey): boolean {
      if (!enforce) return true;
      return unlocked.has('*') || unlocked.has(key);
    },
  };
}

/** How an operator selects entitlements — read from {@link ../../config.js}'s `monetization` block. */
export interface EntitlementsSelector {
  hosted?: boolean;
  unlockedPackIds?: string[];
}

/**
 * Build the active {@link Entitlements} from config. Self-host (the default,
 * `hosted: false`) always unlocks everything; a hosted deployment opts in by
 * setting `hosted: true` (`OMNIDM_HOSTED_TIER=1`), at which point premium
 * packs/features gate on `unlockedPackIds` (`OMNIDM_UNLOCKED_PACKS`, or `*`).
 */
export function selectEntitlements(sel: EntitlementsSelector = {}): Entitlements {
  if (!sel.hosted) return selfHostEntitlements;
  return createHostedEntitlements({ unlockedKeys: sel.unlockedPackIds, enforcePremium: true });
}
