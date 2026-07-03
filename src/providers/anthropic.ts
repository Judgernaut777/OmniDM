/**
 * Native Anthropic LLM provider.
 *
 * Talks to the Anthropic Messages API (POST /v1/messages) directly with the
 * built-in fetch — no SDK dependency. This is the "real converter" the
 * OpenAI-compatible adapter's header alludes to: Anthropic wants system text
 * in a top-level `system` parameter and a strictly alternating user/assistant
 * `messages` array starting with `user`, so `convertToAnthropic` reshapes the
 * canonical ChatMessage[] accordingly (SillyTavern's prompt-converter pattern).
 *
 * Sampling params are deliberately not sent: current Claude models
 * (Sonnet 5 / Opus 4.8) reject `temperature` with a 400.
 */
import type { ChatMessage, CompletionRequest, LLMProvider, ModelInfo } from '../core/types.js';

const API_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';

/** Anthropic's known chat models. The API has no public /models list. */
const MODELS: ModelInfo[] = [
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', free: false },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', free: false },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', free: false },
];

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AnthropicRequestShape {
  system: string;
  messages: AnthropicMessage[];
}

/**
 * Convert canonical ChatMessage[] to the Anthropic wire shape (pure).
 * System messages are concatenated into the top-level `system` string;
 * consecutive same-role turns are merged (Anthropic requires alternation);
 * a placeholder user turn is inserted if the conversation would otherwise
 * start with `assistant`.
 */
export function convertToAnthropic(messages: ChatMessage[]): AnthropicRequestShape {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');

  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (out.length === 0 && m.role === 'assistant') {
      out.push({ role: 'user', content: '(continue)' });
    }
    const last = out.at(-1);
    if (last && last.role === m.role) {
      last.content += `\n\n${m.content}`;
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return { system, messages: out };
}

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;
}

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic';
  private apiKey: string;
  private baseUrl: string;

  constructor(opts: AnthropicOptions) {
    this.apiKey = opts.apiKey;
    // Tolerate a base URL given with a trailing slash or /v1 suffix.
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '').replace(/\/v1$/, '');
  }

  async listModels(): Promise<ModelInfo[]> {
    return MODELS;
  }

  /** Session-model fallback when a save carries an id from another backend. */
  readonly defaultModel = MODELS[0].id;

  /** Anthropic serves claude-* ids only (incl. dated variants beyond MODELS). */
  supportsModel(modelId: string): boolean {
    return /^claude-/.test(modelId);
  }

  async complete(req: CompletionRequest): Promise<string> {
    const { system, messages } = convertToAnthropic(req.messages);
    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens ?? 800,
        ...(system ? { system } : {}),
        messages,
      }),
    });
    if (!res.ok) {
      throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    return (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
      .trim();
  }
}
