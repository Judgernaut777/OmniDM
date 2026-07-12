/**
 * Canonical domain types shared across every layer.
 *
 * The whole design hinges on these being platform- and provider-neutral:
 * adapters translate Discord/CLI/etc. into `IncomingMessage`, the engine works
 * only in these terms, and providers translate `ChatMessage[]` to whatever the
 * model API wants. Nothing below the adapter layer knows what "Discord" is.
 */

import type { CharacterCard, Portrait } from './cards/card-parse.js';
// StatBlock lives in ./rules/statblock.js; Combatant only stores its id (a
// string), so there is no type import needed here — the reference above is
// documentation only.
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
  /**
   * A per-client ownership secret, carried by adapters (like web) that mint a
   * FRESH userId on every connection. It authorizes reclaiming a character seat
   * by name across a reconnect: only a client that presents the same token the
   * seat was created with may take it over — a stranger naming the character
   * cannot. Absent for stable-id adapters (Discord/CLI), which reconnect by
   * userId and so never reclaim by name.
   */
  resumeToken?: string;
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
   * Mechanical status effects the ENGINE owns (e.g. `'unconscious'` set at 0 hp,
   * `'dead'`, or a narration-driven `<<condition ...>>` marker like `'prone'`).
   * Absent-safe — pre-existing sessions/saves have none. `'unconscious'` is
   * cleared automatically the moment hp rises back above 0 (see
   * `rules/mechanics.ts`); other conditions persist until narration or a
   * command changes them.
   */
  conditions?: string[];
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
  /**
   * The character's initiative modifier (`/dm init set <name> <mod>`), added to
   * their d20 when combat rolls initiative. Absent-safe — defaults to 0, a flat
   * d20 roll. Carried across a seat re-claim like the rest of the character.
   */
  initiativeMod?: number;
  /**
   * The character's Armor Class (`/dm ac <name> <n>`) — the DC an attacker's
   * d20+toHit must meet to hit them. Absent-safe — defaults to unarmored 10
   * (see `rules/attacks.ts`). Carried across a seat re-claim.
   */
  ac?: number;
  /**
   * The character's weapon profile (`/dm weapon <name> <toHit> <damage>`) used
   * when they attack. Absent-safe — defaults to a basic martial weapon. Carried
   * across a seat re-claim. Also set (and cleared) by equipping a weapon from
   * the character's inventory (`/dm equip`), so gear and the attack profile
   * never disagree.
   */
  attack?: { name?: string; toHit: number; damage: string };
  /**
   * Engine-owned spell slots, keyed by spell level (1–9), each `{ max, used }`.
   * A leveled spell expends one slot of at least its level; cantrips (level 0)
   * need none. Set with `/dm slots`, spent by `/dm cast`, restored by
   * `/dm rest`. Absent-safe — a non-caster simply has none. See
   * `rules/spells.ts`, which owns every slot mutation the way `mechanics.ts`
   * owns HP.
   */
  spellSlots?: Record<number, { max: number; used: number }>;
  /**
   * The spell save DC a target's saving throw must meet against this caster
   * (`/dm castdc`). Absent-safe — defaults to {@link DEFAULT_SPELL_DC}.
   */
  spellDc?: number;
  /**
   * This caster's spell attack bonus, added to a d20 for attack-roll spells
   * (`/dm castdc`). Absent-safe — defaults to {@link DEFAULT_SPELL_ATTACK}.
   */
  spellAttack?: number;
  /**
   * The ids of spells this character has learned/prepared (`/dm learn`) and may
   * therefore cast. Absent-safe. See the bundled `SPELLBOOK` in `rules/spells.ts`.
   */
  spells?: string[];
  /**
   * The character's carried items (`/dm give`, `/dm use`, `/dm drop`). Each is a
   * stackable {@link Item} instance. Absent-safe. See `rules/inventory.ts`.
   */
  inventory?: Item[];
  /**
   * The item ids currently equipped, by slot. Equipping a weapon sets
   * {@link attack}; equipping armor/shield recomputes {@link ac}. Absent-safe —
   * nothing equipped. See `rules/inventory.ts`.
   */
  equipped?: { weapon?: string; armor?: string; shield?: string };
  /** Imported Character Card persona (`/dm import`), if any. */
  card?: CharacterCard;
  /**
   * The player's portrait: a preset id (`/dm portrait <id>`) or stored image
   * bytes (an upload). Absent-safe — old sessions have none. When unset, the
   * imported card's own portrait (if any) is used as a fallback.
   */
  portrait?: Portrait;
  /**
   * The ownership secret this seat was created with (from the joining client's
   * `IncomingMessage.resumeToken`). A fresh userId may RE-CLAIM this character by
   * name only by presenting the same token — this is what stops another room
   * member from seizing the seat (and its private fog whispers) via
   * `/dm join <name>`. Absent for stable-id adapters, whose seats are therefore
   * not reclaimable-by-name at all (they reconnect by userId).
   */
  resumeToken?: string;
}

/**
 * One carried item on a {@link Player.inventory}. Deliberately compact — the
 * engine tracks only the numbers it acts on (a weapon's to-hit/damage, armor's
 * AC, a potion's healing), the DM narrates the flavor. A stack of identical
 * items collapses onto a single entry via `qty`. Items come from the bundled
 * `ARMORY` catalog (`rules/inventory.ts`); `id` is that catalog id, so equipping
 * and stacking can key on it.
 */
export interface Item {
  /** Catalog slug (`longsword`, `chain-mail`, `potion-of-healing`). */
  id: string;
  name: string;
  kind: 'weapon' | 'armor' | 'shield' | 'potion' | 'misc';
  /** How many of this item the character carries (stacks collapse). */
  qty: number;
  /** Weapon: attack-roll bonus (modifier baked in, like `Player.attack`). */
  toHit?: number;
  /** Weapon: damage dice notation (`1d8+2`). */
  damage?: string;
  /** Armor: the base Armor Class it grants when worn (replaces unarmored 10). */
  ac?: number;
  /** Shield/trinket: a bonus ADDED to the worn armor's AC. */
  acBonus?: number;
  /** Potion: healing dice rolled when quaffed (`/dm use`). */
  heal?: string;
  /** One-line flavor for the catalog/inventory listing. */
  desc?: string;
}

export interface RollResult {
  by: string;          // character or player name
  notation: string;    // "d20+5"
  rolls: number[];
  total: number;
  note?: string;       // "CRITICAL HIT (nat 20)" etc.
}

/**
 * A resolved ability check (`/dm check <char> <ABILITY> <DC>`): the engine rolls
 * d20 (+ an optional flat modifier), compares to the DC, and hands the narrator
 * a fixed PASS/FAIL fact — same "resolve before narrating" pattern as dice.
 */
export interface CheckResult {
  by: string;          // character or player name
  ability: string;     // "STR" | "DEX" | "CON" | "INT" | "WIS" | "CHA"
  dc: number;
  roll: number;         // the raw d20 face
  modifier: number;
  total: number;        // roll + modifier
  pass: boolean;
  note?: string;        // "CRITICAL SUCCESS (nat 20)" | "CRITICAL FAILURE (nat 1)"
}

/**
 * One mechanical state change the engine applied — either from a narration
 * marker (`<<hp ...>>` etc.) or an explicit command (`/dm damage`, `/dm heal`).
 * Surfaced by the turn pipeline so a caller (bot/UI) can react without
 * re-deriving it from the mutated session.
 */
export interface StateChange {
  characterName: string;
  kind: 'damage' | 'heal' | 'condition';
  amount?: number;      // for 'damage' | 'heal': the magnitude applied
  hp?: number;           // resulting hp, for 'damage' | 'heal'
  maxHp?: number;
  condition?: string;    // for 'condition'
  cleared?: boolean;     // for 'condition': the condition was REMOVED, not added
  becameUnconscious?: boolean; // hp crossed down to 0 on this change
  recovered?: boolean;         // hp rose back above 0, clearing 'unconscious'
}

/**
 * One participant in a combat encounter, in initiative order. A `'player'`
 * combatant is a thin pointer to a live {@link Player} (`playerUserId`) — the
 * Player stays the single source of truth for that character's hp/conditions,
 * so combat never forks a second copy of a PC's mechanical state. A `'monster'`
 * combatant has NO backing Player, so it carries its OWN engine-owned vitals
 * (`hp`/`maxHp`/`ac`/`conditions`) right here — this is where a monster's HP
 * lives and gets damaged/healed.
 */
export interface Combatant {
  /** Unique within the encounter (`goblin-1`, or a player's userId). */
  id: string;
  name: string;
  kind: 'player' | 'monster';
  /** Set when `kind === 'player'`: the userId of the backing {@link Player}. */
  playerUserId?: string;
  /** Set when `kind === 'monster'`: the {@link StatBlock} id it was spawned from. */
  statBlockId?: string;
  /** Rolled initiative total (d20 + `initiativeMod`); 0 until combat starts. */
  initiative: number;
  /** Initiative modifier — the DEX-ish bonus, also the initiative tiebreaker. */
  initiativeMod: number;
  /** Monster AC (players' AC is narrative, not engine-tracked). */
  ac?: number;
  /** Monster hp — the engine-owned vitals a Player would otherwise hold. */
  hp?: number;
  maxHp?: number;
  /** Monster conditions (players keep theirs on the {@link Player}). */
  conditions?: string[];
}

/**
 * An engine-owned combat encounter: an initiative order plus a pointer into it.
 * Created in a staging state (`active: false`, monsters added but initiative
 * unrolled) by `/dm monster add`, then rolled and started by `/dm combat start`
 * (see `rules/combat.ts`). Absent on a session with no fight in progress.
 */
export interface CombatState {
  /** False while staging monsters pre-initiative; true once `/dm combat start` rolls. */
  active: boolean;
  /** 1-based round counter, incremented each time the pointer wraps the order. */
  round: number;
  /** Pointer into `order` — whose turn it is. */
  turnIndex: number;
  /** Combatants in descending initiative order once started. */
  order: Combatant[];
}

export interface TurnRecord {
  /** What the players did this turn. */
  actions: { name: string; text: string }[];
  /** Dice resolved deterministically BEFORE narration. */
  rolls: RollResult[];
  /** Ability checks (`/dm check`) resolved deterministically BEFORE narration. */
  checks?: CheckResult[];
  /** The DM's narration of the resolved outcome (markers already stripped). */
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
  /**
   * A content pack's homebrew rules module, scoped to THIS session only (see
   * `content-packs/loader.ts`). Kept on the session itself — never in a
   * process-wide registry — so two sessions in the same process can each load
   * a pack whose `rulesModule.id` happens to collide (with each other, or
   * with a bundled system id like "dnd5e") without one clobbering the
   * other's rules text. Only consulted when `id` matches this session's
   * `systemId`; otherwise the narrator falls back to the shared bundled
   * rules registry.
   */
  customRules?: { id: string; markdown: string };
  /**
   * The active combat encounter (initiative order + round pointer), or absent
   * when no fight is in progress. Engine-owned like hp: `/dm monster add`
   * stages it, `/dm combat start` rolls initiative, `/dm combat next` advances,
   * `/dm combat end` clears it. See `rules/combat.ts`. Absent-safe — pre-combat
   * saves simply have none.
   */
  encounter?: CombatState;
}
