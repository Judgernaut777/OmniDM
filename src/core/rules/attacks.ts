/**
 * Attack resolution — the engine rolls to-hit vs AC and damage vs HP, so a
 * fight has real mechanical stakes, not just narrated ones. Same discipline as
 * the rest of the rules layer: the ENGINE owns the numbers (the d20, the AC
 * comparison, the damage dice, the crit doubling), the LLM narrates them.
 *
 * A monster attacks with the attacks on its {@link StatBlock}; a player attacks
 * with their weapon profile ({@link Player.attack}, defaulting to a basic
 * martial weapon). The target's AC is the monster's {@link StatBlock.ac} or the
 * player's {@link Player.ac} (defaulting to unarmored 10). On a hit the engine
 * rolls the damage dice — doubling the DICE (not the modifier) on a natural 20,
 * per 5e crits — and applies it through the same {@link applyHpDelta} that
 * `/dm damage` and the `<<hp>>` marker use, so a downed target is downed once,
 * consistently.
 *
 * Browser-safe: types, the pure dice roller, the bestiary, and mechanics.
 */
import type { GameSession, Player } from '../types.js';
import { parseNotation, roll } from '../engine/dice.js';
import { BESTIARY } from './statblock.js';
import { findMonsterCombatant } from './combat.js';
import { applyHpDelta, findPartyMember, type Vitals } from './mechanics.js';

/** A creature's Armor Class when it hasn't been set — 5e unarmored. */
export const DEFAULT_AC = 10;
/** A player's weapon when none is set (`/dm weapon`) — a basic martial hit. */
export const DEFAULT_PLAYER_ATTACK: AttackProfile = { name: 'weapon', toHit: 4, damage: '1d8+2' };
/** A monster with an empty stat block still throws a feeble unarmed strike. */
export const DEFAULT_MONSTER_ATTACK: AttackProfile = { name: 'strike', toHit: 2, damage: '1d4' };

/** One attack option: its label, to-hit bonus, and damage dice notation. */
export interface AttackProfile {
  name: string;
  toHit: number;
  damage: string;
}

/** A fully resolved attack — every number the engine computed, for display and narration. */
export interface AttackResult {
  attacker: string;
  target: string;
  attackName: string;
  d20: number;          // the raw d20 face
  toHit: number;
  attackTotal: number;  // d20 + toHit
  targetAC: number;
  hit: boolean;
  crit: boolean;        // natural 20 — auto-hit, damage dice doubled
  fumble: boolean;      // natural 1 — auto-miss
  damage: number;       // 0 on a miss
  damageRolls: number[];
  damageNotation: string;
  targetHp?: number;    // target's hp after damage
  targetMaxHp?: number;
  targetDropped: boolean; // this hit dropped the target to 0
}

/** The attacks available to a named combatant (a party member or an encounter monster), if it exists. */
export function attackerProfiles(session: GameSession, name: string): { name: string; profiles: AttackProfile[] } | undefined {
  const player = findPartyMember(session, name);
  if (player) {
    const profile: AttackProfile = player.attack
      ? { name: player.attack.name ?? 'weapon', toHit: player.attack.toHit, damage: player.attack.damage }
      : DEFAULT_PLAYER_ATTACK;
    return { name: player.characterName || player.userName, profiles: [profile] };
  }
  const monster = findMonsterCombatant(session, name);
  if (monster) {
    const sb = monster.statBlockId ? BESTIARY[monster.statBlockId] : undefined;
    const profiles = sb?.attacks?.length
      ? sb.attacks.map((a) => ({ name: a.name, toHit: a.toHit, damage: a.damage }))
      : [DEFAULT_MONSTER_ATTACK];
    return { name: monster.name, profiles };
  }
  return undefined;
}

/** A named combatant as an attack TARGET: its vitals (whose hp gets damaged) and its AC. */
export function attackTarget(session: GameSession, name: string): { name: string; ac: number; vitals: Vitals } | undefined {
  const player = findPartyMember(session, name);
  if (player) return { name: player.characterName || player.userName, ac: player.ac ?? DEFAULT_AC, vitals: player };
  const monster = findMonsterCombatant(session, name);
  if (monster) return { name: monster.name, ac: monster.ac ?? DEFAULT_AC, vitals: monster };
  return undefined;
}

/** Pick a named attack from a profile list (case-insensitive), or the first one. */
export function pickAttack(profiles: AttackProfile[], name?: string): AttackProfile {
  if (name) {
    const wanted = name.trim().toLowerCase();
    const found = profiles.find((p) => p.name.toLowerCase() === wanted);
    if (found) return found;
  }
  return profiles[0];
}

/**
 * Resolve one attack deterministically: roll d20 (+toHit) vs the target's AC,
 * and on a hit roll damage and apply it to the target's hp. A natural 20 always
 * hits AND doubles the damage DICE (not the flat modifier); a natural 1 always
 * misses. `opts.d20` overrides the die for tests/replay; `opts.seed` seeds the
 * damage dice for reproducibility.
 */
export function resolveAttack(
  attackerName: string,
  profile: AttackProfile,
  target: { name: string; ac: number; vitals: Vitals },
  opts: { d20?: number; seed?: number } = {},
): AttackResult {
  const d20 = opts.d20 ?? roll('d20', attackerName, opts.seed).rolls[0];
  const crit = d20 === 20;
  const fumble = d20 === 1;
  const attackTotal = d20 + profile.toHit;
  const hit = crit || (!fumble && attackTotal >= target.ac);

  let damage = 0;
  let damageRolls: number[] = [];
  if (hit) {
    const base = roll(profile.damage, attackerName, opts.seed);
    damage = base.total;
    damageRolls = base.rolls;
    if (crit) {
      // 5e crit: roll the damage DICE again (not the flat modifier).
      const p = parseNotation(profile.damage);
      const extra = roll(`${p.numDice}d${p.dieSize}`, attackerName, opts.seed !== undefined ? opts.seed + 1 : undefined);
      damage += extra.total;
      damageRolls = [...damageRolls, ...extra.rolls];
    }
    applyHpDelta(target.vitals, target.name, -damage, 'damage');
  }

  return {
    attacker: attackerName,
    target: target.name,
    attackName: profile.name,
    d20,
    toHit: profile.toHit,
    attackTotal,
    targetAC: target.ac,
    hit,
    crit,
    fumble,
    damage,
    damageRolls,
    damageNotation: profile.damage,
    targetHp: target.vitals.hp,
    targetMaxHp: target.vitals.maxHp,
    targetDropped: hit && (target.vitals.hp ?? 1) <= 0,
  };
}

/** A one-line chat summary of a resolved attack. */
export function attackLine(r: AttackResult): string {
  const roll = `d20${r.toHit >= 0 ? '+' : ''}${r.toHit} = ${r.attackTotal} vs AC ${r.targetAC}`;
  if (!r.hit) {
    const why = r.fumble ? ' (natural 1 — fumble)' : '';
    return `⚔️ ${r.attacker} attacks ${r.target} (${r.attackName}): ${roll} → MISS${why}.`;
  }
  const critTag = r.crit ? ' 💥 CRITICAL HIT (natural 20)' : '';
  const dropped = r.targetDropped ? ` — ${r.target} drops!` : '';
  return `⚔️ ${r.attacker} attacks ${r.target} (${r.attackName}): ${roll} → HIT${critTag}! ${r.damage} damage (${r.damageNotation}${r.crit ? ', doubled dice' : ''}). ${r.target}: HP ${r.targetHp}/${r.targetMaxHp}.${dropped}`;
}
