/**
 * Spellcasting — the engine owns spell slots and resolves a cast, the same way
 * `attacks.ts` owns the to-hit roll and `mechanics.ts` owns HP. The model never
 * decides whether a spell hits, how much a saving throw mitigates, or how many
 * slots a caster has left: those are numbers, and numbers are the engine's.
 *
 * Three resolution shapes cover the bundled catalog:
 *  - ATTACK spells (Fire Bolt, Guiding Bolt): roll d20 + the caster's spell
 *    attack bonus vs the target's AC. A natural 20 auto-hits and doubles the
 *    damage DICE (5e spell crits), a natural 1 auto-misses — identical to a
 *    weapon attack (see `attacks.ts`), so the two feel the same at the table.
 *  - SAVE spells (Fireball, Hold Person): the TARGET rolls d20 (+ an optional
 *    save modifier) vs the caster's spell save DC. On a failed save the full
 *    effect lands; on a success a `halfOnSave` spell deals half damage and a
 *    condition never takes hold.
 *  - AUTO spells (Magic Missile, Cure Wounds): no roll — damage or healing
 *    applies straight to the target. Healing runs through the SAME
 *    {@link applyHpDelta} as everything else, so a downed ally wakes on the
 *    exact hp threshold the rest of the engine agrees on.
 *
 * Slots are spent by the caller (the bot) via {@link expendSlot} AFTER a legal
 * cast is confirmed; {@link resolveCast} is pure over the target and never
 * touches the caster's slots, so it stays trivially testable and re-runnable.
 *
 * Browser-safe: types, the pure dice roller, and mechanics — no `node:` imports.
 */
import type { Player } from '../types.js';
import { parseNotation, roll } from '../engine/dice.js';
import { applyHpDelta, setCondition, type Vitals } from './mechanics.js';

/** A caster's spell save DC when none is set (`/dm castdc`) — a low-tier default. */
export const DEFAULT_SPELL_DC = 13;
/** A caster's spell attack bonus when none is set — a low-tier default. */
export const DEFAULT_SPELL_ATTACK = 5;

/** How a spell's mechanical effect is resolved by the engine. */
export type SpellResolution = 'attack' | 'save' | 'auto';

/**
 * A spell the engine can resolve. Compact on purpose — only the fields the
 * engine acts on. Exactly one of {@link damage}/{@link heal} is the numeric
 * payload (a spell may also, or instead, impose a {@link condition}). A pure
 * utility spell has none and is played entirely in the fiction.
 */
export interface Spell {
  /** Stable slug (`fire-bolt`, `hold-person`). */
  id: string;
  name: string;
  /** 0 = cantrip (no slot); 1–9 = the minimum slot level to cast it. */
  level: number;
  school: string;
  /** How the engine resolves it. `undefined` = pure utility (no roll, no target). */
  resolution?: SpellResolution;
  /** Save spells: the ability the TARGET rolls (`STR`|`DEX`|`CON`|`INT`|`WIS`|`CHA`). */
  save?: string;
  /** Save spells: the target takes HALF damage on a successful save (else none). */
  halfOnSave?: boolean;
  /** Damage dice notation (`8d6`), rolled by the engine. */
  damage?: string;
  /** Damage/energy type, for flavor in the chat line (`fire`, `radiant`). */
  damageType?: string;
  /** Healing dice notation (`1d8+3`) — a healing spell. */
  heal?: string;
  /** A condition imposed on a hit / a failed save (one lowercase word). */
  condition?: string;
  /** One-line description for `/dm spells <id>`. */
  desc: string;
}

/**
 * The bundled spellbook — a spread across cantrips and levels 1–3 covering
 * every resolution shape (attack, save, auto) plus healing and a control
 * spell, so a caster has something real to do from level 1. Keyed by id.
 */
export const SPELLBOOK: Record<string, Spell> = {
  'fire-bolt': { id: 'fire-bolt', name: 'Fire Bolt', level: 0, school: 'evocation', resolution: 'attack', damage: '1d10', damageType: 'fire', desc: 'A mote of fire hurled at a creature or object; a ranged spell attack.' },
  'ray-of-frost': { id: 'ray-of-frost', name: 'Ray of Frost', level: 0, school: 'evocation', resolution: 'attack', damage: '1d8', damageType: 'cold', desc: 'A frigid beam; a hit also slows the target (narrated).' },
  'sacred-flame': { id: 'sacred-flame', name: 'Sacred Flame', level: 0, school: 'evocation', resolution: 'save', save: 'DEX', damage: '1d8', damageType: 'radiant', desc: 'Radiance descends; the target makes a DEX save for no damage.' },
  'magic-missile': { id: 'magic-missile', name: 'Magic Missile', level: 1, school: 'evocation', resolution: 'auto', damage: '3d4+3', damageType: 'force', desc: 'Three darts strike unerringly — no attack roll, no save.' },
  'cure-wounds': { id: 'cure-wounds', name: 'Cure Wounds', level: 1, school: 'evocation', resolution: 'auto', heal: '1d8+3', desc: 'A touch mends a wounded ally.' },
  'healing-word': { id: 'healing-word', name: 'Healing Word', level: 1, school: 'evocation', resolution: 'auto', heal: '1d4+3', desc: 'A word of power heals an ally at range.' },
  'burning-hands': { id: 'burning-hands', name: 'Burning Hands', level: 1, school: 'evocation', resolution: 'save', save: 'DEX', halfOnSave: true, damage: '3d6', damageType: 'fire', desc: 'A cone of flame; DEX save for half.' },
  'guiding-bolt': { id: 'guiding-bolt', name: 'Guiding Bolt', level: 1, school: 'evocation', resolution: 'attack', damage: '4d6', damageType: 'radiant', desc: 'A flash of light; a ranged spell attack that lights the target up.' },
  'thunderwave': { id: 'thunderwave', name: 'Thunderwave', level: 1, school: 'evocation', resolution: 'save', save: 'CON', halfOnSave: true, damage: '2d8', damageType: 'thunder', desc: 'A wave of force; CON save for half, a failure pushes the target back.' },
  'scorching-ray': { id: 'scorching-ray', name: 'Scorching Ray', level: 2, school: 'evocation', resolution: 'attack', damage: '2d6', damageType: 'fire', desc: 'A ray of fire; a ranged spell attack (one ray resolved).' },
  'hold-person': { id: 'hold-person', name: 'Hold Person', level: 2, school: 'enchantment', resolution: 'save', save: 'WIS', condition: 'paralyzed', desc: 'A humanoid must make a WIS save or be paralyzed.' },
  'shatter': { id: 'shatter', name: 'Shatter', level: 3, school: 'evocation', resolution: 'save', save: 'CON', halfOnSave: true, damage: '3d8', damageType: 'thunder', desc: 'A ringing burst; CON save for half.' },
  'fireball': { id: 'fireball', name: 'Fireball', level: 3, school: 'evocation', resolution: 'save', save: 'DEX', halfOnSave: true, damage: '8d6', damageType: 'fire', desc: 'A roaring blast of flame; DEX save for half.' },
  'lightning-bolt': { id: 'lightning-bolt', name: 'Lightning Bolt', level: 3, school: 'evocation', resolution: 'save', save: 'DEX', halfOnSave: true, damage: '8d6', damageType: 'lightning', desc: 'A stroke of lightning in a line; DEX save for half.' },
};

/** Case/spacing-tolerant lookup of a spell id → its {@link Spell}. */
export function findSpell(input: string): Spell | undefined {
  const slug = input.trim().toLowerCase().replace(/\s+/g, '-');
  return SPELLBOOK[slug];
}

/** The catalog as a list, sorted by level then name. */
export function listSpellbook(): Spell[] {
  return Object.values(SPELLBOOK).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
}

/** A one-line catalog summary (`Fireball — L3 evocation, save DEX, 8d6 fire`). */
export function spellSummary(s: Spell): string {
  const lvl = s.level === 0 ? 'cantrip' : `L${s.level}`;
  const bits: string[] = [];
  if (s.resolution === 'attack') bits.push('spell attack');
  if (s.resolution === 'save' && s.save) bits.push(`save ${s.save}${s.halfOnSave ? ' (half)' : ''}`);
  if (s.damage) bits.push(`${s.damage}${s.damageType ? ` ${s.damageType}` : ''}`);
  if (s.heal) bits.push(`heal ${s.heal}`);
  if (s.condition) bits.push(s.condition);
  return `${s.name} — ${lvl} ${s.school}${bits.length ? `, ${bits.join(', ')}` : ''}`;
}

// ── Slots ────────────────────────────────────────────────────────────────────

/** True if the character has learned (`/dm learn`) this spell id. */
export function knowsSpell(player: Player, spellId: string): boolean {
  return (player.spells ?? []).includes(spellId);
}

/** Add a spell id to the character's known list (idempotent). */
export function learnSpell(player: Player, spellId: string): void {
  const known = new Set(player.spells ?? []);
  known.add(spellId);
  player.spells = [...known];
}

/**
 * Set the character's max slots per level from a list where index 0 is level 1
 * (`[4, 3, 2]` → four L1, three L2, two L3). Preserves already-used counts up to
 * the new max (so raising the cap mid-session doesn't refund a spent slot);
 * levels omitted from the list are cleared.
 */
export function setSlots(player: Player, maxByLevel: number[]): void {
  const prev = player.spellSlots ?? {};
  const slots: Record<number, { max: number; used: number }> = {};
  maxByLevel.forEach((max, i) => {
    if (max <= 0) return;
    const level = i + 1;
    const used = Math.min(prev[level]?.used ?? 0, max);
    slots[level] = { max, used };
  });
  player.spellSlots = slots;
}

/**
 * The lowest slot LEVEL at or above `minLevel` that still has an unspent slot,
 * or `undefined` if the caster has none available — so a cast uses the smallest
 * slot that can carry the spell and never wastes a big one. A cantrip
 * (`minLevel === 0`) always returns 0 (free, no slot needed).
 */
export function lowestAvailableSlot(player: Player, minLevel: number): number | undefined {
  if (minLevel <= 0) return 0;
  const slots = player.spellSlots ?? {};
  for (let level = minLevel; level <= 9; level++) {
    const s = slots[level];
    if (s && s.used < s.max) return level;
  }
  return undefined;
}

/** Spend one slot of the given level (>0). No-op for level 0 (cantrip). */
export function expendSlot(player: Player, level: number): void {
  if (level <= 0) return;
  const slots = player.spellSlots ?? (player.spellSlots = {});
  const s = slots[level];
  if (s && s.used < s.max) s.used++;
}

/** Restore every spent slot (a long rest). */
export function restoreSlots(player: Player): void {
  for (const s of Object.values(player.spellSlots ?? {})) s.used = 0;
}

/** A compact `L1 3/4  L2 1/2` slot summary (available/max), or `(no slots)`. */
export function slotSummary(player: Player): string {
  const slots = player.spellSlots ?? {};
  const levels = Object.keys(slots).map(Number).sort((a, b) => a - b);
  if (!levels.length) return '(no slots)';
  return levels.map((l) => `L${l} ${slots[l].max - slots[l].used}/${slots[l].max}`).join('  ');
}

// ── Cast resolution ────────────────────────────────────────────────────────────

/** A fully resolved cast — every number the engine computed, for display + narration. */
export interface SpellcastResult {
  caster: string;
  spell: string;
  spellId: string;
  level: number;          // the spell's base level (0 = cantrip)
  slotLevel?: number;     // the slot level to expend (undefined for cantrips)
  resolution: SpellResolution | 'utility';
  target?: string;
  // attack-roll spells
  d20?: number;
  attackTotal?: number;
  targetAC?: number;
  hit?: boolean;
  crit?: boolean;
  fumble?: boolean;
  // save spells
  saveAbility?: string;
  saveDC?: number;
  saveRoll?: number;
  saveTotal?: number;
  saved?: boolean;
  // effect
  damage?: number;
  damageRolls?: number[];
  damageType?: string;
  healed?: number;
  condition?: string;
  conditionApplied?: boolean;
  targetHp?: number;
  targetMaxHp?: number;
  targetDropped?: boolean;
}

/** The caster numbers `resolveCast` needs (its attack bonus + save DC). */
export interface CasterProfile {
  name: string;
  spellAttack: number;
  spellDc: number;
}

/** A target of a cast: the vitals whose hp changes, plus AC for attack-roll spells. */
export interface SpellTarget {
  name: string;
  ac: number;
  vitals: Vitals;
}

/**
 * Resolve one cast deterministically and apply its mechanical effect to the
 * target. PURE over the caster's slots (the caller expends them); it only
 * mutates the target's vitals, exactly like {@link resolveAttack}. `opts` lets a
 * test pin the caster's d20 (`d20`), the target's save die (`saveRoll`), the
 * target's save modifier (`targetSaveMod`, default 0), and the damage/heal seed.
 */
export function resolveCast(
  spell: Spell,
  caster: CasterProfile,
  target: SpellTarget | undefined,
  slotLevel: number | undefined,
  opts: { d20?: number; saveRoll?: number; targetSaveMod?: number; seed?: number } = {},
): SpellcastResult {
  const r: SpellcastResult = {
    caster: caster.name,
    spell: spell.name,
    spellId: spell.id,
    level: spell.level,
    slotLevel,
    resolution: spell.resolution ?? 'utility',
    target: target?.name,
    damageType: spell.damageType,
  };

  // A utility spell, or a targetable spell cast with no target, resolves to
  // pure narration — no roll, no state change.
  if (!spell.resolution || !target) return r;

  // Healing is always auto and never needs a to-hit/save.
  if (spell.heal) {
    const h = roll(spell.heal, caster.name, opts.seed);
    const change = applyHpDelta(target.vitals, target.name, Math.abs(h.total), 'heal');
    r.healed = Math.abs(h.total);
    r.targetHp = change.hp;
    r.targetMaxHp = change.maxHp;
    return r;
  }

  const rollDamage = (): { total: number; rolls: number[] } => {
    if (!spell.damage) return { total: 0, rolls: [] };
    const base = roll(spell.damage, caster.name, opts.seed);
    return { total: base.total, rolls: base.rolls };
  };

  if (spell.resolution === 'attack') {
    const d20 = opts.d20 ?? roll('d20', caster.name, opts.seed).rolls[0];
    r.d20 = d20;
    r.crit = d20 === 20;
    r.fumble = d20 === 1;
    r.attackTotal = d20 + caster.spellAttack;
    r.targetAC = target.ac;
    r.hit = r.crit || (!r.fumble && r.attackTotal >= target.ac);
    if (r.hit) {
      let { total, rolls } = rollDamage();
      if (r.crit && spell.damage) {
        const p = parseNotation(spell.damage);
        const extra = roll(`${p.numDice}d${p.dieSize}`, caster.name, opts.seed !== undefined ? opts.seed + 1 : undefined);
        total += extra.total;
        rolls = [...rolls, ...extra.rolls];
      }
      applyEffect(r, spell, target, total, rolls, true);
    }
    return r;
  }

  if (spell.resolution === 'save') {
    const die = opts.saveRoll ?? roll('d20', target.name, opts.seed).rolls[0];
    const mod = opts.targetSaveMod ?? 0;
    r.saveAbility = spell.save;
    r.saveDC = caster.spellDc;
    r.saveRoll = die;
    r.saveTotal = die + mod;
    // Mirror ability-check crits: a natural 20 always saves, a natural 1 never does.
    r.saved = die === 20 ? true : die === 1 ? false : r.saveTotal >= caster.spellDc;
    const { total, rolls } = rollDamage();
    if (r.saved) {
      // A successful save: half damage for a halfOnSave spell, otherwise nothing;
      // a condition never lands on a save.
      const dealt = spell.halfOnSave && spell.damage ? Math.floor(total / 2) : 0;
      if (dealt > 0) applyEffect(r, spell, target, dealt, rolls, false);
      else { r.damage = 0; r.damageRolls = spell.damage ? rolls : undefined; }
    } else {
      applyEffect(r, spell, target, total, rolls, true);
    }
    return r;
  }

  // auto (Magic Missile): full damage lands, condition (if any) applies.
  const { total, rolls } = rollDamage();
  applyEffect(r, spell, target, total, rolls, true);
  return r;
}

/** Apply damage (+ optional condition) to the target and record it on the result. */
function applyEffect(r: SpellcastResult, spell: Spell, target: SpellTarget, damage: number, rolls: number[], effectLands: boolean): void {
  if (spell.damage) {
    const change = applyHpDelta(target.vitals, target.name, -Math.abs(damage), 'damage');
    r.damage = Math.abs(damage);
    r.damageRolls = rolls;
    r.targetHp = change.hp;
    r.targetMaxHp = change.maxHp;
    r.targetDropped = (target.vitals.hp ?? 1) <= 0;
  }
  if (spell.condition && effectLands) {
    setCondition(target.vitals, target.name, spell.condition);
    r.condition = spell.condition;
    r.conditionApplied = true;
  } else if (spell.condition) {
    r.condition = spell.condition;
    r.conditionApplied = false;
  }
}

/** A one-line chat summary of a resolved cast. */
export function spellLine(r: SpellcastResult): string {
  const slot = r.slotLevel && r.slotLevel > 0 ? ` (L${r.slotLevel} slot)` : r.level === 0 ? ' (cantrip)' : '';
  const head = `✨ ${r.caster} casts ${r.spell}${slot}`;
  if (r.resolution === 'utility' || !r.target) return `${head}.`;

  if (r.healed !== undefined) {
    return `${head} on ${r.target}: heals ${r.healed} — HP ${r.targetHp}/${r.targetMaxHp}.`;
  }

  const dropped = r.targetDropped ? ` — ${r.target} drops!` : '';
  const cond = r.conditionApplied ? ` ${r.target} is **${r.condition}**!` : '';

  if (r.resolution === 'attack') {
    const rollTxt = `d20+${r.attackTotal! - r.d20!} = ${r.attackTotal} vs AC ${r.targetAC}`;
    if (!r.hit) {
      const why = r.fumble ? ' (natural 1)' : '';
      return `${head} at ${r.target}: ${rollTxt} → MISS${why}.`;
    }
    const critTag = r.crit ? ' 💥 CRIT (natural 20)' : '';
    const dmg = r.damage ? ` ${r.damage} ${r.damageType ?? ''} damage — HP ${r.targetHp}/${r.targetMaxHp}.` : '';
    return `${head} at ${r.target}: ${rollTxt} → HIT${critTag}!${dmg}${cond}${dropped}`;
  }

  if (r.resolution === 'save') {
    const saveTxt = `${r.target} rolls a ${r.saveAbility} save: ${r.saveTotal} vs DC ${r.saveDC} → ${r.saved ? 'SAVED' : 'FAILED'}`;
    const dmg = r.damage !== undefined && r.damage > 0 ? ` ${r.damage} ${r.damageType ?? ''} damage — HP ${r.targetHp}/${r.targetMaxHp}.` : r.damage === 0 && r.damageType ? ' No damage.' : '';
    return `${head} at ${r.target}: ${saveTxt}.${dmg}${cond}${dropped}`;
  }

  // auto
  const dmg = r.damage ? ` ${r.damage} ${r.damageType ?? ''} damage (auto-hit) — HP ${r.targetHp}/${r.targetMaxHp}.` : '';
  return `${head} at ${r.target}:${dmg}${cond}${dropped}`;
}
