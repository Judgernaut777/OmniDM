/**
 * Provider registry / factory.
 *
 * Today there's one provider (OpenAI-compatible). When you add a native
 * Anthropic adapter or others, register them here and the rest of the app
 * picks them up unchanged.
 */
import type { Config } from '../config.js';
import type { LLMProvider } from '../core/types.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

export function createProvider(config: Config): LLMProvider {
  // A real multi-provider build would switch on a config field here.
  return new OpenAICompatibleProvider({
    baseUrl: config.llm.baseUrl,
    apiKey: config.llm.apiKey,
  });
}

export { OpenAICompatibleProvider };
