/**
 * OpenAI-compatible LLM provider.
 *
 * One adapter, many backends. Because OpenRouter, OpenAI, Ollama, LM Studio,
 * and most local inference servers all speak the OpenAI chat-completions
 * protocol, swapping between them is just a base-URL change — no new code.
 *
 * Default base URL is OpenRouter, which exposes hundreds of models (free + paid,
 * including Claude/GPT/Gemini) behind a single key, and whose /models endpoint
 * powers the in-app model dropdown for free.
 *
 * The converter pattern (canonical ChatMessage[] -> provider wire format) is the
 * idea borrowed from SillyTavern's prompt-converters.js. For OpenAI-shaped APIs
 * the conversion is the identity function; a future AnthropicProvider would put
 * the real converter here.
 */
import OpenAI from 'openai';
import type { CompletionRequest, LLMProvider, ModelInfo } from '../core/types.js';

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  /** Model for the /embeddings endpoint (EMBEDDINGS_MODEL). Empty = embeddings off. */
  embeddingsModel?: string;
  /**
   * Allow the OpenAI SDK to run in a browser. The SDK refuses to run client-side
   * unless this is set (keys in a browser are exposed to that page's JS) — which
   * for the in-app engine is intended: the user brings their OWN key, stored only
   * in app storage, and talks to the endpoint THEY configured. Defaults to
   * auto-detecting a browser global, so the Node path is unaffected.
   */
  allowBrowser?: boolean;
  /**
   * Override the HTTP transport handed to the OpenAI SDK. Undefined = the SDK's
   * built-in (global) fetch. The in-app engine injects a CapacitorHttp-backed
   * fetch on a native mobile WebView so requests run natively — bypassing the
   * WebView's CORS check for LLM hosts that don't send CORS headers.
   */
  fetchImpl?: typeof fetch;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id = 'openai-compatible';
  private client: OpenAI;
  private baseUrl: string;
  /** Defined only when an embeddings model is configured — callers feature-detect it. */
  embed?: (texts: string[]) => Promise<number[][]>;

  constructor(opts: OpenAICompatibleOptions) {
    this.baseUrl = opts.baseUrl;
    this.client = new OpenAI({
      baseURL: opts.baseUrl,
      apiKey: opts.apiKey || 'not-needed-for-local',
      // In a WebView the SDK runs client-side with the user's own key; opt in
      // explicitly. Auto-detect a browser so the Node server never sets it.
      dangerouslyAllowBrowser: opts.allowBrowser ?? typeof (globalThis as { window?: unknown }).window !== 'undefined',
      // On a native mobile WebView, route through CapacitorHttp (no CORS). Omit
      // when undefined so the SDK keeps its built-in fetch everywhere else.
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
      // OpenRouter appreciates these; harmless elsewhere.
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/your/omnidm',
        'X-Title': 'OmniDM',
      },
    });
    if (opts.embeddingsModel) {
      const model = opts.embeddingsModel;
      this.embed = async (texts) => {
        const res = await this.client.embeddings.create({ model, input: texts });
        return res.data.map((d) => d.embedding);
      };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await this.client.models.list();
      const models: ModelInfo[] = [];
      for (const m of res.data) {
        const id = m.id;
        models.push({ id, name: id, free: /:free$/i.test(id) });
      }
      // Free models first, then alphabetical — friendliest default ordering.
      models.sort((a, b) => Number(b.free) - Number(a.free) || a.id.localeCompare(b.id));
      return models;
    } catch (err) {
      console.warn(`[provider] could not list models from ${this.baseUrl}:`, (err as Error).message);
      return [];
    }
  }

  async complete(req: CompletionRequest): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.8,
      max_tokens: req.maxTokens ?? 800,
    });
    return res.choices[0]?.message?.content?.trim() ?? '';
  }
}
