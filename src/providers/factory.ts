/**
 * Provider factory — environment-neutral.
 *
 * Builds the right LLMProvider from a plain config object, in Node OR a browser.
 * It deliberately does NOT import ../config.js (which pulls in dotenv/process),
 * so the in-app engine can construct a provider from settings the user typed
 * into the app without dragging Node config machinery into the bundle. The Node
 * composition root (./index.ts) adapts its `Config` to this shape.
 *
 * SECURITY: `apiKey` is the user's secret. This factory only hands it to the SDK
 * / fetch wrapper that talks to `baseUrl`; it is never logged or persisted here.
 */
import type { LLMProvider } from '../core/types.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

export interface LlmProviderConfig {
  /** Backend selector: '' (auto) | 'anthropic'. Empty = OpenAI-compatible. */
  provider?: string;
  baseUrl: string;
  apiKey: string;
  /** Embeddings model for vector memory; '' / undefined = lexical fallback. */
  embeddingsModel?: string;
  /**
   * Force the OpenAI SDK's browser mode on/off. Undefined = auto-detect. Set true
   * for the in-app engine (the user brings their own key).
   */
  allowBrowser?: boolean;
}

/** Build the provider a config selects — native Anthropic, else OpenAI-compatible. */
export function buildProvider(cfg: LlmProviderConfig): LLMProvider {
  const isAnthropic = cfg.provider === 'anthropic' || cfg.baseUrl.includes('anthropic.com');
  if (isAnthropic) {
    return new AnthropicProvider({
      apiKey: cfg.apiKey,
      // Only honor an explicit base URL when it actually points at Anthropic;
      // otherwise it's the leftover OpenRouter default and the provider's own
      // default applies.
      baseUrl: cfg.baseUrl.includes('anthropic.com') ? cfg.baseUrl : undefined,
    });
  }
  return new OpenAICompatibleProvider({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    embeddingsModel: cfg.embeddingsModel,
    allowBrowser: cfg.allowBrowser,
  });
}
