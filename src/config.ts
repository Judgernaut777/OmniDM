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
  dataDir: string;
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
    dataDir: process.env.DATA_DIR || './data',
  };
}
