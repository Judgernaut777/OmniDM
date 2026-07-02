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
