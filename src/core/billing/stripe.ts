/**
 * Stripe integration — the real hosted-billing path: create a Checkout Session
 * for a (tenant, pack) purchase, and verify + parse the webhook Stripe calls
 * back on completion. No `stripe` SDK dependency: Checkout creation is one form
 * POST, and webhook verification is Stripe's documented HMAC-SHA256 scheme,
 * implemented here against `node:crypto` so it's exact and offline-testable.
 *
 * Server-side only (`node:crypto`, network) — billing never runs in the browser
 * engine.
 *
 * The signing scheme (https://stripe.com/docs/webhooks/signatures):
 *   header:  Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>...]
 *   signed:  `${t}.${rawBody}`  (the EXACT bytes Stripe sent — never re-serialize)
 *   check:   HMAC-SHA256(signed, whsec) === some v1, AND |now - t| <= tolerance
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Default replay window Stripe recommends (5 minutes). */
export const DEFAULT_TOLERANCE_SEC = 300;

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/** HMAC-SHA256 hex of `payload` under `secret` — the v1 signature Stripe computes. */
export function computeSignature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/** Parse a `t=..,v1=..,v1=..` Stripe-Signature header into its timestamp and v1 signatures. */
export function parseSignatureHeader(header: string): { t?: number; v1: string[] } {
  const out: { t?: number; v1: string[] } = { v1: [] };
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2);
    if (k === 't' && v && /^\d+$/.test(v.trim())) out.t = parseInt(v.trim(), 10);
    else if (k === 'v1' && v) out.v1.push(v.trim());
  }
  return out;
}

/** Constant-time hex-string compare (avoids leaking match position via timing). */
function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Verify a Stripe webhook signature against the RAW request body. Returns a
 * result rather than throwing so the caller can answer 400 with a reason.
 * `nowSec` is injectable for deterministic tests. Rejects: a malformed header,
 * a timestamp outside `toleranceSec`, or no matching v1 signature.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  opts: { toleranceSec?: number; nowSec?: number } = {},
): VerifyResult {
  if (!secret) return { ok: false, reason: 'no webhook secret configured' };
  if (!header) return { ok: false, reason: 'missing Stripe-Signature header' };
  const { t, v1 } = parseSignatureHeader(header);
  if (t === undefined) return { ok: false, reason: 'signature header has no timestamp' };
  if (!v1.length) return { ok: false, reason: 'signature header has no v1 signatures' };

  const tolerance = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > tolerance) return { ok: false, reason: 'timestamp outside tolerance (possible replay)' };

  const expected = computeSignature(`${t}.${rawBody}`, secret);
  // A signed request may carry several v1s (during a secret rotation); any match is valid.
  if (!v1.some((sig) => hexEqual(sig, expected))) return { ok: false, reason: 'no matching signature' };
  return { ok: true };
}

/** A minimal shape of the Stripe event fields fulfillment needs. */
export interface StripeCheckoutEvent {
  type: string;
  data?: { object?: { client_reference_id?: string | null; metadata?: Record<string, string | undefined> | null } };
}

/**
 * Pull the `(tenantKey, packId)` a completed checkout is fulfilling out of a
 * verified Stripe event, or `undefined` when the event isn't a completed
 * checkout or lacks the fields. We stamp both `client_reference_id` (tenantKey)
 * and `metadata.packId`/`metadata.tenantKey` at session creation, so either
 * source resolves the tenant.
 */
export function parseCheckoutCompleted(event: StripeCheckoutEvent): { tenantKey: string; packId: string } | undefined {
  if (event.type !== 'checkout.session.completed') return undefined;
  const obj = event.data?.object;
  if (!obj) return undefined;
  const tenantKey = obj.metadata?.tenantKey || obj.client_reference_id || '';
  const packId = obj.metadata?.packId || '';
  if (!tenantKey || !packId) return undefined;
  return { tenantKey, packId };
}

/** Injected so tests never hit the network; the real one is Node's global `fetch`. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface CheckoutParams {
  priceId: string;
  tenantKey: string;
  packId: string;
  successUrl: string;
  cancelUrl: string;
  /** 'payment' (one-time unlock) or 'subscription'. */
  mode?: 'payment' | 'subscription';
}

/**
 * Create a Stripe Checkout Session and return its hosted `url` (where the
 * client redirects the buyer) and `id`. Form-encodes exactly the fields Stripe
 * wants and stamps `client_reference_id` + `metadata` so the webhook can map
 * the completed payment back to the tenant and pack. Throws on a non-2xx from
 * Stripe, surfacing the error body.
 */
export async function createCheckoutSession(
  deps: { fetch: FetchLike; apiKey: string },
  params: CheckoutParams,
): Promise<{ id: string; url: string }> {
  if (!deps.apiKey) throw new Error('Stripe secret key not configured');
  const form = new URLSearchParams({
    mode: params.mode ?? 'payment',
    'line_items[0][price]': params.priceId,
    'line_items[0][quantity]': '1',
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    client_reference_id: params.tenantKey,
    'metadata[tenantKey]': params.tenantKey,
    'metadata[packId]': params.packId,
  });
  const res = await deps.fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${deps.apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Stripe checkout creation failed (${res.status}): ${text}`);
  const json = JSON.parse(text) as { id?: string; url?: string };
  if (!json.id || !json.url) throw new Error('Stripe checkout response missing id/url');
  return { id: json.id, url: json.url };
}
