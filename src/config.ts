import 'dotenv/config';

/** Central, validated configuration pulled from the environment. */
export interface Config {
  llm: {
    /** Backend selector: '' (auto) | 'anthropic'. Empty = OpenAI-compatible. */
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    /** Embeddings model for vector memory; '' (default) = lexical fallback. */
    embeddingsModel: string;
    /**
     * Global cap on concurrent in-flight provider calls (`complete`/`embed`),
     * server-wide — NOT per channel. Closes a cost/quota DoS: the per-channel
     * `ChannelLock` only serializes turns WITHIN one channel, so an attacker
     * opening many WebSocket connections under distinct channelIds could
     * otherwise drive unbounded parallel provider calls. See
     * `providers/concurrency-limited.ts`. `<= 0` disables the cap (unlimited).
     * Optional (rather than required) so the handful of other call sites that
     * build a minimal `Config` shape for a non-server context (e.g. the in-app
     * engine's `browser/local-engine.ts`, which never wraps its provider with
     * the limiter) aren't forced to plumb a field they don't use;
     * `loadConfig()` below always populates both from the environment.
     */
    maxConcurrency?: number;
    /** Max callers queued waiting for a slot before further calls fast-fail with a "server busy" error. */
    maxQueue?: number;
  };
  discord: {
    token: string;
  };
  slack: {
    botToken: string;
    appToken: string;
  };
  matrix: {
    homeserverUrl: string;
    accessToken: string;
  };
  mattermost: {
    url: string;
    token: string;
  };
  web: {
    /** Bind address. Loopback by default — expose only behind a reverse proxy with auth. */
    host: string;
    port: number;
    /** Optional shared password checked on the WebSocket hello; '' = open. */
    password: string;
  };
  dataDir: string;
  monetization: {
    /**
     * Self-host (default, false) unlocks every content pack/feature — there is
     * no billing today, so nothing should gate a self-hosted operator's own
     * game. A future hosted deployment sets this true to switch on the
     * (currently stub) hosted entitlements gate. See
     * `core/entitlements/entitlements.ts`.
     */
    hosted: boolean;
    /** Pack/feature ids explicitly unlocked for EVERY tenant when `hosted` is true; `'*'` unlocks everything. */
    unlockedPackIds: string[];
    /**
     * Per-tenant unlocks for a hosted deployment serving multiple
     * guilds/rooms from one process — keyed by `"<platform>:<channelId>"`
     * (see `entitlements.ts`'s `tenantKey`), e.g.
     * `{"discord:123456789012345678": ["frontier-outpost"]}`. This is what
     * lets an operator unlock a premium pack for the ONE guild/room that
     * paid without unlocking it for every other tenant the same process
     * serves — `unlockedPackIds` above is a process-wide fallback, this map
     * only adds unlocks for specific tenants. See `core/entitlements/entitlements.ts`.
     */
    tenantUnlockedPackIds: Record<string, string[]>;
  };
  /**
   * Stripe hosted-billing config. Off unless `enabled` (and a secret key) is
   * set — self-host never needs it. When on, the web adapter mounts the billing
   * endpoints (`/billing/checkout`, `/billing/webhook`, `/billing/status`) and
   * a paid checkout unlocks a premium pack for the buying tenant via the
   * persistent purchase store. See `core/billing/`.
   */
  billing: {
    enabled: boolean;
    /** Stripe secret key (`sk_...`). */
    secretKey: string;
    /** Stripe webhook signing secret (`whsec_...`) — verifies the fulfillment callback. */
    webhookSecret: string;
    /** Map of premium pack id → Stripe Price id (`{"frontier-outpost":"price_123"}`). */
    prices: Record<string, string>;
    /** Where Stripe redirects after a successful / cancelled checkout. */
    successUrl: string;
    cancelUrl: string;
    /** 'payment' (one-time unlock, default) or 'subscription'. */
    mode: 'payment' | 'subscription';
    /** File the purchase store persists unlocks to (under the data dir by default). */
    storeFile: string;
  };
}

export function loadConfig(): Config {
  return {
    llm: {
      provider: process.env.LLM_PROVIDER || '',
      baseUrl: process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1',
      // ANTHROPIC_API_KEY is accepted as an alias for the native Anthropic provider.
      apiKey: process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY || '',
      model: process.env.LLM_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
      embeddingsModel: process.env.EMBEDDINGS_MODEL || '',
      // NOT the `Number(x) || default` pattern used elsewhere in this file (e.g.
      // WEB_PORT) — that treats an explicit "0" as "unset", but here 0 (and any
      // <= 0 value) is a meaningful, deliberate "disable the cap" setting that
      // must survive parsing rather than being silently overridden.
      maxConcurrency: parseIntEnv(process.env.LLM_MAX_CONCURRENCY, 8),
      maxQueue: parseIntEnv(process.env.LLM_MAX_QUEUE, 64),
    },
    discord: {
      token: process.env.DISCORD_TOKEN || '',
    },
    slack: {
      botToken: process.env.SLACK_BOT_TOKEN || '',
      appToken: process.env.SLACK_APP_TOKEN || '',
    },
    matrix: {
      homeserverUrl: process.env.MATRIX_HOMESERVER_URL || '',
      accessToken: process.env.MATRIX_ACCESS_TOKEN || '',
    },
    mattermost: {
      url: process.env.MATTERMOST_URL || '',
      token: process.env.MATTERMOST_TOKEN || '',
    },
    web: {
      host: process.env.WEB_HOST || '127.0.0.1',
      port: Number(process.env.WEB_PORT) || 8787,
      password: process.env.WEB_PASSWORD || '',
    },
    dataDir: process.env.DATA_DIR || './data',
    monetization: {
      hosted: /^(1|true)$/i.test(process.env.OMNIDM_HOSTED_TIER || ''),
      unlockedPackIds: (process.env.OMNIDM_UNLOCKED_PACKS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      tenantUnlockedPackIds: parseTenantUnlockedPacks(process.env.OMNIDM_TENANT_UNLOCKED_PACKS),
    },
    billing: {
      enabled: /^(1|true)$/i.test(process.env.STRIPE_BILLING_ENABLED || '') && Boolean(process.env.STRIPE_SECRET_KEY),
      secretKey: process.env.STRIPE_SECRET_KEY || '',
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
      prices: parseStripePrices(process.env.STRIPE_PRICES),
      successUrl: process.env.STRIPE_SUCCESS_URL || 'http://localhost:8787/?checkout=success',
      cancelUrl: process.env.STRIPE_CANCEL_URL || 'http://localhost:8787/?checkout=cancel',
      mode: process.env.STRIPE_MODE === 'subscription' ? 'subscription' : 'payment',
      storeFile: process.env.STRIPE_STORE_FILE || `${process.env.DATA_DIR || './data'}/purchases.json`,
    },
  };
}

/**
 * Parses an integer env var, falling back to `def` only when the var is unset,
 * empty, or not a finite number — unlike the `Number(x) || def` shorthand used
 * elsewhere in this file, this does NOT treat an explicitly-set `"0"` (or a
 * negative value) as "unset", since callers here rely on 0/negative being a
 * meaningful sentinel (see `llm.maxConcurrency`/`llm.maxQueue` above).
 */
function parseIntEnv(raw: string | undefined, def: number): number {
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

/** Parse `STRIPE_PRICES` — a JSON object mapping pack id → Stripe Price id. Malformed = no prices. */
function parseStripePrices(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [packId, priceId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof priceId === 'string' && priceId) out[packId] = priceId;
    }
    return out;
  } catch {
    console.warn('[config] STRIPE_PRICES is not valid JSON — ignoring (no packs purchasable)');
    return {};
  }
}

/**
 * Parses `OMNIDM_TENANT_UNLOCKED_PACKS` — a JSON object mapping
 * `"<platform>:<channelId>"` to an array of unlocked pack/feature ids, e.g.
 * `{"discord:123456789012345678":["frontier-outpost"]}`. Malformed or absent
 * input is treated as "no per-tenant unlocks" rather than crashing boot —
 * this is operator-supplied config, not untrusted player input, but a typo
 * shouldn't take the whole process down.
 */
function parseTenantUnlockedPacks(raw: string | undefined): Record<string, string[]> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [tenant, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) out[tenant] = ids as string[];
    }
    return out;
  } catch {
    console.warn('[config] OMNIDM_TENANT_UNLOCKED_PACKS is not valid JSON — ignoring (no per-tenant unlocks applied)');
    return {};
  }
}
