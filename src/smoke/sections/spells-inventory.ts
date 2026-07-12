/**
 * Smoke cases — spellcasting (slots + cast resolution) and inventory/equipment.
 * Self-contained (each bot-driven section builds its own Bot/provider/storage/
 * channel), so new turns never pollute the shared MockProvider.lastPrompt or
 * round-robin timing other sections rely on — the isolation lesson from the
 * rules section applies here too.
 */
import type { IncomingMessage, OutgoingMessage, Player } from '../../core/types.js';
import { Bot } from '../../core/bot.js';
import { MemoryStorage } from '../../core/session/storage.js';
import {
  SPELLBOOK, expendSlot, findSpell, knowsSpell, learnSpell,
  listSpellbook, lowestAvailableSlot, resolveCast, restoreSlots, setSlots, slotSummary, spellSummary,
  type CasterProfile, type SpellTarget,
} from '../../core/rules/spells.js';
import {
  ARMORY, describeInventory, dropItem, equip, findCarried, findCatalogItem, giveItem,
  itemSummary, listArmory, recomputeDefense, unequip, useItem,
} from '../../core/rules/inventory.js';
import { DEFAULT_AC } from '../../core/rules/attacks.js';
import { check, MockProvider, Suite } from '../harness.js';
import type { SmokeCtx } from '../context.js';

const mkTarget = (name: string, ac: number, hp: number): SpellTarget => ({ name, ac, vitals: { hp, maxHp: hp, conditions: [] } });

export function registerSpellsInventory(suite: Suite, ctx: SmokeCtx): void {
  const { config } = ctx;

  suite.section('Rules engine: spell catalog + slot bookkeeping (pure)', async () => {
    check('spells: the bundled spellbook spans cantrips through level 3, every resolution kind',
      SPELLBOOK['fire-bolt'].level === 0 && SPELLBOOK['fireball'].level === 3 &&
      SPELLBOOK['fire-bolt'].resolution === 'attack' && SPELLBOOK['fireball'].resolution === 'save' &&
      SPELLBOOK['magic-missile'].resolution === 'auto' && Boolean(SPELLBOOK['cure-wounds'].heal));
    check('spells: findSpell is case/spacing tolerant, listSpellbook sorts by level',
      findSpell('Fire Bolt')?.id === 'fire-bolt' && findSpell('nope') === undefined &&
      listSpellbook()[0].level === 0 && listSpellbook().at(-1)!.level === 3);
    check('spells: spellSummary renders level, save, and damage', spellSummary(SPELLBOOK['fireball']).includes('L3') && spellSummary(SPELLBOOK['fireball']).includes('save DEX') && spellSummary(SPELLBOOK['fireball']).includes('8d6'));

    const p: Player = { userId: 'u', userName: 'Cas', characterName: 'Cas', hp: 12, maxHp: 12 };
    check('spells: learnSpell records a known spell, knowsSpell reads it back (idempotent)',
      (() => { learnSpell(p, 'fireball'); learnSpell(p, 'fireball'); return knowsSpell(p, 'fireball') && (p.spells ?? []).length === 1 && !knowsSpell(p, 'fire-bolt'); })());

    setSlots(p, [4, 3, 2]);
    check('spells: setSlots writes max-per-level and slotSummary reports available/max',
      p.spellSlots![1].max === 4 && p.spellSlots![3].max === 2 && slotSummary(p) === 'L1 4/4  L2 3/3  L3 2/2');
    check('spells: lowestAvailableSlot picks the smallest slot at/above the spell level; a cantrip needs none',
      lowestAvailableSlot(p, 0) === 0 && lowestAvailableSlot(p, 1) === 1 && lowestAvailableSlot(p, 3) === 3);
    expendSlot(p, 1); expendSlot(p, 1);
    check('spells: expendSlot spends a slot; lowestAvailableSlot still finds a higher one when a level is empty',
      p.spellSlots![1].used === 2 && slotSummary(p).startsWith('L1 2/4'));
    // Drain L3, then a level-3 request must climb (none higher exists → undefined).
    expendSlot(p, 3); expendSlot(p, 3);
    check('spells: a fully-spent top level returns no available slot', lowestAvailableSlot(p, 3) === undefined);
    check('spells: setSlots preserves already-used counts up to the new (lower) max',
      (() => { setSlots(p, [3]); return p.spellSlots![1].used === 2 && p.spellSlots![1].max === 3 && p.spellSlots![3] === undefined; })());
    restoreSlots(p);
    check('spells: restoreSlots refills every spent slot (a long rest)', p.spellSlots![1].used === 0);
  });

  suite.section('Rules engine: cast resolution — attack, save, auto, heal (pure/deterministic)', async () => {
    const caster: CasterProfile = { name: 'Cas', spellAttack: 5, spellDc: 15 };

    // ATTACK spell: a beating-AC d20 hits and applies damage; a low d20 misses.
    const t1 = mkTarget('Goblin', 13, 20);
    const hit = resolveCast(SPELLBOOK['fire-bolt'], caster, t1, 0, { d20: 15, seed: 3 });
    check('cast: an attack spell beating AC hits and damages the target', Boolean(hit.hit) && hit.damage! > 0 && t1.vitals.hp === 20 - hit.damage!);
    const t2 = mkTarget('Goblin', 13, 20);
    const miss = resolveCast(SPELLBOOK['fire-bolt'], caster, t2, 0, { d20: 2 });
    check('cast: an attack spell under AC misses and deals no damage', !miss.hit && (miss.damage ?? 0) === 0 && t2.vitals.hp === 20);
    // Natural 20 auto-hits and doubles the damage DICE (1d10 → 2 dice).
    const t3 = mkTarget('Ogre', 99, 60);
    const crit = resolveCast(SPELLBOOK['fire-bolt'], caster, t3, 0, { d20: 20, seed: 1 });
    check('cast: a natural-20 spell attack auto-crits and doubles the damage dice', Boolean(crit.hit && crit.crit) && crit.damageRolls!.length === 2);

    // SAVE spell (halfOnSave): a failed save takes full damage, a success takes half.
    const full = mkTarget('Goblin', 13, 100);
    const failed = resolveCast(SPELLBOOK['fireball'], caster, full, 3, { saveRoll: 2, seed: 9 });
    check('cast: a failed save takes full damage', !failed.saved && failed.damage! > 0 && full.vitals.hp === 100 - failed.damage!);
    const half = mkTarget('Goblin', 13, 100);
    const saved = resolveCast(SPELLBOOK['fireball'], caster, half, 3, { saveRoll: 20, seed: 9 });
    check('cast: a successful save against a halfOnSave spell takes half (nat 20 auto-saves)',
      Boolean(saved.saved) && saved.damage === Math.floor(failed.damage! / 2) && half.vitals.hp === 100 - saved.damage!);

    // SAVE spell that only imposes a condition (Hold Person): lands on a fail, not on a save.
    const held = mkTarget('Bandit', 12, 20);
    const holdFail = resolveCast(SPELLBOOK['hold-person'], caster, held, 2, { saveRoll: 1 });
    check('cast: a control spell imposes its condition on a failed save', Boolean(holdFail.conditionApplied) && held.vitals.conditions!.includes('paralyzed'));
    const held2 = mkTarget('Bandit', 12, 20);
    const holdSave = resolveCast(SPELLBOOK['hold-person'], caster, held2, 2, { saveRoll: 18 });
    check('cast: a control spell imposes nothing on a successful save', Boolean(holdSave.saved) && !holdSave.conditionApplied && !(held2.vitals.conditions ?? []).includes('paralyzed'));

    // AUTO spell (Magic Missile): always applies, no roll.
    const mm = mkTarget('Goblin', 99, 20);
    const auto = resolveCast(SPELLBOOK['magic-missile'], caster, mm, 1, { seed: 4 });
    check('cast: an auto spell always applies damage with no attack/save', auto.resolution === 'auto' && auto.damage! > 0 && mm.vitals.hp === 20 - auto.damage!);

    // HEAL spell: restores hp through applyHpDelta (clamped at maxHp).
    const wounded = mkTarget('Elaria', 10, 20); wounded.vitals.hp = 4;
    const cure = resolveCast(SPELLBOOK['cure-wounds'], caster, wounded, 1, { seed: 2 });
    check('cast: a healing spell restores hp (never overhealing past maxHp)', cure.healed! > 0 && wounded.vitals.hp! > 4 && wounded.vitals.hp! <= 20);

    // A lethal cast downs the target (unconscious via applyHpDelta).
    const dying = mkTarget('Kobold', 5, 3);
    const kill = resolveCast(SPELLBOOK['magic-missile'], caster, dying, 1, { seed: 1 });
    check('cast: a lethal cast clamps hp to 0 and downs the target', dying.vitals.hp === 0 && Boolean(kill.targetDropped) && dying.vitals.conditions!.includes('unconscious'));
  });

  suite.section('Rules engine: inventory catalog + equip drives AC/attack (pure)', async () => {
    check('inventory: the armory has weapons, armor, a shield, and potions',
      ARMORY['longsword'].kind === 'weapon' && ARMORY['chain-mail'].kind === 'armor' && ARMORY['shield'].kind === 'shield' && Boolean(ARMORY['potion-of-healing'].heal));
    check('inventory: findCatalogItem is case/spacing tolerant; itemSummary renders a weapon line',
      findCatalogItem('Chain Mail')?.id === 'chain-mail' && findCatalogItem('nope') === undefined && itemSummary(ARMORY['longsword']).includes('1d8+2'));
    check('inventory: listArmory groups weapons before misc', listArmory()[0].kind === 'weapon' && listArmory().at(-1)!.kind === 'misc');

    const p: Player = { userId: 'u', userName: 'Thorin', characterName: 'Thorin', hp: 10, maxHp: 10 };
    giveItem(p, 'longsword');
    giveItem(p, 'potion-of-healing', 2);
    const stack = giveItem(p, 'potion-of-healing', 1);
    check('inventory: giveItem adds and stacks identical items by qty', findCarried(p, 'longsword')?.qty === 1 && stack?.qty === 3);

    // Equip a weapon → it becomes the player's attack profile (read by attacks.ts).
    const eqW = equip(p, 'longsword');
    check('inventory: equipping a weapon sets the derived attack profile', 'slot' in eqW && p.attack?.name === 'Longsword' && p.attack?.damage === '1d8+2');

    // Equip armor + shield → AC recomputes (16 armor + 2 shield = 18).
    giveItem(p, 'chain-mail'); giveItem(p, 'shield');
    equip(p, 'chain-mail');
    check('inventory: equipping armor sets AC to the worn value', p.ac === 16);
    equip(p, 'shield');
    check('inventory: equipping a shield adds its bonus to the worn AC', p.ac === 18);
    unequip(p, 'armor');
    check('inventory: unequipping armor recomputes AC to unarmored + shield', p.ac === DEFAULT_AC + 2);
    unequip(p, 'weapon');
    check('inventory: unequipping a weapon clears the derived profile (back to default)', p.attack === undefined);
    check('inventory: recomputeDefense with nothing worn is unarmored', (() => { unequip(p, 'shield'); recomputeDefense(p); return p.ac === DEFAULT_AC; })());

    // Use a potion → heals through applyHpDelta and decrements the stack.
    p.hp = 3;
    const used = useItem(p, 'potion-of-healing', 5);
    check('inventory: useItem quaffs a potion, heals through the engine, and decrements the stack',
      !('error' in used) && used.healed > 0 && p.hp! > 3 && findCarried(p, 'potion-of-healing')?.qty === 2);
    check('inventory: useItem refuses a non-potion', 'error' in useItem(p, 'longsword'));

    // Dropping the last copy of an equipped item unequips it.
    giveItem(p, 'plate'); equip(p, 'plate');
    check('inventory: an equipped item drives AC before it is dropped', p.ac === 18);
    dropItem(p, 'plate');
    check('inventory: dropping the last copy of an equipped item unequips it and recomputes AC',
      findCarried(p, 'plate') === undefined && p.equipped?.armor === undefined && p.ac === DEFAULT_AC);
    check('inventory: describeInventory lists carried items', describeInventory(p).includes('Carried:'));
  });

  suite.section('Rules engine: /dm cast, /dm slots, /dm learn, /dm rest through the bot (fully isolated)', async () => {
    const mp = new MockProvider();
    const sBot = new Bot(config, mp, new MemoryStorage());
    const sOut: OutgoingMessage[] = [];
    const sSend = async (m: OutgoingMessage) => void sOut.push(m);
    const sf = (userId: string, userName: string, text: string): IncomingMessage => ({ platform: 'cli', channelId: 'spells', userId, userName, text });
    const sessionOf = () => sBot['sessions'].get(sf('u1', 'Alice', ''));
    await sBot.handle(sf('u1', 'Alice', '/dm new'), sSend);
    await sBot.handle(sf('u1', 'Alice', '/dm join Elaria'), sSend);
    await sBot.handle(sf('u1', 'Alice', '/dm monster add goblin'), sSend);

    // /dm learn + /dm slots set up a caster.
    sOut.length = 0;
    await sBot.handle(sf('u1', 'Alice', '/dm learn Elaria magic-missile'), sSend);
    check('cast-bot: /dm learn teaches a spell', sOut.at(-1)!.text.includes('Magic Missile') && knowsSpell((await sessionOf())!.players.u1, 'magic-missile'));
    await sBot.handle(sf('u1', 'Alice', '/dm slots Elaria 2'), sSend);
    check('cast-bot: /dm slots sets max slots per level', (await sessionOf())!.players.u1.spellSlots![1].max === 2);

    // A cast against an unlearned spell is refused before touching slots.
    sOut.length = 0;
    await sBot.handle(sf('u1', 'Alice', '/dm cast Elaria fireball at Goblin'), sSend);
    check("cast-bot: casting a spell the caster hasn't learned is refused", /hasn.t learned/.test(sOut.at(-1)!.text));

    // A leveled cast expends a slot and applies engine damage to the monster.
    sOut.length = 0;
    await sBot.handle(sf('u1', 'Alice', '/dm cast Elaria magic-missile at Goblin'), sSend);
    const afterCast = await sessionOf();
    const gob = () => (afterCast?.encounter?.order ?? []).find((c) => c.name === 'Goblin');
    check('cast-bot: an auto cast reports the spell, spends a slot, and damages the monster',
      /casts Magic Missile/.test(sOut.at(-1)!.text) && afterCast!.players.u1.spellSlots![1].used === 1 && (gob()?.hp ?? 7) < 7);

    // A cantrip is free — no slot spent.
    await sBot.handle(sf('u1', 'Alice', '/dm learn Elaria fire-bolt'), sSend);
    const usedBefore = (await sessionOf())!.players.u1.spellSlots![1].used;
    sOut.length = 0;
    await sBot.handle(sf('u1', 'Alice', '/dm cast Elaria fire-bolt at Goblin'), sSend);
    check('cast-bot: a cantrip costs no slot', /casts Fire Bolt \(cantrip\)/.test(sOut.at(-1)!.text) && (await sessionOf())!.players.u1.spellSlots![1].used === usedBefore);

    // A target is required for a spell with a mechanical effect.
    sOut.length = 0;
    await sBot.handle(sf('u1', 'Alice', '/dm cast Elaria magic-missile'), sSend);
    check('cast-bot: a damaging spell with no target shows usage', /needs a target/.test(sOut.at(-1)!.text));

    // Drain the last slot, then a leveled cast is refused for lack of a slot.
    await sBot.handle(sf('u1', 'Alice', '/dm cast Elaria magic-missile at Goblin'), sSend); // uses slot 2/2
    sOut.length = 0;
    await sBot.handle(sf('u1', 'Alice', '/dm cast Elaria magic-missile at Goblin'), sSend);
    check('cast-bot: a leveled cast with no slot left is refused', /no level-1-or-higher slot/.test(sOut.at(-1)!.text));

    // /dm rest restores slots (and heals).
    sOut.length = 0;
    await sBot.handle(sf('u1', 'Alice', '/dm rest Elaria'), sSend);
    check('cast-bot: /dm rest restores spent slots', (await sessionOf())!.players.u1.spellSlots![1].used === 0 && /long rest/.test(sOut.at(-1)!.text));

    // /dm spellbook surfaces known spells + slots.
    sOut.length = 0;
    await sBot.handle(sf('u1', 'Alice', '/dm spellbook Elaria'), sSend);
    check('cast-bot: /dm spellbook lists known spells and slots', /Magic Missile/.test(sOut.at(-1)!.text) && /Slots:/.test(sOut.at(-1)!.text));

    // The caster's slots + known spells reach the narrator prompt (read-only context).
    mp.narration = 'The chamber hums. (mock)';
    sOut.length = 0;
    await sBot.handle(sf('u1', 'Alice', 'I study the runes'), sSend);
    check('cast-bot: spell slots and known spells reach the narrator prompt', /Spell slots:/.test(mp.lastPrompt) && /Knows:/.test(mp.lastPrompt));
  });

  suite.section('Rules engine: /dm give, /dm equip, /dm use through the bot (fully isolated)', async () => {
    const mp = new MockProvider();
    const iBot = new Bot(config, mp, new MemoryStorage());
    const iOut: OutgoingMessage[] = [];
    const iSend = async (m: OutgoingMessage) => void iOut.push(m);
    const jf = (userId: string, userName: string, text: string): IncomingMessage => ({ platform: 'cli', channelId: 'inv', userId, userName, text });
    const sessionOf = () => iBot['sessions'].get(jf('u1', 'Alice', ''));
    await iBot.handle(jf('u1', 'Alice', '/dm new'), iSend);
    await iBot.handle(jf('u1', 'Alice', '/dm join Thorin'), iSend);
    await iBot.handle(jf('u1', 'Alice', '/dm monster add goblin'), iSend);

    // /dm give hands out catalog items (with quantity).
    iOut.length = 0;
    await iBot.handle(jf('u1', 'Alice', '/dm give Thorin potion-of-healing 2'), iSend);
    check('inv-bot: /dm give hands out an item with a quantity', /Potion of Healing/.test(iOut.at(-1)!.text) && findCarried((await sessionOf())!.players.u1, 'potion-of-healing')?.qty === 2);
    iOut.length = 0;
    await iBot.handle(jf('u1', 'Alice', '/dm give Thorin nonsense'), iSend);
    check('inv-bot: /dm give rejects an unknown item', /No item matches/.test(iOut.at(-1)!.text));

    // /dm equip a weapon → the equipped weapon is what /dm attack swings.
    await iBot.handle(jf('u1', 'Alice', '/dm give Thorin greataxe'), iSend);
    iOut.length = 0;
    await iBot.handle(jf('u1', 'Alice', '/dm equip Thorin greataxe'), iSend);
    check('inv-bot: /dm equip a weapon sets the attack profile', /Greataxe/.test(iOut.at(-1)!.text) && (await sessionOf())!.players.u1.attack?.name === 'Greataxe');
    iOut.length = 0;
    await iBot.handle(jf('u1', 'Alice', '/dm attack Thorin vs Goblin'), iSend);
    check('inv-bot: /dm attack swings the equipped weapon by name', /attacks Goblin \(Greataxe\)/.test(iOut.at(-1)!.text));

    // /dm equip armor + shield → AC recomputes and is what a monster rolls against.
    await iBot.handle(jf('u1', 'Alice', '/dm give Thorin chain-mail'), iSend);
    await iBot.handle(jf('u1', 'Alice', '/dm give Thorin shield'), iSend);
    await iBot.handle(jf('u1', 'Alice', '/dm equip Thorin chain-mail'), iSend);
    iOut.length = 0;
    await iBot.handle(jf('u1', 'Alice', '/dm equip Thorin shield'), iSend);
    check('inv-bot: worn armor + shield sets AC (16 + 2 = 18)', (await sessionOf())!.players.u1.ac === 18 && /AC 18/.test(iOut.at(-1)!.text));

    // /dm use a potion heals the character.
    await iBot.handle(jf('u1', 'Alice', '/dm damage Thorin 8'), iSend);
    iOut.length = 0;
    await iBot.handle(jf('u1', 'Alice', '/dm use Thorin potion-of-healing'), iSend);
    const afterUse = await sessionOf();
    check('inv-bot: /dm use drinks a potion and heals through the engine',
      /drinks a \*\*Potion of Healing\*\*/.test(iOut.at(-1)!.text) && (afterUse!.players.u1.hp ?? 0) > 2 && findCarried(afterUse!.players.u1, 'potion-of-healing')?.qty === 1);

    // /dm unequip clears the slot; equipped gear reaches the narrator prompt.
    iOut.length = 0;
    await iBot.handle(jf('u1', 'Alice', '/dm unequip Thorin weapon'), iSend);
    check('inv-bot: /dm unequip a weapon reverts to the default profile', (await sessionOf())!.players.u1.attack === undefined);
    mp.narration = 'The hall echoes. (mock)';
    iOut.length = 0;
    await iBot.handle(jf('u1', 'Alice', 'I brace behind my shield'), iSend);
    check('inv-bot: equipped gear reaches the narrator prompt', /Equipped:/.test(mp.lastPrompt) && /Chain Mail/.test(mp.lastPrompt));

    // /dm inventory shows the pack.
    iOut.length = 0;
    await iBot.handle(jf('u1', 'Alice', '/dm inventory Thorin'), iSend);
    check('inv-bot: /dm inventory shows equipped + carried', /Equipped:/.test(iOut.at(-1)!.text) && /Carried:/.test(iOut.at(-1)!.text));
  });
}
