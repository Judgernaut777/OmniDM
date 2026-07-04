/**
 * Mechanical character state — the ENGINE, not the LLM, owns hp/maxHp and
 * conditions. This module is the one place damage/healing/conditions get
 * applied and clamped, so the number the roster shows is always the number
 * the engine computed, never a figure the model narrated into existence.
 *
 * Two callers feed into these functions:
 *  - explicit commands (`/dm damage`, `/dm heal` in bot.ts) — a player/DM says
 *    exactly what happens;
 *  - narration markers (`applyMarkers` below, called from the turn pipeline) —
 *    the DM's prose ends with optional `<<hp Name -7>>`-shaped lines that get
 *    parsed, applied, and stripped before the text ever reaches a player.
 *
 * Marker parsing is deliberately NOT JSON: small/free models are unreliable at
 * strict JSON (see narrator.ts's doc comment), but a `<<tag arg arg>>` line is
 * easy to emit consistently and trivial to regex out. Malformed markers or
 * markers naming someone who isn't a real party member are silently ignored —
 * dropping the marker text either way — so an LLM that gets the syntax wrong
 * never breaks the game or leaks a stray `<<...>>` into the chat.
 */
import type { GameSession, Player, StateChange } from '../types.js';

/** Clamp `n` into `[lo, hi]`. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Apply a signed hp delta, clamp to `[0, maxHp]`, and sync the `'unconscious'`
 * condition: it is set the instant hp reaches 0, and cleared the instant hp
 * rises back above 0 (never on a `'dead'` character — death is a stronger,
 * separate condition a marker/command sets explicitly and this never clears).
 */
function adjustHp(player: Player, delta: number, kind: 'damage' | 'heal'): StateChange {
  const maxHp = player.maxHp ?? 10;
  const before = player.hp ?? maxHp;
  const after = clamp(before + delta, 0, maxHp);
  player.hp = after;
  player.maxHp = maxHp;

  const conditions = new Set(player.conditions ?? []);
  let becameUnconscious = false;
  let recovered = false;
  if (after <= 0) {
    if (!conditions.has('unconscious')) becameUnconscious = true;
    conditions.add('unconscious');
  } else if (conditions.has('unconscious')) {
    conditions.delete('unconscious');
    recovered = true;
  }
  player.conditions = [...conditions];

  return {
    characterName: player.characterName || player.userName,
    kind,
    amount: Math.abs(delta),
    hp: after,
    maxHp,
    becameUnconscious,
    recovered,
  };
}

/** Deal `amount` (a non-negative magnitude) damage, clamped at 0 hp. */
export function applyDamage(player: Player, amount: number): StateChange {
  return adjustHp(player, -Math.abs(amount), 'damage');
}

/** Restore `amount` (a non-negative magnitude) hp, clamped at maxHp. */
export function applyHeal(player: Player, amount: number): StateChange {
  return adjustHp(player, Math.abs(amount), 'heal');
}

/** Add a condition (e.g. `'prone'`, `'dead'`) to a character. Idempotent. */
export function setCondition(player: Player, condition: string): StateChange {
  const conditions = new Set(player.conditions ?? []);
  conditions.add(condition);
  player.conditions = [...conditions];
  return { characterName: player.characterName || player.userName, kind: 'condition', condition };
}

/** Find a live party member by character name (falling back to display name), case-insensitively. */
export function findPartyMember(session: GameSession, characterName: string): Player | undefined {
  const wanted = characterName.trim().toLowerCase();
  if (!wanted) return undefined;
  return Object.values(session.players).find((p) => (p.characterName || p.userName).toLowerCase() === wanted);
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
/** A condition name: letters and hyphens only (e.g. "unconscious", "half-orc-rage"). */
const CONDITION_RE = /^[a-zA-Z-]+$/;

/**
 * Parse `<<hp Name -7>>` / `<<heal Name 4>>` / `<<condition Name prone>>`
 * markers out of DM narration, apply each to the matching party member, and
 * return the narration with every marker stripped (never shown to players).
 *
 * Markers are tolerant of multi-word character names (e.g. "Zara the Second")
 * — the marker's kind is the first token and its value is the last token;
 * everything between is the name. A marker is IGNORED (contributes no state
 * change, but is still stripped) when: it has fewer than 3 tokens, its kind
 * isn't one of hp/heal/condition, its value doesn't parse for that kind, or
 * its name doesn't match a real party member. This degrades gracefully — an
 * LLM that omits markers entirely, or emits a malformed/hallucinated one,
 * never breaks narration or mutates state it shouldn't.
 */
export function applyMarkers(session: GameSession, narration: string): MarkerApplyResult {
  const changes: StateChange[] = [];

  const text = narration.replace(MARKER_RE, (_whole, inner: string) => {
    const tokens = inner.trim().split(/\s+/);
    if (tokens.length < 3) return '';
    const kind = tokens[0].toLowerCase();
    const value = tokens[tokens.length - 1];
    const characterName = tokens.slice(1, -1).join(' ');
    const player = findPartyMember(session, characterName);
    if (!player) return '';

    if (kind === 'hp') {
      if (!INT_RE.test(value)) return '';
      const delta = parseInt(value, 10);
      changes.push(delta < 0 ? applyDamage(player, -delta) : applyHeal(player, delta));
      return '';
    }
    if (kind === 'heal') {
      if (!INT_RE.test(value)) return '';
      const amount = parseInt(value, 10);
      if (amount < 0) return '';
      changes.push(applyHeal(player, amount));
      return '';
    }
    if (kind === 'condition') {
      if (!CONDITION_RE.test(value)) return '';
      changes.push(setCondition(player, value.toLowerCase()));
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
