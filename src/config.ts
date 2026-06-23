import 'dotenv/config';

/** Central, validated configuration pulled from the environment. */
export interface Config {
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  discord: {
    token: string;
  };
  dataDir: string;
}

export function loadConfig(): Config {
  return {
    llm: {
      baseUrl: process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1',
      apiKey: process.env.LLM_API_KEY || '',
      model: process.env.LLM_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
    },
    discord: {
      token: process.env.DISCORD_TOKEN || '',
    },
    dataDir: process.env.DATA_DIR || './data',
  };
}
