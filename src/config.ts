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
    /** Pack/feature ids explicitly unlocked when `hosted` is true; `'*'` unlocks everything. */
    unlockedPackIds: string[];
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
    },
  };
}
