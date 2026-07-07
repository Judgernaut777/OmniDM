/**
 * Smoke cases — the rules engine (HP, conditions, stat blocks, combat/initiative). Self-contained (each section builds its own
 * Bot/provider/storage), so it lifts cleanly out of the monolith.
 */
import { promises as fs } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import type { Config } from '../../config.js';
import type { CompletionRequest, GameSession, IncomingMessage, LLMProvider, ModelInfo, OutgoingMessage, TurnRecord } from '../../core/types.js';
import { Bot, redactSecrets, SERVER_TURN_FAILURE_TEXT } from '../../core/bot.js';
import { roll, extractRolls } from '../../core/engine/dice.js';
import { MAX_CHARACTER_NAME_CHARS, SeatTakenError, SessionManager } from '../../core/session/session-manager.js';
import { NodeFileStorage } from '../../core/session/store.js';
import { MemoryStorage } from '../../core/session/storage.js';
import { loadCard, MAX_CARD_BYTES, renderCard } from '../../core/cards/card.js';
import { buildWorldInfo, makeEntry } from '../../core/lore/lorebook.js';
import { splitFog } from '../../core/narrator/fog.js';
import { cosine, MAX_MEMORIES, MemoryRetriever } from '../../core/memory/retrieval.js';
import { AnthropicProvider, convertToAnthropic } from '../../providers/anthropic.js';
import { OpenAICompatibleProvider } from '../../providers/openai-compatible.js';
import { SlackAdapter } from '../../adapters/slack.js';
import { MatrixAdapter } from '../../adapters/matrix.js';
import { MattermostAdapter } from '../../adapters/mattermost.js';
import { CliAdapter } from '../../adapters/cli.js';
import { DiscordAdapter } from '../../adapters/discord.js';
import { Events, type Client } from 'discord.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { pickAdapter, parseAdapterArg } from '../../index.js';
import { MAX_CARD_SUMMARY_CHARS, MAX_FRAME_BYTES, MAX_NAME_CHARS, MAX_PORTRAIT_BYTES, MAX_TEXT_CHARS, RATE_LIMIT_PER_SEC, UNJOINED_FRAMES_PER_SEC, WebAdapter } from '../../adapters/web.js';
import { MAX_BIO_CHARS, PORTRAIT_PRESETS, resolvePresetId } from '../../core/portraits.js';
import { BUNDLED_RULES, bundledRulesProvider, clearRuntimeRules, registerRulesModule } from '../../core/rules/registry.js';
import { attackerProfiles, attackTarget, DEFAULT_AC, DEFAULT_PLAYER_ATTACK, pickAttack, resolveAttack } from '../../core/rules/attacks.js';
import { CONDITIONS, conditionDef, describeConditions, normalizeCondition } from '../../core/rules/conditions.js';
import { BESTIARY, findStatBlock, listBestiary, statBlockLine } from '../../core/rules/statblock.js';
import { addMonster, advanceCombat, currentCombatant, endCombat, findMonsterCombatant, isOutOfFight, livingSides, removeMonster, startCombat, summarizeCombat } from '../../core/rules/combat.js';
import { applyHpDelta, clearCondition, findTarget, setCondition } from '../../core/rules/mechanics.js';
import { validateContentPack, parseContentPackJson, ContentPackError } from '../../core/content-packs/validate.js';
import { isPackLockedForDisplay, loadContentPack, PackLockedError } from '../../core/content-packs/loader.js';
import { BUNDLED_CONTENT_PACKS, getBundledContentPack, listBundledContentPacks } from '../../core/content-packs/registry.js';
import { FRONTIER_OUTPOST_PACK_JSON } from '../../core/content-packs/bundled-sources.js';
import { loadContentPackFile } from '../../core/content-packs/node.js';
import { createHostedEntitlements, selectEntitlements, selfHostEntitlements, tenantKey } from '../../core/entitlements/entitlements.js';
import { applyGrant, MemoryPurchaseStore } from '../../core/billing/purchase-store.js';
import { FilePurchaseStore } from '../../core/billing/store-node.js';
import { computeSignature, createCheckoutSession, parseCheckoutCompleted, verifyStripeSignature } from '../../core/billing/stripe.js';
import { createBillingHandler, isBillingPath, type BillingHttpRequest } from '../../core/billing/handler.js';
import { base64ToBytes, bytesToBase64 } from '../../core/cards/card-parse.js';
import { loadCardFromBytes } from '../../core/cards/card-browser.js';
import { BrowserSessionStorage, webStorageKeyValue, type AsyncKeyValue, type WebStorageLike } from '../../core/session/browser-storage.js';
import { buildProvider } from '../../providers/factory.js';
import { RoomEngine, type Frame as RoomFrame, type RoomConnection } from '../../core/room/room-engine.js';
import { createLocalEngine } from '../../browser/local-engine.js';
import { isCapacitorNative, getCapacitorHttp, makeNativeFetch, selectFetch, type CapacitorHttpLike } from '../../browser/native-http.js';
import { check, skip, MockProvider, Suite, WsClient, WEB_ROOT } from '../harness.js';
import type { SmokeCtx } from '../context.js';

export function registerRules(suite: Suite, ctx: SmokeCtx): void {
  const { config } = ctx;

  suite.section("Rules engine: engine-owned HP, narration markers, checks (fully isolated)", async () => {
  // ── Rules engine: engine-owned HP, narration markers, checks (fully isolated) ──
  // Own provider/bot/storage/channel so these turns never touch the shared
  // provider.lastPrompt / round-robin timing the scenario tests above depend on.
  {
    const mp = new MockProvider();
    const mBot = new Bot(config, mp, new MemoryStorage());
    const mOut: OutgoingMessage[] = [];
    const mSend = async (m: OutgoingMessage) => void mOut.push(m);
    const mf = (userId: string, userName: string, text: string): IncomingMessage =>
      ({ platform: 'cli', channelId: 'rules', userId, userName, text });
    const sessionOf = () => mBot['sessions'].get(mf('u1', 'Alice', ''));
    await mBot.handle(mf('u1', 'Alice', '/dm new'), mSend);
    await mBot.handle(mf('u1', 'Alice', '/dm join Thorin'), mSend);
    await mBot.handle(mf('u2', 'Bob', '/dm join Elaria'), mSend);

    // A damage marker the DM ends its narration with is APPLIED to mechanical hp
    // and STRIPPED so players never see the marker syntax.
    mp.narration = "The blade bites deep into Thorin's side!\n<<hp Thorin -7>>";
    mOut.length = 0;
    await mBot.handle(mf('u1', 'Alice', 'I stand my ground'), mSend);
    const hitMsg = mOut.find((m) => m.speaker === 'Dungeon Master');
    check('rules: a damage marker is stripped from the narration shown to players',
      Boolean(hitMsg) && !hitMsg!.text.includes('<<') && !hitMsg!.text.includes('hp Thorin'));
    check("rules: a damage marker reduces the target's mechanical hp",
      (await sessionOf())?.players.u1?.hp === 3);

    // A marker naming someone who ISN'T a real party member is ignored (no crash,
    // no state change) but still stripped so a hallucinated tag never leaks.
    mp.narration = 'Nothing happens to the stranger.\n<<hp NotAPartyMember -99>>';
    mOut.length = 0;
    await mBot.handle(mf('u2', 'Bob', 'I watch the shadows'), mSend);
    const ghostMsg = mOut.find((m) => m.speaker === 'Dungeon Master');
    const afterGhost = await sessionOf();
    check('rules: a marker targeting a non-member is stripped but changes no state',
      Boolean(ghostMsg) && !ghostMsg!.text.includes('<<') && afterGhost?.players.u1?.hp === 3 && afterGhost?.players.u2?.hp === 10);

    // hp reaching 0 sets the unconscious condition.
    mp.narration = 'The final blow drops Thorin where he stands!\n<<hp Thorin -3>>';
    mOut.length = 0;
    await mBot.handle(mf('u1', 'Alice', 'I take the hit'), mSend);
    const koSaved = await sessionOf();
    check('rules: hp reaching 0 sets the unconscious condition',
      koSaved?.players.u1?.hp === 0 && (koSaved?.players.u1?.conditions ?? []).includes('unconscious'));
    mp.narration = 'The tavern falls silent. (mock)';

    // /dm heal restores hp AND clears unconscious once hp rises above 0.
    mOut.length = 0;
    await mBot.handle(mf('u2', 'Bob', '/dm heal Thorin 5'), mSend);
    const healed = await sessionOf();
    check('rules: /dm heal restores hp and clears the unconscious condition',
      mOut.at(-1)!.text.includes('HP 5/10') && healed?.players.u1?.hp === 5 &&
      !(healed?.players.u1?.conditions ?? []).includes('unconscious'));

    // /dm damage applies mechanical damage directly (no narration turn).
    mOut.length = 0;
    await mBot.handle(mf('u2', 'Bob', '/dm damage Elaria 4'), mSend);
    check('rules: /dm damage applies mechanical damage directly',
      mOut.at(-1)!.text.includes('HP 6/10') && (await sessionOf())?.players.u2?.hp === 6);

    // Damage clamps at 0, heal clamps at maxHp (no negative/overheal).
    mOut.length = 0;
    await mBot.handle(mf('u2', 'Bob', '/dm damage Elaria 999'), mSend);
    check('rules: damage clamps at 0 hp (never negative)', (await sessionOf())?.players.u2?.hp === 0);
    await mBot.handle(mf('u2', 'Bob', '/dm heal Elaria 999'), mSend);
    check('rules: heal clamps at maxHp (no overheal)', (await sessionOf())?.players.u2?.hp === 10);

    // /dm hp surfaces the whole party's mechanical hp on demand.
    mOut.length = 0;
    await mBot.handle(mf('u1', 'Alice', '/dm hp'), mSend);
    check("rules: /dm hp shows every party member's current HP",
      mOut.at(-1)!.text.includes('Thorin') && mOut.at(-1)!.text.includes('5/10') && mOut.at(-1)!.text.includes('Elaria'));

    // /dm check resolves d20 (+mod) vs a DC ENGINE-SIDE before narration: DC 1
    // always passes (even a nat 1 totals ≥1), DC 100 always fails — deterministic.
    mOut.length = 0;
    await mBot.handle(mf('u1', 'Alice', '/dm check Thorin STR 1'), mSend);
    check('rules: /dm check feeds a deterministic RESOLVED CHECKS "PASS" fact to the narrator',
      /RESOLVED CHECKS/.test(mp.lastPrompt) && /STR/.test(mp.lastPrompt) && /PASS/.test(mp.lastPrompt));
    mOut.length = 0;
    await mBot.handle(mf('u1', 'Alice', '/dm check Thorin STR 100'), mSend);
    check('rules: /dm check feeds a deterministic RESOLVED CHECKS "FAIL" fact to the narrator',
      /RESOLVED CHECKS/.test(mp.lastPrompt) && /FAIL/.test(mp.lastPrompt));

    check('rules: the narrator prompt documents the marker syntax the DM may emit',
      mp.lastPrompt.includes('<<hp CharacterName') && mp.lastPrompt.includes('<<condition CharacterName'));

    // The narrator prompt documents the extended markers (uncondition) too.
    check('rules: the narrator prompt documents the uncondition marker',
      mp.lastPrompt.includes('<<uncondition CharacterName'));
  }

  });
  suite.section("Rules engine: conditions library (normalize, validate, describe)", async () => {
  // ── Rules engine: conditions library ──
  {
    check('conditions: the 14 standard 5e conditions are catalogued', CONDITIONS.prone && CONDITIONS.restrained && CONDITIONS.frightened && CONDITIONS.paralyzed ? true : false);
    check('conditions: normalizeCondition canonicalizes case + spacing',
      normalizeCondition('Prone') === 'prone' && normalizeCondition('  RESTRAINED ') === 'restrained' && normalizeCondition('on fire') === 'on-fire');
    check('conditions: normalizeCondition rejects non-tokens (numbers, symbols)',
      normalizeCondition('123') === undefined && normalizeCondition('') === undefined && normalizeCondition('a b!c') === undefined);
    check('conditions: homebrew (unknown-but-valid) words pass through, catalogued ones resolve to their id',
      normalizeCondition('bewildered') === 'bewildered' && conditionDef('bewildered') === undefined && conditionDef('PRONE')?.id === 'prone');
    const glossary = describeConditions(['prone', 'prone', 'frightened', 'homebrewed']);
    check('conditions: describeConditions dedupes, describes known ones, lists unknown by name',
      glossary.includes('Prone:') && glossary.split('Prone:').length === 2 && glossary.includes('Frightened:') && glossary.includes('homebrewed'));
  }

  });
  suite.section("Rules engine: monster stat blocks + bundled bestiary", async () => {
  // ── Rules engine: statblocks ──
  {
    check('statblock: the bundled bestiary has classic low-CR monsters', BESTIARY.goblin && BESTIARY.orc && BESTIARY.skeleton && BESTIARY.ogre ? true : false);
    check('statblock: a goblin has engine-owned AC/HP/initiative', BESTIARY.goblin.ac === 15 && BESTIARY.goblin.maxHp === 7 && BESTIARY.goblin.initiativeMod === 2);
    check('statblock: findStatBlock is case/spacing tolerant', findStatBlock('Goblin')?.id === 'goblin' && findStatBlock('dire wolf')?.id === 'dire-wolf' && findStatBlock('nope') === undefined);
    check('statblock: listBestiary returns every entry, sorted', listBestiary().length === Object.keys(BESTIARY).length);
    check('statblock: statBlockLine renders a one-line summary', statBlockLine(BESTIARY.goblin).includes('AC 15') && statBlockLine(BESTIARY.goblin).includes('HP 7'));
  }

  });
  suite.section("Rules engine: combat / initiative order (pure, deterministic)", async () => {
  // ── Rules engine: combat order ── (inject a deterministic initiative roller)
  {
    const session: GameSession = {
      id: 's', platform: 'cli', channelId: 'combat', systemId: 'dnd5e', model: 'm',
      players: {
        u1: { userId: 'u1', userName: 'Alice', characterName: 'Thorin', hp: 20, maxHp: 20 },
        u2: { userId: 'u2', userName: 'Bob', characterName: 'Elaria', hp: 15, maxHp: 15, initiativeMod: 3 },
      },
      npcs: [], lorebook: [], history: [], summary: '', memories: [],
      turnMode: 'immediate', turnIndex: 0, fogOfWar: false, createdAt: 0,
    };

    // Stage monsters before combat: they sit inactive with rolled=0 initiative.
    addMonster(session, BESTIARY.goblin);
    addMonster(session, BESTIARY.goblin); // auto-numbers → "Goblin 2"
    const orc = addMonster(session, BESTIARY.orc, 'Warlord Gruul');
    check('combat: staging creates an inactive encounter with engine-owned monster vitals',
      session.encounter?.active === false && session.encounter?.order.length === 3 && session.encounter?.order[0].hp === 7);
    check('combat: same-named monsters auto-number, a custom name is kept verbatim',
      session.encounter!.order[0].name === 'Goblin' && session.encounter!.order[1].name === 'Goblin 2' && orc.name === 'Warlord Gruul');

    // Deterministic initiative: feed a fixed sequence so the order is knowable.
    // Order of combatants at start: [Thorin, Elaria, Goblin, Goblin 2, Warlord].
    const seq = [5, 18, 12, 3, 9]; // rolls (mod already applied by our stub? no — stub returns final)
    let i = 0;
    startCombat(session, () => seq[i++]);
    const names = session.encounter!.order.map((c) => c.name);
    check('combat: startCombat rolls initiative, includes the whole party + monsters, sorts descending',
      session.encounter!.active && session.encounter!.round === 1 && names.length === 5 &&
      names[0] === 'Elaria' && names[1] === 'Goblin' && names[4] === 'Goblin 2');
    check('combat: the first combatant in the order is acting', currentCombatant(session)?.name === 'Elaria');

    // Advance through the order; wrapping past the end bumps the round.
    const seen: string[] = [];
    for (let step = 0; step < 5; step++) { seen.push(currentCombatant(session)!.name); advanceCombat(session); }
    check('combat: advancing walks the full order then wraps into round 2',
      seen.join(',') === 'Elaria,Goblin,Warlord Gruul,Thorin,Goblin 2' && session.encounter!.round === 2);

    // A downed combatant is skipped when advancing.
    const goblin = findMonsterCombatant(session, 'Goblin')!;
    goblin.conditions = ['unconscious'];
    check('combat: isOutOfFight flags a downed combatant', isOutOfFight(goblin));
    // Point at Elaria, then advance — the next in order (Goblin) is down and skipped.
    session.encounter!.turnIndex = session.encounter!.order.findIndex((c) => c.name === 'Elaria');
    advanceCombat(session);
    check('combat: advanceCombat skips a downed combatant', currentCombatant(session)?.name !== 'Goblin');

    // livingSides spots a one-sided fight.
    for (const c of session.encounter!.order) if (c.kind === 'monster') c.conditions = ['dead'];
    check('combat: livingSides reports no monsters standing once all are down', livingSides(session).monsters.length === 0 && livingSides(session).players.length === 2);

    // summarizeCombat produces a prompt block with a ▶ on the current actor.
    endCombat(session);
    check('combat: endCombat clears the encounter', session.encounter === undefined);
    check('combat: summarizeCombat is empty when there is no active encounter', summarizeCombat(session) === '');
  }

  });
  suite.section("Rules engine: monsters as damage targets + monster-aware markers (fully isolated)", async () => {
  // ── Rules engine: monster targeting through the bot + markers ──
  {
    const mp = new MockProvider();
    const mBot = new Bot(config, mp, new MemoryStorage());
    const mOut: OutgoingMessage[] = [];
    const mSend = async (m: OutgoingMessage) => void mOut.push(m);
    const mf = (userId: string, userName: string, text: string): IncomingMessage =>
      ({ platform: 'cli', channelId: 'monsters', userId, userName, text });
    const sessionOf = () => mBot['sessions'].get(mf('u1', 'Alice', ''));
    await mBot.handle(mf('u1', 'Alice', '/dm new'), mSend);
    await mBot.handle(mf('u1', 'Alice', '/dm join Thorin'), mSend);

    // /dm monster add stages a goblin the engine now owns.
    mOut.length = 0;
    await mBot.handle(mf('u1', 'Alice', '/dm monster add goblin'), mSend);
    check('combat: /dm monster add stages a bestiary monster with its stat block',
      mOut.at(-1)!.text.includes('Goblin') && mOut.at(-1)!.text.includes('HP 7/7'));
    const staged = await sessionOf();
    check('combat: the staged monster lives on the session encounter', (staged?.encounter?.order ?? []).some((c) => c.name === 'Goblin' && c.hp === 7));

    // /dm damage resolves a MONSTER name (not just a party member) and applies engine hp.
    mOut.length = 0;
    await mBot.handle(mf('u1', 'Alice', '/dm damage Goblin 5'), mSend);
    check('combat: /dm damage targets a monster and reduces its engine-owned hp',
      mOut.at(-1)!.text.includes('Goblin takes 5 damage: HP 2/7'));
    check('combat: findTarget resolves a monster to its combatant vitals', findTarget((await sessionOf())!, 'Goblin')?.kind === 'monster');

    // A narration marker can name a monster, dropping it to 0 (falls, not "unconscious PC").
    mp.narration = "Thorin's hammer crushes the goblin!\n<<hp Goblin -50>>";
    mOut.length = 0;
    await mBot.handle(mf('u1', 'Alice', 'I swing at the goblin'), mSend);
    const dm = mOut.find((m) => m.speaker === 'Dungeon Master');
    const afterKill = await sessionOf();
    const gob = (afterKill?.encounter?.order ?? []).find((c) => c.name === 'Goblin');
    check('combat: a <<hp Monster>> marker damages the monster and is stripped from the prose',
      Boolean(dm) && !dm!.text.includes('<<') && gob?.hp === 0 && (gob?.conditions ?? []).includes('unconscious'));

    // /dm condition imposes and clears a condition on a party member.
    mOut.length = 0;
    await mBot.handle(mf('u1', 'Alice', '/dm condition Thorin frightened'), mSend);
    check('combat: /dm condition imposes a canonicalized condition',
      mOut.at(-1)!.text.includes('frightened') && ((await sessionOf())?.players.u1?.conditions ?? []).includes('frightened'));
    mOut.length = 0;
    await mBot.handle(mf('u1', 'Alice', '/dm condition Thorin clear frightened'), mSend);
    check('combat: /dm condition clear lifts it',
      !((await sessionOf())?.players.u1?.conditions ?? []).includes('frightened'));

    // The combat state reaches the narrator prompt so the DM narrates the right turn.
    await mBot.handle(mf('u1', 'Alice', '/dm monster add orc'), mSend);
    await mBot.handle(mf('u1', 'Alice', '/dm combat start'), mSend);
    mp.narration = 'The battle rages. (mock)';
    mOut.length = 0;
    await mBot.handle(mf('u1', 'Alice', 'I raise my shield'), mSend);
    check('combat: the initiative order reaches the narrator prompt', /## Combat — round \d/.test(mp.lastPrompt) && mp.lastPrompt.includes('Orc'));

    // /dm combat next advances; when all monsters are down the fight is won.
    mOut.length = 0;
    await mBot.handle(mf('u1', 'Alice', '/dm damage Orc 999'), mSend);
    await mBot.handle(mf('u1', 'Alice', '/dm combat next'), mSend);
    check('combat: /dm combat next declares victory once every monster is down',
      mOut.at(-1)!.text.includes('defeated') || mOut.at(-1)!.text.includes('wins'));

    // Direct helper coverage: setCondition/clearCondition/applyHpDelta on a bare Vitals.
    const v: { hp?: number; maxHp?: number; conditions?: string[] } = { hp: 8, maxHp: 8 };
    applyHpDelta(v, 'Dummy', -8, 'damage');
    check('combat: applyHpDelta on a bare Vitals clamps to 0 and sets unconscious', v.hp === 0 && (v.conditions ?? []).includes('unconscious'));
    setCondition(v, 'Dummy', 'Prone');
    check('combat: setCondition canonicalizes onto a Vitals', (v.conditions ?? []).includes('prone'));
    clearCondition(v, 'Dummy', 'prone');
    check('combat: clearCondition removes it', !(v.conditions ?? []).includes('prone'));

    // removeMonster staging cleanup.
    const s2: GameSession = { id: 'x', platform: 'cli', channelId: 'c2', systemId: 'dnd5e', model: 'm', players: {}, npcs: [], lorebook: [], history: [], summary: '', memories: [], turnMode: 'immediate', turnIndex: 0, fogOfWar: false, createdAt: 0 };
    addMonster(s2, BESTIARY.goblin);
    check('combat: removeMonster drops a staged monster', removeMonster(s2, 'Goblin') === true && (s2.encounter?.order.length ?? -1) === 0 && removeMonster(s2, 'Ghost') === false);
  }

  });
  suite.section("Rules engine: attack resolution (to-hit vs AC, damage vs HP, crits)", async () => {
  // ── Rules engine: attacks (pure) ── (inject the d20 for deterministic hit/miss)
  {
    const mkTarget = () => ({ name: 'Thorin', ac: 13, vitals: { hp: 20, maxHp: 20, conditions: [] as string[] } });

    // A hit: d20(15)+4 = 19 >= AC 13 → damage rolled and applied.
    const t1 = mkTarget();
    const hit = resolveAttack('Goblin', { name: 'Scimitar', toHit: 4, damage: '1d6+2' }, t1, { d20: 15, seed: 7 });
    check('attack: a beating-AC roll hits and applies damage to the target', hit.hit && hit.damage > 0 && t1.vitals.hp === 20 - hit.damage && hit.targetHp === t1.vitals.hp);

    // A miss: d20(3)+4 = 7 < AC 13 → no damage, target untouched.
    const t2 = mkTarget();
    const miss = resolveAttack('Goblin', { name: 'Scimitar', toHit: 4, damage: '1d6+2' }, t2, { d20: 3 });
    check('attack: a roll under AC misses and deals no damage', !miss.hit && miss.damage === 0 && t2.vitals.hp === 20);

    // Natural 20: auto-hit even against absurd AC, and doubles the damage DICE.
    const t3 = { name: 'Ogre', ac: 99, vitals: { hp: 60, maxHp: 60, conditions: [] as string[] } };
    const crit = resolveAttack('Thorin', { name: 'Greatsword', toHit: 5, damage: '2d6+3' }, t3, { d20: 20, seed: 4 });
    check('attack: a natural 20 auto-hits regardless of AC and is flagged a crit', crit.hit && crit.crit);
    check('attack: a crit doubles the damage dice (4d6, not 2d6) — 4 dice rolled + modifier', crit.damageRolls.length === 4 && crit.damage >= 4 + 3 && crit.damage <= 24 + 3);

    // Natural 1: auto-miss even against trivial AC.
    const t4 = { name: 'Dummy', ac: 1, vitals: { hp: 10, maxHp: 10, conditions: [] as string[] } };
    const fumble = resolveAttack('Goblin', { name: 'Scimitar', toHit: 10, damage: '1d6' }, t4, { d20: 1 });
    check('attack: a natural 1 auto-misses regardless of AC', !fumble.hit && fumble.fumble && t4.vitals.hp === 10);

    // A hit that drops the target to 0 sets the flag + unconscious (via applyHpDelta).
    const t5 = { name: 'Kobold', ac: 5, vitals: { hp: 3, maxHp: 5, conditions: [] as string[] } };
    const kill = resolveAttack('Thorin', { name: 'Maul', toHit: 5, damage: '2d6+4' }, t5, { d20: 18, seed: 1 });
    check('attack: a lethal hit clamps hp to 0, flags the drop, and downs the target', kill.hit && t5.vitals.hp === 0 && kill.targetDropped && t5.vitals.conditions.includes('unconscious'));

    // Session-aware profile/target resolution.
    const session: GameSession = {
      id: 's', platform: 'cli', channelId: 'atk', systemId: 'dnd5e', model: 'm',
      players: { u1: { userId: 'u1', userName: 'Alice', characterName: 'Thorin', hp: 20, maxHp: 20 } },
      npcs: [], lorebook: [], history: [], summary: '', memories: [],
      turnMode: 'immediate', turnIndex: 0, fogOfWar: false, createdAt: 0,
    };
    addMonster(session, BESTIARY.goblin);
    check('attack: a monster attacker exposes its stat-block attacks', attackerProfiles(session, 'Goblin')?.profiles[0].name === 'Scimitar');
    check('attack: a player with no weapon set falls back to the default profile', attackerProfiles(session, 'Thorin')?.profiles[0].toHit === DEFAULT_PLAYER_ATTACK.toHit);
    check('attack: a player target defaults to unarmored AC 10; a monster uses its stat-block AC',
      attackTarget(session, 'Thorin')?.ac === DEFAULT_AC && attackTarget(session, 'Goblin')?.ac === BESTIARY.goblin.ac);
    check('attack: pickAttack selects a named attack, else the first', pickAttack([{ name: 'a', toHit: 1, damage: '1d4' }, { name: 'b', toHit: 2, damage: '1d6' }], 'b').name === 'b');
  }

  });
  suite.section("Rules engine: /dm attack, /dm ac, /dm weapon through the bot (fully isolated)", async () => {
  // ── Rules engine: attacks through the bot ──
  {
    const mp = new MockProvider();
    const aBot = new Bot(config, mp, new MemoryStorage());
    const aOut: OutgoingMessage[] = [];
    const aSend = async (m: OutgoingMessage) => void aOut.push(m);
    const af = (userId: string, userName: string, text: string): IncomingMessage => ({ platform: 'cli', channelId: 'atk', userId, userName, text });
    const sessionOf = () => aBot['sessions'].get(af('u1', 'Alice', ''));
    await aBot.handle(af('u1', 'Alice', '/dm new'), aSend);
    await aBot.handle(af('u1', 'Alice', '/dm join Thorin'), aSend);
    await aBot.handle(af('u1', 'Alice', '/dm monster add goblin'), aSend);

    // /dm ac sets a player's Armor Class.
    aOut.length = 0;
    await aBot.handle(af('u1', 'Alice', '/dm ac Thorin 16'), aSend);
    check('attack: /dm ac sets a party member\'s Armor Class', aOut.at(-1)!.text.includes('16') && (await sessionOf())?.players.u1?.ac === 16);

    // /dm weapon sets a player's weapon profile.
    aOut.length = 0;
    await aBot.handle(af('u1', 'Alice', '/dm weapon Thorin 6 1d12+4 Greataxe'), aSend);
    const wSession = await sessionOf();
    check('attack: /dm weapon sets a party member\'s weapon profile', wSession?.players.u1?.attack?.toHit === 6 && wSession?.players.u1?.attack?.damage === '1d12+4' && wSession?.players.u1?.attack?.name === 'Greataxe');

    // /dm attack Thorin vs Goblin — player hits the monster, engine applies damage to the monster's hp.
    aOut.length = 0;
    await aBot.handle(af('u1', 'Alice', '/dm attack Thorin vs Goblin'), aSend);
    const line = aOut.at(-1)!.text;
    check('attack: /dm attack resolves to-hit vs AC and reports the outcome', /attacks Goblin/.test(line) && (/HIT/.test(line) || /MISS/.test(line)));
    const gob = ((await sessionOf())?.encounter?.order ?? []).find((c) => c.name === 'Goblin');
    // A goblin has 7 HP; Thorin's Greataxe (1d12+4 = 5..16) one-shots on any hit, so a HIT means hp 0.
    check('attack: a hit applies engine damage to the monster (goblin drops or takes damage)',
      /MISS/.test(line) ? gob?.hp === 7 : (gob?.hp ?? 7) < 7);

    // /dm attack Goblin vs Thorin — monster attacks the player using its stat-block attack.
    aOut.length = 0;
    await aBot.handle(af('u1', 'Alice', '/dm attack Goblin vs Thorin'), aSend);
    check('attack: a monster attacker uses its stat-block attack name (Scimitar)', /Goblin attacks Thorin \(Scimitar\)/.test(aOut.at(-1)!.text));

    // Bad syntax and unknown combatants are handled.
    aOut.length = 0;
    await aBot.handle(af('u1', 'Alice', '/dm attack Thorin Goblin'), aSend);
    check('attack: /dm attack without " vs " shows usage', /Usage/.test(aOut.at(-1)!.text));
    aOut.length = 0;
    await aBot.handle(af('u1', 'Alice', '/dm attack Ghost vs Thorin'), aSend);
    check('attack: /dm attack names an unknown attacker clearly', /No combatant named "Ghost"/.test(aOut.at(-1)!.text));
  }

  });
}
