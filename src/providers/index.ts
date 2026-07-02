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
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

export function createProvider(config: Config): LLMProvider {
  const isAnthropic =
    config.llm.provider === 'anthropic' || config.llm.baseUrl.includes('anthropic.com');
  if (isAnthropic) {
    return new AnthropicProvider({
      apiKey: config.llm.apiKey,
      // Only honor LLM_BASE_URL when it actually points at Anthropic; otherwise
      // it's the leftover OpenRouter default and the provider's own default applies.
      baseUrl: config.llm.baseUrl.includes('anthropic.com') ? config.llm.baseUrl : undefined,
    });
  }
  return new OpenAICompatibleProvider({
    baseUrl: config.llm.baseUrl,
    apiKey: config.llm.apiKey,
  });
}

export { AnthropicProvider, OpenAICompatibleProvider };
