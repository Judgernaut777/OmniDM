/**
 * Combat engine — engine-owned initiative order and turn tracking.
 *
 * Same philosophy as the rest of the rules layer: the ENGINE owns the numbers
 * (who goes when, which round it is), the LLM narrates them. Initiative is
 * rolled deterministically here (via the same dice roller player actions use),
 * sorted once, and then advanced by explicit command — the model never decides
 * turn order or invents a round count.
 *
 * A monster's mechanical hp lives on its {@link Combatant} (there's no backing
 * Player); a player-combatant is only a pointer to the live {@link Player},
 * which stays the single source of truth for that PC's hp/conditions. So this
 * module deliberately does NOT apply damage — that's `mechanics.ts`'s job,
 * which resolves a target (player OR monster) and mutates the right owner. This
 * module only manages the ORDER.
 *
 * Browser-safe: imports only types, the pure dice roller, and the bestiary.
 */
import type { Combatant, CombatState, GameSession, Player } from '../types.js';
import { roll } from '../engine/dice.js';
import type { StatBlock } from './statblock.js';

const name = (p: Player): string => p.characterName || p.userName;

/** Conditions that take a combatant out of the turn order (they don't act). */
const OUT_OF_FIGHT = new Set(['unconscious', 'dead', 'paralyzed', 'petrified', 'stunned', 'incapacitated']);

/** True if `c` is downed/incapacitated and should be skipped when advancing turns. */
export function isOutOfFight(c: Combatant): boolean {
  return (c.conditions ?? []).some((cond) => OUT_OF_FIGHT.has(cond));
}

/** Ensure `session.encounter` exists (staging state), returning it. */
export function ensureEncounter(session: GameSession): CombatState {
  if (!session.encounter) session.encounter = { active: false, round: 0, turnIndex: 0, order: [] };
  return session.encounter;
}

/**
 * Stage a monster from a {@link StatBlock} into the (possibly new) encounter,
 * with its own engine-owned vitals. `customName` overrides the display name;
 * otherwise duplicates auto-number ("Goblin", "Goblin 2", ...). Returns the new
 * combatant. If combat is already active, the monster is inserted and rolls
 * initiative immediately so it takes its place in the live order.
 */
export function addMonster(session: GameSession, sb: StatBlock, customName?: string, rollInit: (mod: number) => number = defaultRollInit): Combatant {
  const enc = ensureEncounter(session);
  const baseName = customName?.trim() || sb.name;
  // Auto-number same-named monsters so "damage Goblin 2" is unambiguous.
  const sameName = enc.order.filter((c) => c.kind === 'monster' && stripNum(c.name) === baseName);
  const display = customName?.trim() ? baseName : sameName.length ? `${baseName} ${sameName.length + 1}` : baseName;
  const idBase = sb.id;
  const idNum = enc.order.filter((c) => c.statBlockId === sb.id).length + 1;
  const combatant: Combatant = {
    id: `${idBase}-${idNum}`,
    name: display,
    kind: 'monster',
    statBlockId: sb.id,
    initiative: enc.active ? rollInit(sb.initiativeMod) : 0,
    initiativeMod: sb.initiativeMod,
    ac: sb.ac,
    hp: sb.maxHp,
    maxHp: sb.maxHp,
    conditions: [],
  };
  enc.order.push(combatant);
  if (enc.active) sortOrder(enc);
  return combatant;
}

/** Remove a staged/active monster by name (case-insensitive). Returns true if one was removed. */
export function removeMonster(session: GameSession, monsterName: string): boolean {
  const enc = session.encounter;
  if (!enc) return false;
  const wanted = monsterName.trim().toLowerCase();
  const idx = enc.order.findIndex((c) => c.kind === 'monster' && c.name.toLowerCase() === wanted);
  if (idx === -1) return false;
  // Keep the pointer aimed at the same combatant when we splice out an earlier one.
  if (idx < enc.turnIndex) enc.turnIndex--;
  enc.order.splice(idx, 1);
  if (enc.active && enc.order.length) enc.turnIndex %= enc.order.length;
  else if (!enc.order.length) enc.turnIndex = 0;
  return true;
}

/**
 * Roll initiative for the whole party plus every staged monster, sort the order
 * descending, and mark the encounter active at round 1. Player-combatants are
 * (re)built from the CURRENT party so a mid-staging join is included; existing
 * monster combatants keep their staged hp/conditions. `rollInit` is injectable
 * for deterministic tests.
 */
export function startCombat(session: GameSession, rollInit: (mod: number) => number = defaultRollInit): CombatState {
  const enc = ensureEncounter(session);
  const monsters = enc.order.filter((c) => c.kind === 'monster');
  const players: Combatant[] = Object.values(session.players).map((p) => ({
    id: p.userId,
    name: name(p),
    kind: 'player',
    playerUserId: p.userId,
    initiative: 0,
    initiativeMod: p.initiativeMod ?? 0,
  }));
  enc.order = [...players, ...monsters];
  for (const c of enc.order) c.initiative = rollInit(c.initiativeMod);
  sortOrder(enc);
  enc.active = true;
  enc.round = 1;
  enc.turnIndex = 0;
  return enc;
}

/** Whose turn it is, or null if the encounter is empty/inactive. */
export function currentCombatant(session: GameSession): Combatant | null {
  const enc = session.encounter;
  if (!enc || !enc.active || !enc.order.length) return null;
  return enc.order[enc.turnIndex % enc.order.length] ?? null;
}

/**
 * Advance to the next combatant still in the fight, wrapping to the top of the
 * order (and incrementing the round) when it passes the end. Skips downed
 * combatants (see {@link isOutOfFight}). Returns the new current combatant, or
 * null if everyone is out of the fight.
 */
export function advanceCombat(session: GameSession): Combatant | null {
  const enc = session.encounter;
  if (!enc || !enc.active || !enc.order.length) return null;
  const n = enc.order.length;
  for (let step = 0; step < n; step++) {
    enc.turnIndex++;
    if (enc.turnIndex >= n) {
      enc.turnIndex = 0;
      enc.round++;
    }
    if (!isOutOfFight(enc.order[enc.turnIndex])) return enc.order[enc.turnIndex];
  }
  return null; // nobody left standing
}

/** End (clear) the encounter. */
export function endCombat(session: GameSession): void {
  session.encounter = undefined;
}

/** The combatants (by kind) still standing — used to spot a finished fight. */
export function livingSides(session: GameSession): { players: Combatant[]; monsters: Combatant[] } {
  const order = session.encounter?.order ?? [];
  const alive = order.filter((c) => !isOutOfFight(c));
  return {
    players: alive.filter((c) => c.kind === 'player'),
    monsters: alive.filter((c) => c.kind === 'monster'),
  };
}

/** A staged/active monster combatant by name (case-insensitive), if any. */
export function findMonsterCombatant(session: GameSession, monsterName: string): Combatant | undefined {
  const enc = session.encounter;
  if (!enc) return undefined;
  const wanted = monsterName.trim().toLowerCase();
  return enc.order.find((c) => c.kind === 'monster' && c.name.toLowerCase() === wanted);
}

/**
 * The prompt block describing the live encounter for the narrator: round,
 * initiative order with a ▶ on the current actor, and each combatant's engine
 * numbers (monster hp/ac/conditions; players' hp is already in the roster).
 * Empty string when there's no active encounter.
 */
export function summarizeCombat(session: GameSession): string {
  const enc = session.encounter;
  if (!enc || !enc.active || !enc.order.length) return '';
  const current = currentCombatant(session);
  const lines = enc.order.map((c) => {
    const mark = c === current ? '▶' : ' ';
    const down = isOutOfFight(c) ? ' [down]' : '';
    const vitals = c.kind === 'monster' ? ` — HP ${c.hp}/${c.maxHp}, AC ${c.ac}` : '';
    const conds = c.conditions?.length ? ` (${c.conditions.join(', ')})` : '';
    return `${mark} ${c.initiative} — ${c.name}${vitals}${conds}${down}`;
  });
  return `## Combat — round ${enc.round} (initiative order; ▶ = acting now)\n${lines.join('\n')}`;
}

// ── internals ──

function defaultRollInit(mod: number): number {
  return roll('d20').total + mod;
}

/** Sort the order by initiative desc, tiebreak by initiativeMod desc, then name. */
function sortOrder(enc: CombatState): void {
  const active = enc.order[enc.turnIndex];
  enc.order.sort((a, b) => b.initiative - a.initiative || b.initiativeMod - a.initiativeMod || a.name.localeCompare(b.name));
  // Keep the pointer on whoever was acting after a re-sort (a mid-combat add).
  if (active) enc.turnIndex = Math.max(0, enc.order.indexOf(active));
}

/** Strip a trailing " 2"/" 3" auto-number so re-adds group under the base name. */
function stripNum(display: string): string {
  return display.replace(/\s+\d+$/, '');
}
