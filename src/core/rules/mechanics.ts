/**
 * Mechanical character state — the ENGINE, not the LLM, owns hp/maxHp and
 * conditions. This module is the one place damage/healing/conditions get
 * applied and clamped, so the number the roster shows is always the number
 * the engine computed, never a figure the model narrated into existence.
 *
 * The same machinery drives BOTH kinds of combatant: a player character (whose
 * vitals live on its {@link Player}) and a monster (whose vitals live on its
 * {@link Combatant} in the active encounter). Both satisfy the small
 * {@link Vitals} shape, so `applyHpDelta`/`setCondition`/`clearCondition` don't
 * care which they're handed — `findTarget` resolves a name to whichever owns
 * that character's HP.
 *
 * Two callers feed into these functions:
 *  - explicit commands (`/dm damage`, `/dm heal`, `/dm condition` in bot.ts) — a
 *    player/DM says exactly what happens;
 *  - narration markers (`applyMarkers` below, called from the turn pipeline) —
 *    the DM's prose ends with optional `<<hp Name -7>>`-shaped lines that get
 *    parsed, applied, and stripped before the text ever reaches a player.
 *
 * Marker parsing is deliberately NOT JSON: small/free models are unreliable at
 * strict JSON (see narrator.ts's doc comment), but a `<<tag arg arg>>` line is
 * easy to emit consistently and trivial to regex out. Malformed markers or
 * markers naming someone who isn't a real combatant are silently ignored —
 * dropping the marker text either way — so an LLM that gets the syntax wrong
 * never breaks the game or leaks a stray `<<...>>` into the chat.
 */
import type { Combatant, GameSession, Player, StateChange } from '../types.js';
import { normalizeCondition } from './conditions.js';
import { findMonsterCombatant } from './combat.js';

/** The engine-owned vitals a combatant carries — satisfied by both Player and monster Combatant. */
export interface Vitals {
  hp?: number;
  maxHp?: number;
  conditions?: string[];
}

/** Clamp `n` into `[lo, hi]`. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Apply a signed hp delta to any {@link Vitals}, clamp to `[0, maxHp]`, and
 * sync the `'unconscious'` condition: it is set the instant hp reaches 0, and
 * cleared the instant hp rises back above 0 (never on a `'dead'` combatant —
 * death is a stronger, separate condition a marker/command sets explicitly and
 * this never clears). `name` is only used to label the returned StateChange.
 */
export function applyHpDelta(target: Vitals, name: string, delta: number, kind: 'damage' | 'heal'): StateChange {
  const maxHp = target.maxHp ?? 10;
  const before = target.hp ?? maxHp;
  const after = clamp(before + delta, 0, maxHp);
  target.hp = after;
  target.maxHp = maxHp;

  const conditions = new Set(target.conditions ?? []);
  let becameUnconscious = false;
  let recovered = false;
  if (after <= 0) {
    if (!conditions.has('unconscious') && !conditions.has('dead')) becameUnconscious = true;
    if (!conditions.has('dead')) conditions.add('unconscious');
  } else if (conditions.has('unconscious')) {
    conditions.delete('unconscious');
    recovered = true;
  }
  target.conditions = [...conditions];

  return { characterName: name, kind, amount: Math.abs(delta), hp: after, maxHp, becameUnconscious, recovered };
}

/** Deal `amount` (a non-negative magnitude) damage to a player, clamped at 0 hp. */
export function applyDamage(player: Player, amount: number): StateChange {
  return applyHpDelta(player, player.characterName || player.userName, -Math.abs(amount), 'damage');
}

/** Restore `amount` (a non-negative magnitude) hp to a player, clamped at maxHp. */
export function applyHeal(player: Player, amount: number): StateChange {
  return applyHpDelta(player, player.characterName || player.userName, Math.abs(amount), 'heal');
}

/** Add a condition (e.g. `'prone'`, `'dead'`) to any combatant. Idempotent, canonicalized. */
export function setCondition(target: Vitals, name: string, condition: string): StateChange {
  const id = normalizeCondition(condition) ?? condition.toLowerCase();
  const conditions = new Set(target.conditions ?? []);
  conditions.add(id);
  target.conditions = [...conditions];
  return { characterName: name, kind: 'condition', condition: id };
}

/** Remove a condition from any combatant. Idempotent (removing an absent one is a no-op change). */
export function clearCondition(target: Vitals, name: string, condition: string): StateChange {
  const id = normalizeCondition(condition) ?? condition.toLowerCase();
  const conditions = new Set(target.conditions ?? []);
  conditions.delete(id);
  target.conditions = [...conditions];
  return { characterName: name, kind: 'condition', condition: id, cleared: true };
}

/** Find a live party member by character name (falling back to display name), case-insensitively. */
export function findPartyMember(session: GameSession, characterName: string): Player | undefined {
  const wanted = characterName.trim().toLowerCase();
  if (!wanted) return undefined;
  return Object.values(session.players).find((p) => (p.characterName || p.userName).toLowerCase() === wanted);
}

/**
 * A resolved damage/heal/condition target: the {@link Vitals} that own this
 * character's HP (a Player or a monster Combatant) plus its display name.
 * Players are checked first, then monsters in the active encounter.
 */
export interface ResolvedTarget {
  vitals: Vitals;
  name: string;
  kind: 'player' | 'monster';
}

/** Resolve a name to whichever combatant owns its HP — a party member or an encounter monster. */
export function findTarget(session: GameSession, characterName: string): ResolvedTarget | undefined {
  const player = findPartyMember(session, characterName);
  if (player) return { vitals: player, name: player.characterName || player.userName, kind: 'player' };
  const monster: Combatant | undefined = findMonsterCombatant(session, characterName);
  if (monster) return { vitals: monster, name: monster.name, kind: 'monster' };
  return undefined;
}

export interface MarkerApplyResult {
  /** The narration with every marker (well-formed or not) removed, whitespace tidied. */
  text: string;
  /** The state changes actually applied, in the order their markers appeared. */
  changes: StateChange[];
}

/** One `<<...>>` marker, its inner content unparsed. */
const MARKER_RE = /<<\s*([^<>]+?)\s*>>/g;

/** A bare integer, optionally signed — used for the hp/heal marker's amount. */
const INT_RE = /^-?\d+$/;

/**
 * Parse `<<hp Name -7>>` / `<<heal Name 4>>` / `<<condition Name prone>>` /
 * `<<uncondition Name prone>>` markers out of DM narration, apply each to the
 * matching combatant (party member OR encounter monster), and return the
 * narration with every marker stripped (never shown to players).
 *
 * Markers are tolerant of multi-word character names (e.g. "Zara the Second")
 * — the marker's kind is the first token and its value is the last token;
 * everything between is the name. A marker is IGNORED (contributes no state
 * change, but is still stripped) when: it has fewer than 3 tokens, its kind
 * isn't a known one, its value doesn't parse for that kind, or its name doesn't
 * match a real combatant. This degrades gracefully — an LLM that omits markers
 * entirely, or emits a malformed/hallucinated one, never breaks narration or
 * mutates state it shouldn't.
 */
export function applyMarkers(session: GameSession, narration: string): MarkerApplyResult {
  const changes: StateChange[] = [];

  const text = narration.replace(MARKER_RE, (_whole, inner: string) => {
    const tokens = inner.trim().split(/\s+/);
    if (tokens.length < 3) return '';
    const kind = tokens[0].toLowerCase();
    const value = tokens[tokens.length - 1];
    const characterName = tokens.slice(1, -1).join(' ');
    const target = findTarget(session, characterName);
    if (!target) return '';

    if (kind === 'hp') {
      if (!INT_RE.test(value)) return '';
      const delta = parseInt(value, 10);
      changes.push(applyHpDelta(target.vitals, target.name, delta < 0 ? -Math.abs(delta) : Math.abs(delta), delta < 0 ? 'damage' : 'heal'));
      return '';
    }
    if (kind === 'heal') {
      if (!INT_RE.test(value)) return '';
      const amount = parseInt(value, 10);
      if (amount < 0) return '';
      changes.push(applyHpDelta(target.vitals, target.name, Math.abs(amount), 'heal'));
      return '';
    }
    if (kind === 'condition') {
      if (!normalizeCondition(value)) return '';
      changes.push(setCondition(target.vitals, target.name, value));
      return '';
    }
    if (kind === 'uncondition') {
      if (!normalizeCondition(value)) return '';
      changes.push(clearCondition(target.vitals, target.name, value));
      return '';
    }
    return ''; // unknown marker kind — stripped, no state change
  });

  // Marker-only lines leave behind blank lines / trailing spaces; tidy them so
  // players never see the seams where a marker used to be.
  const cleaned = text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text: cleaned, changes };
}
