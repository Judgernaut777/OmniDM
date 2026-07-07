/**
 * Smoke cases — Stripe hosted billing (signature, store, handler, mount). Self-contained (each section builds its own
 * Bot/provider/storage), so it lifts cleanly out of the monolith.
 */
import { promises as fs } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import type { Config } from '../../config.js';
import type { CompletionRequest, GameSession, IncomingMessage, LLMProvider, ModelInfo, OutgoingMessage, TurnRecord } from '../../core/types.js';
import { Bot, redactSecrets, SERVER_TURN_FAILURE_TEXT } from '../../core/bot.js';
import { roll, extractRolls } from '../../core/engine/dice.js';
import { MAX_CHARACTER_NAME_CHARS, SeatTakenError, SessionManager } from '../../core/session/session-manager.js';
import { NodeFileStorage } from '../../core/session/store.js';
import { MemoryStorage } from '../../core/session/storage.js';
import { loadCard, MAX_CARD_BYTES, renderCard } from '../../core/cards/card.js';
import { buildWorldInfo, makeEntry } from '../../core/lore/lorebook.js';
import { splitFog } from '../../core/narrator/fog.js';
import { cosine, MAX_MEMORIES, MemoryRetriever } from '../../core/memory/retrieval.js';
import { AnthropicProvider, convertToAnthropic } from '../../providers/anthropic.js';
import { OpenAICompatibleProvider } from '../../providers/openai-compatible.js';
import { SlackAdapter } from '../../adapters/slack.js';
import { MatrixAdapter } from '../../adapters/matrix.js';
import { MattermostAdapter } from '../../adapters/mattermost.js';
import { CliAdapter } from '../../adapters/cli.js';
import { DiscordAdapter } from '../../adapters/discord.js';
import { Events, type Client } from 'discord.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { pickAdapter, parseAdapterArg } from '../../index.js';
import { MAX_CARD_SUMMARY_CHARS, MAX_FRAME_BYTES, MAX_NAME_CHARS, MAX_PORTRAIT_BYTES, MAX_TEXT_CHARS, RATE_LIMIT_PER_SEC, UNJOINED_FRAMES_PER_SEC, WebAdapter } from '../../adapters/web.js';
import { MAX_BIO_CHARS, PORTRAIT_PRESETS, resolvePresetId } from '../../core/portraits.js';
import { BUNDLED_RULES, bundledRulesProvider, clearRuntimeRules, registerRulesModule } from '../../core/rules/registry.js';
import { CONDITIONS, conditionDef, describeConditions, normalizeCondition } from '../../core/rules/conditions.js';
import { BESTIARY, findStatBlock, listBestiary, statBlockLine } from '../../core/rules/statblock.js';
import { addMonster, advanceCombat, currentCombatant, endCombat, findMonsterCombatant, isOutOfFight, livingSides, removeMonster, startCombat, summarizeCombat } from '../../core/rules/combat.js';
import { applyHpDelta, clearCondition, findTarget, setCondition } from '../../core/rules/mechanics.js';
import { validateContentPack, parseContentPackJson, ContentPackError } from '../../core/content-packs/validate.js';
import { isPackLockedForDisplay, loadContentPack, PackLockedError } from '../../core/content-packs/loader.js';
import { BUNDLED_CONTENT_PACKS, getBundledContentPack, listBundledContentPacks } from '../../core/content-packs/registry.js';
import { FRONTIER_OUTPOST_PACK_JSON } from '../../core/content-packs/bundled-sources.js';
import { loadContentPackFile } from '../../core/content-packs/node.js';
import { createHostedEntitlements, selectEntitlements, selfHostEntitlements, tenantKey } from '../../core/entitlements/entitlements.js';
import { applyGrant, MemoryPurchaseStore } from '../../core/billing/purchase-store.js';
import { FilePurchaseStore } from '../../core/billing/store-node.js';
import { computeSignature, createCheckoutSession, parseCheckoutCompleted, verifyStripeSignature } from '../../core/billing/stripe.js';
import { createBillingHandler, isBillingPath, type BillingHttpRequest } from '../../core/billing/handler.js';
import { base64ToBytes, bytesToBase64 } from '../../core/cards/card-parse.js';
import { loadCardFromBytes } from '../../core/cards/card-browser.js';
import { BrowserSessionStorage, webStorageKeyValue, type AsyncKeyValue, type WebStorageLike } from '../../core/session/browser-storage.js';
import { buildProvider } from '../../providers/factory.js';
import { RoomEngine, type Frame as RoomFrame, type RoomConnection } from '../../core/room/room-engine.js';
import { createLocalEngine } from '../../browser/local-engine.js';
import { isCapacitorNative, getCapacitorHttp, makeNativeFetch, selectFetch, type CapacitorHttpLike } from '../../browser/native-http.js';
import { check, skip, MockProvider, Suite, WsClient, WEB_ROOT } from '../harness.js';
import type { SmokeCtx } from '../context.js';

export function registerBilling(suite: Suite, ctx: SmokeCtx): void {
  const { dataDir } = ctx;

  suite.section("Billing: Stripe webhook signature verification (spec-correct, offline)", async () => {
  // ── Billing: Stripe signature verification ──
  {
    const secret = 'whsec_test_secret';
    const t = 1_700_000_000;
    const raw = JSON.stringify({ type: 'checkout.session.completed', data: { object: { metadata: { tenantKey: 'web:room1', packId: 'frontier-outpost' } } } });
    const sig = computeSignature(`${t}.${raw}`, secret);
    const header = `t=${t},v1=${sig}`;

    check('billing: a correctly-signed payload verifies within tolerance', verifyStripeSignature(raw, header, secret, { nowSec: t }).ok);
    check('billing: verification supports multiple v1 signatures (secret rotation)',
      verifyStripeSignature(raw, `t=${t},v1=deadbeef,v1=${sig}`, secret, { nowSec: t }).ok);
    const wrongSecret = verifyStripeSignature(raw, header, 'whsec_other', { nowSec: t });
    check('billing: a wrong signing secret is rejected', !wrongSecret.ok);
    const tampered = verifyStripeSignature(raw + ' ', header, secret, { nowSec: t });
    check('billing: a tampered body (signature no longer matches) is rejected', !tampered.ok);
    const stale = verifyStripeSignature(raw, header, secret, { nowSec: t + 10_000 });
    check('billing: a timestamp outside tolerance is rejected (replay defense)', !stale.ok && /tolerance/.test((stale as { reason: string }).reason));
    check('billing: a missing header is rejected', !verifyStripeSignature(raw, undefined, secret, { nowSec: t }).ok);
    check('billing: an empty secret is rejected (never verifies by default)', !verifyStripeSignature(raw, header, '', { nowSec: t }).ok);

    // Event parsing pulls (tenantKey, packId) only from a completed checkout.
    const parsed = parseCheckoutCompleted(JSON.parse(raw));
    check('billing: parseCheckoutCompleted extracts tenantKey + packId', parsed?.tenantKey === 'web:room1' && parsed?.packId === 'frontier-outpost');
    check('billing: parseCheckoutCompleted ignores client_reference_id fallback vs missing metadata',
      parseCheckoutCompleted({ type: 'checkout.session.completed', data: { object: { client_reference_id: 'web:room2', metadata: { packId: 'frontier-outpost' } } } })?.tenantKey === 'web:room2');
    check('billing: parseCheckoutCompleted ignores non-checkout events', parseCheckoutCompleted({ type: 'payment_intent.succeeded' }) === undefined);
  }

  });
  suite.section("Billing: purchase store (memory + durable file) drives the entitlements gate", async () => {
  // ── Billing: purchase store ──
  {
    // applyGrant idempotence.
    const rec: Record<string, string[]> = {};
    check('billing: applyGrant records a new unlock and is idempotent',
      applyGrant(rec, 'web:r1', 'frontier-outpost') === true && applyGrant(rec, 'web:r1', 'frontier-outpost') === false && rec['web:r1'].length === 1);

    // MemoryPurchaseStore: grant → sync read.
    const mem = new MemoryPurchaseStore();
    check('billing: a fresh store has nothing unlocked', !mem.isUnlocked('web:r1', 'frontier-outpost'));
    await mem.grant('web:r1', 'frontier-outpost');
    check('billing: grant unlocks for exactly that tenant, not others',
      mem.isUnlocked('web:r1', 'frontier-outpost') && !mem.isUnlocked('web:r2', 'frontier-outpost') && mem.list('web:r1').includes('frontier-outpost'));

    // FilePurchaseStore persists across instances (a restart).
    const pfile = path.join(dataDir, 'purchases-test.json');
    await fs.rm(pfile, { force: true });
    const fstore = await new FilePurchaseStore(pfile).load();
    await fstore.grant('web:paid', 'frontier-outpost');
    const reloaded = await new FilePurchaseStore(pfile).load();
    check('billing: a durable file store round-trips a grant across a restart', reloaded.isUnlocked('web:paid', 'frontier-outpost'));

    // The entitlements gate consults the live store: locked before a grant, unlocked after.
    const store = new MemoryPurchaseStore();
    const ent = createHostedEntitlements({ enforcePremium: true, isPurchased: (tk, key) => store.isUnlocked(tk, key) });
    const scope = { platform: 'web', channelId: 'buyer' };
    check('billing: hosted gate locks a premium pack for an unpaid tenant', !ent.isUnlocked('frontier-outpost', scope));
    await store.grant(tenantKey(scope), 'frontier-outpost');
    check('billing: the SAME gate unlocks it the instant the purchase lands (no redeploy)', ent.isUnlocked('frontier-outpost', scope));
    check('billing: the paid unlock is scoped to the paying tenant only', !ent.isUnlocked('frontier-outpost', { platform: 'web', channelId: 'freeloader' }));

    // A loaded premium pack actually installs once the store unlocks it.
    const premiumPack = getBundledContentPack('frontier-outpost');
    if (premiumPack) {
      const paidSession: GameSession = { id: 'p', platform: 'web', channelId: 'buyer', systemId: 'dnd5e', model: 'm', players: {}, npcs: [], lorebook: [], history: [], summary: '', memories: [], turnMode: 'immediate', turnIndex: 0, fogOfWar: false, createdAt: 0 };
      let threw = false;
      try { loadContentPack(premiumPack, paidSession, ent); } catch { threw = true; }
      check('billing: a premium pack loads for a tenant once their purchase is recorded', !threw && paidSession.lorebook.length > 0);
    }

    // selectEntitlements threads the store through for a hosted deployment.
    const selStore = new MemoryPurchaseStore();
    const selEnt = selectEntitlements({ hosted: true }, selStore);
    check('billing: selectEntitlements wires the purchase store into a hosted gate', !selEnt.isUnlocked('frontier-outpost', scope));
    await selStore.grant(tenantKey(scope), 'frontier-outpost');
    check('billing: ...and honors a grant made through it', selEnt.isUnlocked('frontier-outpost', scope));
  }

  });
  suite.section("Billing: HTTP handler (checkout + webhook fulfillment, no network)", async () => {
  // ── Billing: HTTP handler ──
  {
    const secret = 'whsec_handler';
    const t = 1_700_000_500;
    const store = new MemoryPurchaseStore();
    const fetchCalls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
    const fakeFetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      fetchCalls.push({ url, init });
      return { ok: true, status: 200, async text() { return JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/pay/cs_test_1' }); } };
    };
    const handler = createBillingHandler({
      store,
      prices: { 'frontier-outpost': 'price_abc123' },
      apiKey: 'sk_test_key',
      webhookSecret: secret,
      successUrl: 'http://app/ok',
      cancelUrl: 'http://app/no',
      fetch: fakeFetch,
      nowSec: () => t,
    });
    const req = (over: Partial<BillingHttpRequest>): BillingHttpRequest => ({ method: 'POST', pathname: '/billing/checkout', headers: {}, rawBody: '', query: {}, ...over });

    check('billing: isBillingPath matches the three endpoints only',
      isBillingPath('/billing/checkout') && isBillingPath('/billing/webhook') && isBillingPath('/billing/status') && !isBillingPath('/billing/other') && !isBillingPath('/'));

    // Checkout: a valid request creates a Stripe session and returns its URL.
    const coRes = await handler(req({ pathname: '/billing/checkout', rawBody: JSON.stringify({ platform: 'web', channelId: 'room9', packId: 'frontier-outpost' }) }));
    const coBody = JSON.parse(coRes.body);
    check('billing: POST /billing/checkout returns the Stripe checkout URL', coRes.status === 200 && coBody.url === 'https://checkout.stripe.com/pay/cs_test_1');
    check('billing: checkout POSTed to Stripe with the price, tenant metadata, and Bearer key',
      fetchCalls.length === 1 && fetchCalls[0].url.includes('checkout/sessions') &&
      fetchCalls[0].init.headers.Authorization === 'Bearer sk_test_key' &&
      fetchCalls[0].init.body.includes('price_abc123') && fetchCalls[0].init.body.includes('web%3Aroom9'));

    // Checkout: an unknown / unpriced pack is refused (no Stripe call).
    const unknown = await handler(req({ pathname: '/billing/checkout', rawBody: JSON.stringify({ platform: 'web', channelId: 'room9', packId: 'no-such-pack' }) }));
    check('billing: checkout 404s an unpurchasable pack', unknown.status === 404 && fetchCalls.length === 1);
    const missing = await handler(req({ pathname: '/billing/checkout', rawBody: JSON.stringify({ platform: 'web' }) }));
    check('billing: checkout 400s on missing fields', missing.status === 400);

    // Webhook: a correctly-signed completed checkout grants the unlock.
    const evtBody = JSON.stringify({ type: 'checkout.session.completed', data: { object: { metadata: { tenantKey: 'web:room9', packId: 'frontier-outpost' } } } });
    const sig = computeSignature(`${t}.${evtBody}`, secret);
    const whRes = await handler(req({ pathname: '/billing/webhook', headers: { 'stripe-signature': `t=${t},v1=${sig}` }, rawBody: evtBody }));
    check('billing: POST /billing/webhook fulfills a signed completed checkout', whRes.status === 200 && JSON.parse(whRes.body).fulfilled === true);
    check('billing: fulfillment recorded the unlock in the store', store.isUnlocked('web:room9', 'frontier-outpost'));

    // Webhook: a bad signature is rejected and grants nothing.
    const badWh = await handler(req({ pathname: '/billing/webhook', headers: { 'stripe-signature': `t=${t},v1=deadbeef` }, rawBody: evtBody }));
    check('billing: an unsigned/forged webhook is refused with 400', badWh.status === 400);
    check('billing: a forged webhook grants nothing new', !store.isUnlocked('web:forged', 'frontier-outpost'));

    // Webhook: a verified but unhandled event type is ACKed 200 (so Stripe won't retry).
    const otherEvt = JSON.stringify({ type: 'invoice.paid', data: { object: {} } });
    const otherSig = computeSignature(`${t}.${otherEvt}`, secret);
    const otherRes = await handler(req({ pathname: '/billing/webhook', headers: { 'stripe-signature': `t=${t},v1=${otherSig}` }, rawBody: otherEvt }));
    check('billing: a verified but ignored event is ACKed 200 (no Stripe retry storm)', otherRes.status === 200 && JSON.parse(otherRes.body).fulfilled === false);

    // Checkout: an already-owned pack short-circuits (don't charge twice).
    const owned = await handler(req({ pathname: '/billing/checkout', rawBody: JSON.stringify({ platform: 'web', channelId: 'room9', packId: 'frontier-outpost' }) }));
    check('billing: checkout for an already-unlocked pack short-circuits without a Stripe call', JSON.parse(owned.body).alreadyUnlocked === true && fetchCalls.length === 1);

    // Status: reports a tenant's unlocks.
    const status = await handler(req({ method: 'GET', pathname: '/billing/status', query: { platform: 'web', channelId: 'room9' } }));
    check('billing: GET /billing/status lists a tenant\'s unlocked packs', status.status === 200 && JSON.parse(status.body).unlocked.includes('frontier-outpost'));
  }

  });
  suite.section("Billing: mounted on the web adapter over a real loopback socket", async () => {
  // ── Billing: web adapter mount ── (proves the raw-body read + routing, end to end)
  {
    const secret = 'whsec_loopback';
    const t = Math.floor(Date.now() / 1000); // real clock so the live handler's tolerance passes
    const store = new MemoryPurchaseStore();
    const handler = createBillingHandler({
      store, prices: { 'frontier-outpost': 'price_lb' }, apiKey: 'sk_lb', webhookSecret: secret,
      successUrl: 'http://app/ok', cancelUrl: 'http://app/no',
      fetch: async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ id: 'cs', url: 'http://pay' }); } }),
    });
    const adapter = new WebAdapter('127.0.0.1', 0, '', undefined, undefined, undefined, handler);
    await adapter.start();
    try {
      const base = `http://127.0.0.1:${adapter.port}`;
      const evt = JSON.stringify({ type: 'checkout.session.completed', data: { object: { metadata: { tenantKey: 'web:lb', packId: 'frontier-outpost' } } } });
      const sig = computeSignature(`${t}.${evt}`, secret);
      const whRes = await fetch(`${base}/billing/webhook`, { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${sig}`, 'content-type': 'application/json' }, body: evt });
      check('billing: the web adapter forwards a signed webhook to the handler and it fulfills (200)', whRes.status === 200);
      check('billing: the loopback webhook actually granted the unlock in the store', store.isUnlocked('web:lb', 'frontier-outpost'));

      const stRes = await fetch(`${base}/billing/status?platform=web&channelId=lb`);
      const stBody = await stRes.json();
      check('billing: GET /billing/status over loopback reflects the unlock', stRes.status === 200 && stBody.unlocked.includes('frontier-outpost'));

      const forged = await fetch(`${base}/billing/webhook`, { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=beef`, 'content-type': 'application/json' }, body: evt });
      check('billing: a forged webhook over loopback is refused with 400', forged.status === 400);
    } finally {
      await adapter.stop();
    }

    // With no handler injected, the billing paths 404 like any unknown route.
    const bare = new WebAdapter('127.0.0.1', 0, '', undefined, undefined, undefined, undefined);
    await bare.start();
    try {
      const res = await fetch(`http://127.0.0.1:${bare.port}/billing/checkout`, { method: 'POST', body: '{}' });
      check('billing: a web adapter with billing disabled 404s /billing/*', res.status === 404);
    } finally {
      await bare.stop();
    }
  }

  });
}
