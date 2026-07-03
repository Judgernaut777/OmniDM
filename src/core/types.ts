/**
 * Canonical domain types shared across every layer.
 *
 * The whole design hinges on these being platform- and provider-neutral:
 * adapters translate Discord/CLI/etc. into `IncomingMessage`, the engine works
 * only in these terms, and providers translate `ChatMessage[]` to whatever the
 * model API wants. Nothing below the adapter layer knows what "Discord" is.
 */

import type { CharacterCard, Portrait } from './cards/card-parse.js';
import type { LoreEntry } from './lore/lorebook.js';
import type { MemoryRecord } from './memory/retrieval.js';

// ─── Messaging (platform-neutral) ────────────────────────────────────────────

/** A normalized inbound message from any chat platform. */
export interface IncomingMessage {
  platform: string;       // "discord" | "cli" | ...
  channelId: string;      // platform room/channel — maps 1:1 to a game session
  userId: string;         // stable per-platform user id
  userName: string;       // display name
  text: string;           // raw text the user typed
  raw?: unknown;          // original platform payload, if an adapter needs it
}

/**
 * A resolved dice roll, surfaced to RICH adapters (e.g. web) so a UI can animate
 * the real roll. Text adapters ignore it entirely — the dice outcome is already
 * inside `text`. Every value is the engine's deterministic result carried
 * straight through; adapters MUST NOT re-roll. `total === sum(dice) + modifier`.
 */
export interface OutgoingRoll {
  notation: string;   // "d20+5"
  dice: number[];     // the individual faces that count toward the total
  modifier?: number;  // flat modifier folded into the total (total − sum(dice))
  total: number;      // the engine's authoritative total
  actor: string;      // who rolled — character or player name
  note?: string;      // "advantage" | "CRITICAL HIT (nat 20)" | "kept kh3" | …
}

/** A normalized outbound message. Adapters render this for their platform. */
export interface OutgoingMessage {
  channelId: string;
  text: string;
  /** Optional speaker label, e.g. "Dungeon Master" or an NPC name. */
  speaker?: string;
  /** If set, deliver privately to this user only (fog-of-war whisper). */
  targetUserId?: string;
  /** Display name for the target, so adapters can label the whisper. */
  targetUserName?: string;
  /**
   * Structured dice this narration resolved, freshest deterministic result from
   * the turn engine. OPTIONAL and only set on public DM narration that included
   * a roll; text adapters ignore it, rich adapters emit a roll event per entry.
   */
  rolls?: OutgoingRoll[];
}

/**
 * The contract every chat platform implements. This interface IS the moat:
 * add a platform by writing one of these; the engine never changes.
 */
export interface PlatformAdapter {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Deliver a message. When `msg.targetUserId` is set, deliver it privately
   * to that user (CLI: a "(whisper to …)" line; Discord: a DM — if the DM is
   * refused, adapters must post a content-free notice, never the secret).
   */
  send(msg: OutgoingMessage): Promise<void>;
  /** Register the single handler the bot core uses to receive messages. */
  onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): void;
}

// ─── LLM provider (model-neutral) ────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelInfo {
  id: string;
  name?: string;
  /** True if the model is free to call (e.g. OpenRouter ":free" models). */
  free?: boolean;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

/** The contract every model backend implements (OpenAI-compatible, Anthropic, …). */
export interface LLMProvider {
  readonly id: string;
  /** Powers the in-app model dropdown. May return [] if the backend can't list. */
  listModels(): Promise<ModelInfo[]>;
  complete(req: CompletionRequest): Promise<string>;
  /**
   * Optional: whether this backend can serve a model id. Undefined = accepts
   * any id. Lets the session layer remap models persisted under a different
   * backend (e.g. an OpenRouter id after switching to the Anthropic provider).
   */
  supportsModel?(modelId: string): boolean;
  /** Optional: this backend's own fallback model for the remap above. */
  defaultModel?: string;
  /**
   * Optional embeddings backend (OpenAI-compatible /embeddings endpoint).
   * Left undefined when not configured — callers feature-detect it and fall
   * back to lexical scoring for vector memory.
   */
  embed?(texts: string[]): Promise<number[][]>;
}

// ─── Game domain ─────────────────────────────────────────────────────────────

export interface Player {
  userId: string;
  userName: string;
  characterName?: string;
  hp?: number;
  maxHp?: number;
  /**
   * The character's D&D 5e class id (`/dm class <name>`), one of the 12 preset
   * ids. Absent-safe — old sessions have none. May equal the portrait preset id.
   */
  class?: string;
  /**
   * A short, optional character bio/persona (`/dm bio <text>`) — a lightweight
   * stand-in for players who don't import a full Character Card. Absent-safe.
   */
  bio?: string;
  /** Imported Character Card persona (`/dm import`), if any. */
  card?: CharacterCard;
  /**
   * The player's portrait: a preset id (`/dm portrait <id>`) or stored image
   * bytes (an upload). Absent-safe — old sessions have none. When unset, the
   * imported card's own portrait (if any) is used as a fallback.
   */
  portrait?: Portrait;
}

export interface RollResult {
  by: string;          // character or player name
  notation: string;    // "d20+5"
  rolls: number[];
  total: number;
  note?: string;       // "CRITICAL HIT (nat 20)" etc.
}

export interface TurnRecord {
  /** What the players did this turn. */
  actions: { name: string; text: string }[];
  /** Dice resolved deterministically BEFORE narration. */
  rolls: RollResult[];
  /** The DM's narration of the resolved outcome. */
  narration: string;
  ts: number;
}

/**
 * How player actions are sequenced. 'immediate': every message is a turn.
 * 'round-robin': players act one at a time, in join order, wrapping around.
 */
export type TurnMode = 'immediate' | 'round-robin';

export interface GameSession {
  id: string;
  platform: string;
  channelId: string;
  systemId: string;                  // rules module, e.g. "dnd5e"
  model: string;                     // selected model id (overrides default)
  players: Record<string, Player>;   // keyed by userId; insertion order = join order
  npcs: CharacterCard[];             // imported NPC cards, played by the DM
  lorebook: LoreEntry[];             // keyword-triggered world info (`/dm lore …`)
  history: TurnRecord[];             // recent verbatim turns
  summary: string;                   // rolling "living summary" of older history
  memories: MemoryRecord[];          // per-turn RAG records (vector memory recall)
  turnMode: TurnMode;                // defaulted to 'immediate' for pre-existing saves
  turnIndex: number;                 // round-robin pointer into join order
  fogOfWar: boolean;                 // per-player private narration (`/dm fog on|off`)
  createdAt: number;
}
