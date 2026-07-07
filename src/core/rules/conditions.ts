/**
 * The D&D 5e conditions library — the canonical catalog of status effects the
 * engine understands, with one-line mechanical summaries.
 *
 * Two jobs:
 *  - VALIDATION/NORMALIZATION: `/dm condition` and the `<<condition ...>>`
 *    narration marker map free text onto a canonical id (case/spacing tolerant),
 *    so "Prone", "prone", and "PRONE" are one condition, not three. Homebrew
 *    words the catalog doesn't know are still allowed (the engine tracked
 *    free-form condition strings before this existed) — they just carry no
 *    summary.
 *  - PROMPT CONTEXT: `describeConditions` turns a character's active conditions
 *    into a short block the narrator sees, so the DM actually plays "restrained"
 *    or "frightened" by its rules instead of treating it as a flavor word.
 *
 * Browser-safe: pure data + string helpers, no `node:` imports.
 */

/** One catalog entry: a canonical id and a terse, system-accurate effect summary. */
export interface ConditionDef {
  id: string;
  /** Human title for display (`Prone`). */
  name: string;
  /** One-line mechanical effect, phrased for the DM. */
  summary: string;
}

/**
 * The 14 standard 5e conditions, plus `exhaustion` (tracked flat here, not by
 * level) and the engine's own `dead`/`unconscious` (the latter is what
 * `mechanics.ts` sets at 0 hp). Keyed by canonical id.
 */
export const CONDITIONS: Record<string, ConditionDef> = {
  blinded: { id: 'blinded', name: 'Blinded', summary: "can't see; auto-fails sight checks; attacks against it have advantage, its own have disadvantage." },
  charmed: { id: 'charmed', name: 'Charmed', summary: "can't attack the charmer; the charmer has advantage on social checks against it." },
  deafened: { id: 'deafened', name: 'Deafened', summary: "can't hear; auto-fails hearing checks." },
  frightened: { id: 'frightened', name: 'Frightened', summary: 'disadvantage on checks and attacks while the source of fear is in sight; cannot willingly move closer to it.' },
  grappled: { id: 'grappled', name: 'Grappled', summary: 'speed 0; ends if the grappler is incapacitated or the two are forced apart.' },
  incapacitated: { id: 'incapacitated', name: 'Incapacitated', summary: "can't take actions or reactions." },
  invisible: { id: 'invisible', name: 'Invisible', summary: 'unseen without magic; attacks against it have disadvantage, its own have advantage.' },
  paralyzed: { id: 'paralyzed', name: 'Paralyzed', summary: 'incapacitated, can\'t move or speak; auto-fails STR/DEX saves; melee hits against it are critical.' },
  petrified: { id: 'petrified', name: 'Petrified', summary: 'turned to stone: incapacitated, unaware, resistant to all damage, immune to poison/disease.' },
  poisoned: { id: 'poisoned', name: 'Poisoned', summary: 'disadvantage on attack rolls and ability checks.' },
  prone: { id: 'prone', name: 'Prone', summary: 'can only crawl; disadvantage on attacks; melee attackers have advantage, ranged have disadvantage.' },
  restrained: { id: 'restrained', name: 'Restrained', summary: 'speed 0; disadvantage on attacks and DEX saves; attacks against it have advantage.' },
  stunned: { id: 'stunned', name: 'Stunned', summary: "incapacitated, can't move, can barely speak; auto-fails STR/DEX saves; attacks against it have advantage." },
  unconscious: { id: 'unconscious', name: 'Unconscious', summary: 'incapacitated, prone, unaware; drops what it holds; melee hits against it are critical. Set by the engine at 0 hp.' },
  exhaustion: { id: 'exhaustion', name: 'Exhaustion', summary: 'fatigue: disadvantage on ability checks (worse at higher levels — halved speed, disadvantage on attacks/saves, and eventually death).' },
  dead: { id: 'dead', name: 'Dead', summary: 'out of the fight for good; only powerful magic returns the character to life.' },
};

/** A condition token: one or more lowercase words joined by hyphens (`prone`, `on-fire`). */
const CONDITION_TOKEN_RE = /^[a-z][a-z-]*$/;

/**
 * Canonicalize a free-text condition to a stable id, or `undefined` if it isn't
 * a valid condition token at all. A word the {@link CONDITIONS} catalog knows
 * returns that entry's id; an unknown-but-well-formed word is lowercased and
 * returned as-is (homebrew conditions stay allowed — the engine never gated
 * them). Whitespace-in ("on fire") is hyphenated so it survives as one token.
 */
export function normalizeCondition(input: string): string | undefined {
  const slug = input.trim().toLowerCase().replace(/\s+/g, '-');
  if (!CONDITION_TOKEN_RE.test(slug)) return undefined;
  return CONDITIONS[slug]?.id ?? slug;
}

/** The catalog entry for a condition id, if it's a known one. */
export function conditionDef(id: string): ConditionDef | undefined {
  return CONDITIONS[id.toLowerCase()];
}

/**
 * A short prompt block describing a set of ACTIVE conditions so the narrator
 * plays them by their rules. Known conditions get their summary; unknown
 * (homebrew) ones are listed by name only. Empty string when there are none.
 */
export function describeConditions(ids: string[] = []): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of ids) {
    const id = raw.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    const def = CONDITIONS[id];
    lines.push(def ? `- ${def.name}: ${def.summary}` : `- ${raw}`);
  }
  return lines.join('\n');
}
