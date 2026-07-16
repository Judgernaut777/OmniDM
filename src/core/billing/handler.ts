/**
 * Billing HTTP handler — the transport-agnostic glue that turns Stripe traffic
 * into entitlement grants. It knows nothing about `node:http`; it takes a plain
 * `{method, pathname, headers, rawBody, query}` and returns a plain
 * `{status, body, headers}`, so the web adapter (or any future transport) can
 * mount it with a few lines, and it's exercised in tests with no sockets.
 *
 * Three routes:
 *   POST /billing/checkout  — create a Stripe Checkout Session for (tenant, pack)
 *   POST /billing/webhook   — verify Stripe's callback, fulfill the unlock
 *   GET  /billing/status    — the packs a tenant has unlocked (client convenience)
 *
 * Fulfillment is the crux: a VERIFIED `checkout.session.completed` grants the
 * pack to the tenant in the {@link PurchaseStore}, which the entitlements gate
 * then reads live — no redeploy, no static allowlist edit.
 */
import { timingSafeEqual } from 'node:crypto';
import { tenantKey, type EntitlementScope } from '../entitlements/entitlements.js';
import { listBundledContentPacks } from '../content-packs/registry.js';
import type { PurchaseStore } from './purchase-store.js';
import {
  createCheckoutSession,
  parseCheckoutCompleted,
  verifyStripeSignature,
  type FetchLike,
  type StripeCheckoutEvent,
} from './stripe.js';

/**
 * The shared room password, if configured. GET /billing/status is otherwise
 * unauthenticated (a client convenience probe, called before anyone has
 * necessarily joined a room) and would let any caller enumerate which
 * (platform, channelId) tenants own which packs by guessing channelIds — an
 * information-disclosure hole. Read directly from the environment (this
 * handler is transport-agnostic and isn't wired through `src/config.ts`;
 * `src/adapters/web.ts` reads `WEB_ALLOWED_ORIGINS`/`WEB_ALLOWED_HOSTS` the
 * same direct way) rather than threading a new dependency through the
 * composition root.
 */
const WEB_PASSWORD = process.env.WEB_PASSWORD || '';

/** Constant-time string compare so checking the password can't leak it via timing. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Does this GET /billing/status request present the configured WEB_PASSWORD (header or query)? */
function presentsWebPassword(req: BillingHttpRequest): boolean {
  if (!WEB_PASSWORD) return false; // nothing configured to gate on — see the caller for the fallback
  const supplied = req.headers['x-web-password'] ?? req.query?.password;
  return typeof supplied === 'string' && supplied.length > 0 && safeEqual(supplied, WEB_PASSWORD);
}

export interface BillingHttpRequest {
  method: string;
  pathname: string;
  headers: Record<string, string | undefined>;
  /** The RAW request body bytes as a string — webhook verification needs the exact bytes. */
  rawBody: string;
  /** Parsed query string params (for GET /billing/status). */
  query?: Record<string, string | undefined>;
}

export interface BillingHttpResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

export interface BillingHandlerDeps {
  store: PurchaseStore;
  /** Map of premium pack id → Stripe Price id. A pack with no price can't be sold. */
  prices: Record<string, string>;
  apiKey: string;
  webhookSecret: string;
  successUrl: string;
  cancelUrl: string;
  mode?: 'payment' | 'subscription';
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Injected clock (unix seconds) for deterministic signature tolerance in tests. */
  nowSec?: () => number;
  /** Whether a pack id names a real, PREMIUM, sellable pack. Defaults to the price map's keys. */
  isSellable?: (packId: string) => boolean;
}

const json = (status: number, obj: unknown): BillingHttpResponse => ({
  status,
  body: JSON.stringify(obj),
  headers: { 'Content-Type': 'application/json' },
});

/** True if this request targets the billing surface (so the transport can route it here). */
export function isBillingPath(pathname: string): boolean {
  return pathname === '/billing/checkout' || pathname === '/billing/webhook' || pathname === '/billing/status';
}

export function createBillingHandler(deps: BillingHandlerDeps): (req: BillingHttpRequest) => Promise<BillingHttpResponse> {
  const isSellable = deps.isSellable ?? ((packId: string) => Boolean(deps.prices[packId]));
  const doFetch = deps.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);

  return async (req: BillingHttpRequest): Promise<BillingHttpResponse> => {
    // ── POST /billing/webhook ──────────────────────────────────────────────
    if (req.pathname === '/billing/webhook') {
      if (req.method !== 'POST') return json(405, { error: 'method not allowed' });
      const verdict = verifyStripeSignature(req.rawBody, req.headers['stripe-signature'], deps.webhookSecret, {
        ...(deps.nowSec ? { nowSec: deps.nowSec() } : {}),
      });
      if (!verdict.ok) return json(400, { error: `signature verification failed: ${verdict.reason}` });

      let event: StripeCheckoutEvent;
      try {
        event = JSON.parse(req.rawBody) as StripeCheckoutEvent;
      } catch {
        return json(400, { error: 'body is not JSON' });
      }
      const fulfil = parseCheckoutCompleted(event);
      // A verified event we don't fulfill (other event types) is still ACKed 200
      // — Stripe retries non-2xx, and we don't want retries for events we ignore.
      if (!fulfil) return json(200, { received: true, fulfilled: false });
      await deps.store.grant(fulfil.tenantKey, fulfil.packId);
      return json(200, { received: true, fulfilled: true, tenantKey: fulfil.tenantKey, packId: fulfil.packId });
    }

    // ── POST /billing/checkout ─────────────────────────────────────────────
    if (req.pathname === '/billing/checkout') {
      if (req.method !== 'POST') return json(405, { error: 'method not allowed' });
      let body: { platform?: string; channelId?: string; packId?: string };
      try {
        body = JSON.parse(req.rawBody || '{}');
      } catch {
        return json(400, { error: 'body is not JSON' });
      }
      const { platform, channelId, packId } = body;
      if (!platform || !channelId || !packId) return json(400, { error: 'platform, channelId and packId are required' });
      if (!isSellable(packId)) return json(404, { error: `no purchasable pack "${packId}"` });
      const priceId = deps.prices[packId];
      if (!priceId) return json(404, { error: `pack "${packId}" has no configured price` });
      const scope: EntitlementScope = { platform, channelId };
      // Already owned? Don't send them to pay twice.
      if (deps.store.isUnlocked(tenantKey(scope), packId)) return json(200, { alreadyUnlocked: true });
      try {
        const session = await createCheckoutSession(
          { fetch: doFetch, apiKey: deps.apiKey },
          {
            priceId,
            tenantKey: tenantKey(scope),
            packId,
            successUrl: deps.successUrl,
            cancelUrl: deps.cancelUrl,
            ...(deps.mode ? { mode: deps.mode } : {}),
          },
        );
        return json(200, { url: session.url, id: session.id });
      } catch (err) {
        return json(502, { error: `could not start checkout: ${(err as Error).message}` });
      }
    }

    // ── GET /billing/status ────────────────────────────────────────────────
    if (req.pathname === '/billing/status') {
      if (req.method !== 'GET') return json(405, { error: 'method not allowed' });
      const platform = req.query?.platform;
      const channelId = req.query?.channelId;
      if (!platform || !channelId) return json(400, { error: 'platform and channelId query params are required' });
      const catalog = listBundledContentPacks().filter((p) => p.premium && isSellable(p.id));
      // Per-tenant ownership (which channelId owns which pack) is gated ONLY
      // when a WEB_PASSWORD is configured — i.e. a hosted/shared deployment,
      // the case where enumerating tenants by guessing channelIds is a real
      // information-disclosure hole. A caller must then present the password to
      // see ownership; everyone else gets the generic catalog with no ownership
      // signal. When no password is configured (the self-host default) there is
      // nothing to protect — self-host unlocks everything and has no paying
      // tenants — so the full ownership view is returned as before, keeping the
      // local status UI working.
      if (WEB_PASSWORD && !presentsWebPassword(req)) {
        return json(200, {
          enabled: true,
          purchasable: catalog.map((p) => ({ id: p.id, name: p.name, description: p.description ?? '' })),
        });
      }
      const unlocked = deps.store.list(tenantKey({ platform, channelId }));
      const owns = (id: string): boolean => unlocked.includes('*') || unlocked.includes(id);
      // The shop catalog the client renders: bundled premium packs that have a
      // configured Stripe price, each flagged as owned-by-this-tenant or not.
      const purchasable = catalog.map((p) => ({ id: p.id, name: p.name, description: p.description ?? '', unlocked: owns(p.id) }));
      return json(200, { unlocked, purchasable });
    }

    return json(404, { error: 'not found' });
  };
}
