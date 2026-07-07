/**
 * Monster stat blocks — the engine's compact, machine-owned form of a
 * creature's combat numbers, plus a small bundled bestiary.
 *
 * A stat block is deliberately minimal: exactly the fields the engine needs to
 * run a creature as a first-class combatant (initiative, AC, engine-owned HP)
 * plus a couple of narration hooks (attacks, a trait line) the DM can voice. It
 * is NOT a full monster manual entry — the DM narrates flavor; the engine owns
 * the numbers, the same division of labor players already get (see
 * `rules/mechanics.ts`).
 *
 * Browser-safe: pure data + string helpers, no `node:` imports. The catalog is
 * the parallel of the rules registry / content-pack catalog: add a monster =
 * add an entry.
 */

/** A single attack line the DM can narrate; numbers stay the engine's to resolve. */
export interface MonsterAttack {
  name: string;
  /** Attack-roll bonus (`+4`). The engine can roll `d20 + toHit` vs a target AC. */
  toHit: number;
  /** Damage dice notation (`1d6+2`), rolled by the engine's dice roller. */
  damage: string;
}

/** The engine-owned combat numbers for a creature. */
export interface StatBlock {
  /** Stable slug id (`goblin`, `dire-wolf`). */
  id: string;
  name: string;
  /** Armor Class — the DC an attack roll must meet to hit. */
  ac: number;
  /** Maximum (and starting) hit points; the engine clamps a live creature's hp to this. */
  maxHp: number;
  /** Initiative modifier added to the creature's d20 at combat start (DEX-ish). */
  initiativeMod: number;
  /** Challenge Rating, for display only (`1/4`, `2`). */
  cr?: string;
  /** Optional attacks the DM may narrate. */
  attacks?: MonsterAttack[];
  /** One-line flavor/trait note for the prompt (`Pack Tactics`, `Undead`). */
  traits?: string;
}

/**
 * The bundled bestiary — a spread of low-CR classics so a DM can drop an
 * encounter with no setup. Keyed by {@link StatBlock.id}.
 */
export const BESTIARY: Record<string, StatBlock> = {
  goblin: { id: 'goblin', name: 'Goblin', ac: 15, maxHp: 7, initiativeMod: 2, cr: '1/4', attacks: [{ name: 'Scimitar', toHit: 4, damage: '1d6+2' }], traits: 'Nimble Escape — can Disengage or Hide as a bonus action.' },
  kobold: { id: 'kobold', name: 'Kobold', ac: 12, maxHp: 5, initiativeMod: 2, cr: '1/8', attacks: [{ name: 'Dagger', toHit: 4, damage: '1d4+2' }], traits: 'Pack Tactics — advantage when an ally is adjacent to the target.' },
  'giant-rat': { id: 'giant-rat', name: 'Giant Rat', ac: 12, maxHp: 7, initiativeMod: 2, cr: '1/8', attacks: [{ name: 'Bite', toHit: 4, damage: '1d4+2' }], traits: 'Pack Tactics.' },
  bandit: { id: 'bandit', name: 'Bandit', ac: 12, maxHp: 11, initiativeMod: 1, cr: '1/8', attacks: [{ name: 'Scimitar', toHit: 3, damage: '1d6+1' }, { name: 'Light Crossbow', toHit: 3, damage: '1d8+1' }] },
  skeleton: { id: 'skeleton', name: 'Skeleton', ac: 13, maxHp: 13, initiativeMod: 2, cr: '1/4', attacks: [{ name: 'Shortsword', toHit: 4, damage: '1d6+2' }], traits: 'Undead — vulnerable to bludgeoning; immune to poison and exhaustion.' },
  zombie: { id: 'zombie', name: 'Zombie', ac: 8, maxHp: 22, initiativeMod: -2, cr: '1/4', attacks: [{ name: 'Slam', toHit: 3, damage: '1d6+1' }], traits: 'Undead Fortitude — a CON save can leave it at 1 hp instead of dropping.' },
  wolf: { id: 'wolf', name: 'Wolf', ac: 13, maxHp: 11, initiativeMod: 2, cr: '1/4', attacks: [{ name: 'Bite', toHit: 4, damage: '2d4+2' }], traits: 'Pack Tactics; a hit can knock a target prone (DC 11 STR).' },
  orc: { id: 'orc', name: 'Orc', ac: 13, maxHp: 15, initiativeMod: 1, cr: '1/2', attacks: [{ name: 'Greataxe', toHit: 5, damage: '1d12+3' }], traits: 'Aggressive — can dash toward a foe as a bonus action.' },
  'dire-wolf': { id: 'dire-wolf', name: 'Dire Wolf', ac: 14, maxHp: 37, initiativeMod: 2, cr: '1', attacks: [{ name: 'Bite', toHit: 5, damage: '2d6+3' }], traits: 'Pack Tactics; a hit can knock a target prone (DC 13 STR).' },
  ogre: { id: 'ogre', name: 'Ogre', ac: 11, maxHp: 59, initiativeMod: -1, cr: '2', attacks: [{ name: 'Greatclub', toHit: 6, damage: '2d8+4' }] },
};

/** Case/spacing-tolerant lookup of a bestiary id → its {@link StatBlock}. */
export function findStatBlock(input: string): StatBlock | undefined {
  const slug = input.trim().toLowerCase().replace(/\s+/g, '-');
  return BESTIARY[slug];
}

/** The bundled bestiary as a list, sorted by CR-ish (by maxHp as a proxy) then name. */
export function listBestiary(): StatBlock[] {
  return Object.values(BESTIARY).sort((a, b) => a.maxHp - b.maxHp || a.name.localeCompare(b.name));
}

/** A one-line roster summary of a stat block (`Goblin — AC 15, HP 7, CR 1/4`). */
export function statBlockLine(sb: StatBlock): string {
  return `${sb.name} — AC ${sb.ac}, HP ${sb.maxHp}, init ${sb.initiativeMod >= 0 ? '+' : ''}${sb.initiativeMod}${sb.cr ? `, CR ${sb.cr}` : ''}`;
}

/** A fuller multi-line description of a stat block, for `/dm bestiary <id>`. */
export function describeStatBlock(sb: StatBlock): string {
  const lines = [`**${sb.name}** (\`${sb.id}\`)`, statBlockLine(sb)];
  for (const atk of sb.attacks ?? []) {
    lines.push(`  • ${atk.name}: ${atk.toHit >= 0 ? '+' : ''}${atk.toHit} to hit, ${atk.damage} damage`);
  }
  if (sb.traits) lines.push(`  ${sb.traits}`);
  return lines.join('\n');
}
