/**
 * Inventory & equipment — the engine owns what a character carries and what it
 * has equipped, and derives the mechanical consequences (a worn suit of armor
 * IS your AC; a wielded weapon IS your attack profile). Same division of labor
 * as the rest of the rules layer: the engine holds the numbers, the DM narrates
 * the fiction ("you shoulder the greataxe").
 *
 * The key integration: equipping doesn't invent a parallel stat system, it
 * writes the SAME {@link Player.ac} / {@link Player.attack} that `attacks.ts`
 * already reads. So a monster's swing resolves against your equipped armor, and
 * `/dm attack` swings your equipped weapon, with no extra plumbing — equip is a
 * convenience that keeps gear and combat stats from ever disagreeing.
 *
 * Items come from the bundled {@link ARMORY}; a character's copy is a stackable
 * instance keyed by the catalog id. Browser-safe: types + `mechanics.ts` only.
 */
import type { Item, Player } from '../types.js';
import { roll } from '../engine/dice.js';
import { applyHpDelta } from './mechanics.js';
import { DEFAULT_AC } from './attacks.js';

/**
 * The bundled armory — a starter kit of weapons, armor, a shield, potions, and
 * mundane gear so a character can outfit from nothing. Weapon `toHit`/`damage`
 * bake in a typical modifier (like {@link DEFAULT_PLAYER_ATTACK}); armor `ac` is
 * the flat worn AC. Keyed by {@link Item.id}; `qty` is filled in on pickup.
 */
export const ARMORY: Record<string, Omit<Item, 'qty'>> = {
  dagger: { id: 'dagger', name: 'Dagger', kind: 'weapon', toHit: 4, damage: '1d4+2', desc: 'A light, quick blade — also throwable.' },
  shortsword: { id: 'shortsword', name: 'Shortsword', kind: 'weapon', toHit: 4, damage: '1d6+2', desc: 'A finesse blade favored by rogues.' },
  longsword: { id: 'longsword', name: 'Longsword', kind: 'weapon', toHit: 4, damage: '1d8+2', desc: 'The versatile knightly standard.' },
  rapier: { id: 'rapier', name: 'Rapier', kind: 'weapon', toHit: 5, damage: '1d8+3', desc: 'A precise duelist\'s point.' },
  warhammer: { id: 'warhammer', name: 'Warhammer', kind: 'weapon', toHit: 5, damage: '1d8+3', desc: 'A heavy head that caves in armor.' },
  greataxe: { id: 'greataxe', name: 'Greataxe', kind: 'weapon', toHit: 5, damage: '1d12+3', desc: 'A brutal two-handed cleaver.' },
  greatsword: { id: 'greatsword', name: 'Greatsword', kind: 'weapon', toHit: 5, damage: '2d6+3', desc: 'A massive blade swung in wide arcs.' },
  shortbow: { id: 'shortbow', name: 'Shortbow', kind: 'weapon', toHit: 4, damage: '1d6+2', desc: 'A ranged option for skirmishers.' },
  longbow: { id: 'longbow', name: 'Longbow', kind: 'weapon', toHit: 5, damage: '1d8+3', desc: 'A long-range hunter\'s bow.' },
  'leather-armor': { id: 'leather-armor', name: 'Leather Armor', kind: 'armor', ac: 11, desc: 'Supple hide — light and quiet.' },
  'chain-shirt': { id: 'chain-shirt', name: 'Chain Shirt', kind: 'armor', ac: 13, desc: 'Interlocking rings under a coat.' },
  breastplate: { id: 'breastplate', name: 'Breastplate', kind: 'armor', ac: 14, desc: 'A fitted steel chest piece.' },
  'chain-mail': { id: 'chain-mail', name: 'Chain Mail', kind: 'armor', ac: 16, desc: 'A full hauberk of heavy rings.' },
  plate: { id: 'plate', name: 'Plate Armor', kind: 'armor', ac: 18, desc: 'Head-to-toe shaped steel — the best worn AC.' },
  shield: { id: 'shield', name: 'Shield', kind: 'shield', acBonus: 2, desc: 'A board strapped to the arm; +2 AC.' },
  'potion-of-healing': { id: 'potion-of-healing', name: 'Potion of Healing', kind: 'potion', heal: '2d4+2', desc: 'Quaff to regain hit points.' },
  'potion-of-greater-healing': { id: 'potion-of-greater-healing', name: 'Potion of Greater Healing', kind: 'potion', heal: '4d4+4', desc: 'A stronger draught.' },
  torch: { id: 'torch', name: 'Torch', kind: 'misc', desc: 'Sheds light; burns for about an hour.' },
  rope: { id: 'rope', name: 'Rope (50 ft)', kind: 'misc', desc: 'Hempen rope, for climbing or binding.' },
  rations: { id: 'rations', name: 'Rations (1 day)', kind: 'misc', desc: 'Dry travel food.' },
  'thieves-tools': { id: 'thieves-tools', name: "Thieves' Tools", kind: 'misc', desc: 'Picks and probes for locks and traps.' },
};

/** Case/spacing-tolerant lookup of a catalog id → its (qty-less) {@link Item}. */
export function findCatalogItem(input: string): Omit<Item, 'qty'> | undefined {
  const slug = input.trim().toLowerCase().replace(/\s+/g, '-');
  return ARMORY[slug];
}

/** The armory as a list, grouped by kind order (weapon→armor→shield→potion→misc) then name. */
export function listArmory(): Array<Omit<Item, 'qty'>> {
  const order: Item['kind'][] = ['weapon', 'armor', 'shield', 'potion', 'misc'];
  return Object.values(ARMORY).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name));
}

/** A one-line catalog summary of an item (`Longsword — weapon, +4, 1d8+2`). */
export function itemSummary(it: Omit<Item, 'qty'>): string {
  const bits: string[] = [it.kind];
  if (it.kind === 'weapon') bits.push(`${it.toHit! >= 0 ? '+' : ''}${it.toHit}`, it.damage ?? '');
  if (it.kind === 'armor') bits.push(`AC ${it.ac}`);
  if (it.kind === 'shield') bits.push(`+${it.acBonus} AC`);
  if (it.kind === 'potion' && it.heal) bits.push(`heal ${it.heal}`);
  return `${it.name} — ${bits.filter(Boolean).join(', ')}`;
}

// ── Inventory mutations ────────────────────────────────────────────────────────

/** Find a carried item on a player by catalog id (case/spacing tolerant). */
export function findCarried(player: Player, input: string): Item | undefined {
  const slug = input.trim().toLowerCase().replace(/\s+/g, '-');
  return (player.inventory ?? []).find((it) => it.id === slug);
}

/**
 * Add `qty` of a catalog item to the player's pack, stacking onto an existing
 * entry. Returns the (created or updated) stack, or `undefined` if the id isn't
 * in the armory.
 */
export function giveItem(player: Player, catalogId: string, qty = 1): Item | undefined {
  const cat = findCatalogItem(catalogId);
  if (!cat || qty <= 0) return undefined;
  const inv = player.inventory ?? (player.inventory = []);
  const existing = inv.find((it) => it.id === cat.id);
  if (existing) {
    existing.qty += qty;
    return existing;
  }
  const item: Item = { ...cat, qty };
  inv.push(item);
  return item;
}

/**
 * Remove `qty` of an item from the pack (default all of it). If the character
 * had it equipped and the whole stack is gone, it is unequipped too (stats
 * recomputed). Returns true if anything was removed.
 */
export function dropItem(player: Player, catalogId: string, qty?: number): boolean {
  const inv = player.inventory ?? [];
  const item = findCarried(player, catalogId);
  if (!item) return false;
  const take = qty === undefined ? item.qty : Math.min(qty, item.qty);
  if (take <= 0) return false;
  item.qty -= take;
  if (item.qty <= 0) {
    player.inventory = inv.filter((it) => it !== item);
    // If the last copy left the pack, it can't stay equipped.
    for (const slot of ['weapon', 'armor', 'shield'] as const) {
      if (player.equipped?.[slot] === item.id) unequip(player, slot);
    }
  }
  return true;
}

/** The item kind a given equip slot accepts. */
const SLOT_KIND: Record<'weapon' | 'armor' | 'shield', Item['kind']> = { weapon: 'weapon', armor: 'armor', shield: 'shield' };

/**
 * Equip a carried weapon/armor/shield, writing the derived {@link Player.attack}
 * / {@link Player.ac}. Returns the slot it went into, or an error string if the
 * item isn't carried or isn't equippable. Equipping into an occupied slot
 * replaces the previous item.
 */
export function equip(player: Player, catalogId: string): { slot: 'weapon' | 'armor' | 'shield' } | { error: string } {
  const item = findCarried(player, catalogId);
  if (!item) return { error: 'not-carried' };
  const slot = (Object.keys(SLOT_KIND) as Array<'weapon' | 'armor' | 'shield'>).find((s) => SLOT_KIND[s] === item.kind);
  if (!slot) return { error: 'not-equippable' };
  player.equipped = { ...(player.equipped ?? {}), [slot]: item.id };
  if (slot === 'weapon') {
    player.attack = { name: item.name, toHit: item.toHit ?? 0, damage: item.damage ?? '1d4' };
  } else {
    recomputeDefense(player);
  }
  return { slot };
}

/** Unequip a slot, clearing the derived stat it drove. Returns true if something was equipped. */
export function unequip(player: Player, slot: 'weapon' | 'armor' | 'shield'): boolean {
  const had = Boolean(player.equipped?.[slot]);
  if (player.equipped) delete player.equipped[slot];
  if (slot === 'weapon') {
    player.attack = undefined; // falls back to the default weapon profile in attacks.ts
  } else {
    recomputeDefense(player);
  }
  return had;
}

/**
 * Recompute {@link Player.ac} from equipped armor + shield: worn armor's flat AC
 * (or unarmored {@link DEFAULT_AC}) plus any shield bonus. Called after any
 * armor/shield change so the AC an attacker rolls against always reflects the
 * gear actually worn.
 */
export function recomputeDefense(player: Player): void {
  const inv = player.inventory ?? [];
  const armorId = player.equipped?.armor;
  const shieldId = player.equipped?.shield;
  const armor = armorId ? inv.find((it) => it.id === armorId) : undefined;
  const shield = shieldId ? inv.find((it) => it.id === shieldId) : undefined;
  const base = armor?.ac ?? DEFAULT_AC;
  player.ac = base + (shield?.acBonus ?? 0);
}

/**
 * Quaff/consume one of a usable item (a potion). Rolls and applies its healing
 * through {@link applyHpDelta} and decrements the stack. Returns the healed
 * amount + resulting hp, or an error string. `seed` is for deterministic tests.
 */
export function useItem(player: Player, catalogId: string, seed?: number): { healed: number; hp: number; maxHp: number; item: string } | { error: string } {
  const item = findCarried(player, catalogId);
  if (!item) return { error: 'not-carried' };
  if (item.kind !== 'potion' || !item.heal) return { error: 'not-usable' };
  const h = roll(item.heal, player.characterName || player.userName, seed);
  const change = applyHpDelta(player, player.characterName || player.userName, Math.abs(h.total), 'heal');
  const name = item.name;
  dropItem(player, item.id, 1);
  return { healed: Math.abs(h.total), hp: change.hp!, maxHp: change.maxHp!, item: name };
}

/** A multi-line inventory listing for `/dm inventory`: equipped first, then the pack. */
export function describeInventory(player: Player): string {
  const inv = player.inventory ?? [];
  const eq = player.equipped ?? {};
  const equippedLine = (['weapon', 'armor', 'shield'] as const)
    .map((slot) => {
      const id = eq[slot];
      if (!id) return '';
      const it = inv.find((i) => i.id === id);
      return `  ${slot}: ${it?.name ?? id}`;
    })
    .filter(Boolean)
    .join('\n');
  const packLine = inv.length
    ? inv.map((it) => `  • ${it.name}${it.qty > 1 ? ` ×${it.qty}` : ''} (${it.kind})`).join('\n')
    : '  (empty)';
  const eqBlock = equippedLine ? `Equipped:\n${equippedLine}\n` : '';
  return `${eqBlock}Carried:\n${packLine}`;
}
