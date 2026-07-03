/**
 * Provider registry / factory.
 *
 * Selection: LLM_PROVIDER=anthropic (or an anthropic.com base URL) picks the
 * native Anthropic adapter; everything else goes through the OpenAI-compatible
 * one. Register new backends here and the rest of the app picks them up
 * unchanged.
 */
import type { Config } from '../config.js';
import type { LLMProvider } from '../core/types.js';
import { buildProvider } from './factory.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

/** Node composition root: adapt the env-backed Config to the neutral factory. */
export function createProvider(config: Config): LLMProvider {
  return buildProvider({
    provider: config.llm.provider,
    baseUrl: config.llm.baseUrl,
    apiKey: config.llm.apiKey,
    embeddingsModel: config.llm.embeddingsModel,
  });
}

export { buildProvider, AnthropicProvider, OpenAICompatibleProvider };
export type { LlmProviderConfig } from './factory.js';
