/**
 * Smoke-test cases — the actual assertions, moved out of the monolithic
 * smoke.ts. Sections register into the shared {@link Suite}; the runners in
 * smoke.ts (legacy counted) and smoke/node-test.ts (node:test) execute them.
 * Section bodies are unchanged from the monolith — they call the harness
 * `check`/`skip` and share the setup fixtures declared at the top of
 * {@link registerAll}, in registration order (some later sections reuse a
 * fixture an earlier one created — hence one function, run in order).
 */
import { promises as fs } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import type { Config } from '../config.js';
import type { CompletionRequest, GameSession, IncomingMessage, LLMProvider, ModelInfo, OutgoingMessage, TurnRecord } from '../core/types.js';
import { Bot, redactSecrets, SERVER_TURN_FAILURE_TEXT } from '../core/bot.js';
import { roll, extractRolls } from '../core/engine/dice.js';
import { MAX_CHARACTER_NAME_CHARS, SeatTakenError, SessionManager } from '../core/session/session-manager.js';
import { NodeFileStorage } from '../core/session/store.js';
import { MemoryStorage } from '../core/session/storage.js';
import { loadCard, MAX_CARD_BYTES, renderCard } from '../core/cards/card.js';
import { buildWorldInfo, makeEntry } from '../core/lore/lorebook.js';
import { splitFog } from '../core/narrator/fog.js';
import { cosine, MAX_MEMORIES, MemoryRetriever } from '../core/memory/retrieval.js';
import { AnthropicProvider, convertToAnthropic } from '../providers/anthropic.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { SlackAdapter } from '../adapters/slack.js';
import { MatrixAdapter } from '../adapters/matrix.js';
import { MattermostAdapter } from '../adapters/mattermost.js';
import { CliAdapter } from '../adapters/cli.js';
import { DiscordAdapter } from '../adapters/discord.js';
import { Events, type Client } from 'discord.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { pickAdapter, parseAdapterArg } from '../index.js';
import { MAX_CARD_SUMMARY_CHARS, MAX_FRAME_BYTES, MAX_NAME_CHARS, MAX_PORTRAIT_BYTES, MAX_TEXT_CHARS, RATE_LIMIT_PER_SEC, UNJOINED_FRAMES_PER_SEC, WebAdapter } from '../adapters/web.js';
import { MAX_BIO_CHARS, PORTRAIT_PRESETS, resolvePresetId } from '../core/portraits.js';
import { BUNDLED_RULES, bundledRulesProvider, clearRuntimeRules, registerRulesModule } from '../core/rules/registry.js';
import { CONDITIONS, conditionDef, describeConditions, normalizeCondition } from '../core/rules/conditions.js';
import { BESTIARY, findStatBlock, listBestiary, statBlockLine } from '../core/rules/statblock.js';
import { addMonster, advanceCombat, currentCombatant, endCombat, findMonsterCombatant, isOutOfFight, livingSides, removeMonster, startCombat, summarizeCombat } from '../core/rules/combat.js';
import { applyHpDelta, clearCondition, findTarget, setCondition } from '../core/rules/mechanics.js';
import { validateContentPack, parseContentPackJson, ContentPackError } from '../core/content-packs/validate.js';
import { isPackLockedForDisplay, loadContentPack, PackLockedError } from '../core/content-packs/loader.js';
import { BUNDLED_CONTENT_PACKS, getBundledContentPack, listBundledContentPacks } from '../core/content-packs/registry.js';
import { FRONTIER_OUTPOST_PACK_JSON } from '../core/content-packs/bundled-sources.js';
import { loadContentPackFile } from '../core/content-packs/node.js';
import { createHostedEntitlements, selectEntitlements, selfHostEntitlements, tenantKey } from '../core/entitlements/entitlements.js';
import { applyGrant, MemoryPurchaseStore } from '../core/billing/purchase-store.js';
import { FilePurchaseStore } from '../core/billing/store-node.js';
import { computeSignature, createCheckoutSession, parseCheckoutCompleted, verifyStripeSignature } from '../core/billing/stripe.js';
import { createBillingHandler, isBillingPath, type BillingHttpRequest } from '../core/billing/handler.js';
import { base64ToBytes, bytesToBase64 } from '../core/cards/card-parse.js';
import { loadCardFromBytes } from '../core/cards/card-browser.js';
import { BrowserSessionStorage, webStorageKeyValue, type AsyncKeyValue, type WebStorageLike } from '../core/session/browser-storage.js';
import { buildProvider } from '../providers/factory.js';
import { RoomEngine, type Frame as RoomFrame, type RoomConnection } from '../core/room/room-engine.js';
import { createLocalEngine } from '../browser/local-engine.js';
import { isCapacitorNative, getCapacitorHttp, makeNativeFetch, selectFetch, type CapacitorHttpLike } from '../browser/native-http.js';
import {
  check,
  staticCheck,
  skip,
  Suite,
  MockProvider,
  WsClient,
  WEB_ROOT,
  headlessCrestCheck,
  headlessBoardCheck,
  headlessClassGalleryCheck,
  headlessCreatorCheck,
  runHeadlessClient,
  headlessLocalTurnCheck,
  headlessServerTurnCheck,
  headlessLocalErrorAndHelpCheck,
  headlessKeyStorageCheck,
  headlessStatusStateCheck,
  headlessRosterOverflowCheck,
  type Frame,
} from './harness.js';
import type { SmokeCtx } from './context.js';
import { registerRules } from './sections/rules.js';
import { registerSpellsInventory } from './sections/spells-inventory.js';
import { registerBilling } from './sections/billing.js';

export function registerAll(suite: Suite): void {
  const dataDir = path.join('data', 'smoke');
  suite.setup(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  suite.teardown(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const config: Config = {
    llm: { provider: '', baseUrl: 'http://mock', apiKey: 'x', model: 'mock/free-model', embeddingsModel: '' },
    discord: { token: '' },
    slack: { botToken: '', appToken: '' },
    matrix: { homeserverUrl: '', accessToken: '' },
    mattermost: { url: '', token: '' },
    web: { host: '127.0.0.1', port: 0, password: '' },
    dataDir,
    monetization: { hosted: false, unlockedPackIds: [], tenantUnlockedPackIds: {} },
    billing: { enabled: false, secretKey: '', webhookSecret: '', prices: {}, successUrl: 'http://x/ok', cancelUrl: 'http://x/no', mode: 'payment', storeFile: `${dataDir}/purchases.json` },
  };
  const provider = new MockProvider();
  const bot = new Bot(config, provider, new NodeFileStorage(dataDir));

  const out: OutgoingMessage[] = [];
  const send = async (m: OutgoingMessage) => void out.push(m);
  const from = (userId: string, userName: string, text: string, channelId = 'chan1'): IncomingMessage => ({
    platform: 'cli',
    channelId,
    userId,
    userName,
    text,
  });

  // Hoisted so a handful of fixtures created in one top-level section
  // (now its own isolated section() closure, see below) remain reachable
  // from a much later section that reuses them — without these, wrapping
  // each section in its own closure would silently shadow-break the reuse.
  let sessionFile: string | undefined;
  let store: NodeFileStorage;
  let pngChunk: (type: string, data: Buffer) => Buffer;
  let embedded: string;
  let pngPath: string;
  let bomb: Buffer;

  // Shared context handed to topical section modules that were lifted out of
  // this file (rules, billing). They read only what they need from it.
  const ctx: SmokeCtx = { dataDir, config, provider, bot, out, send, from, fx: {} };

  suite.section("Dice (pure / deterministic)", async () => {
  // ── Dice (pure / deterministic) ──
  check('dice: d20+5 in range 6..25', (() => { const r = roll('d20+5'); return r.total >= 6 && r.total <= 25; })());
  check('dice: seeded rolls are reproducible', roll('2d6+1', 'x', 99).total === roll('2d6+1', 'x', 99).total);
  check('dice: extractRolls finds notation in prose', extractRolls('I cast 8d6 fireball and swing d20+7').length === 2);

  });
  suite.section("Anthropic message conversion (pure / no network)", async () => {
  // ── Anthropic message conversion (pure / no network) ──
  {
    const conv = convertToAnthropic([
      { role: 'system', content: 'You are the DM.' },
      { role: 'system', content: 'Rules: d20.' },
      { role: 'user', content: 'I open the door.' },
    ]);
    check('anthropic: system messages concatenate into the system param',
      conv.system === 'You are the DM.\n\nRules: d20.' && conv.messages.length === 1 && conv.messages[0].role === 'user');

    const merged = convertToAnthropic([
      { role: 'user', content: 'Alice: I attack.' },
      { role: 'user', content: 'Bob: I hide.' },
      { role: 'assistant', content: 'The goblin reels.' },
      { role: 'assistant', content: 'Bob slips into shadow.' },
      { role: 'user', content: 'We press on.' },
    ]);
    check('anthropic: consecutive same-role turns merge into alternation',
      merged.messages.length === 3 &&
      merged.messages[0].content === 'Alice: I attack.\n\nBob: I hide.' &&
      merged.messages[1].role === 'assistant' && merged.messages[1].content.includes('shadow') &&
      merged.messages[2].role === 'user');

    const leading = convertToAnthropic([
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: 'Welcome, adventurer.' },
      { role: 'user', content: 'Hello.' },
    ]);
    check('anthropic: leading assistant turn gets a placeholder user turn',
      leading.messages.length === 3 && leading.messages[0].role === 'user' &&
      leading.messages[1].role === 'assistant' && leading.messages[1].content === 'Welcome, adventurer.');
    check('anthropic: no-system conversation yields an empty system param', merged.system === '');

    const anthropicModels = await new AnthropicProvider({ apiKey: 'x' }).listModels();
    check('anthropic: static model list, none free',
      anthropicModels.length === 3 &&
      anthropicModels.some((m) => m.id === 'claude-opus-4-8') &&
      anthropicModels.every((m) => !m.free));

    // complete() runs from a BROWSER context in the in-app engine (web build AND
    // the Tauri desktop WebView, where the plain global fetch is used). Anthropic's
    // API blocks browser-origin requests unless the caller opts in with the
    // direct-browser-access header; without it every "Play on this device" Anthropic
    // turn dies at the CORS preflight. Capture the outgoing request to pin the header.
    let captured: { url: string; headers: Record<string, string> } | null = null;
    const captureFetch = (async (url: string, init: RequestInit) => {
      captured = { url: String(url), headers: (init.headers ?? {}) as Record<string, string> };
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'You awaken.' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const ap = new AnthropicProvider({ apiKey: 'sk-secret', fetchImpl: captureFetch });
    const reply = await ap.complete({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'hi' }] });
    check('anthropic: complete() joins the returned text blocks', reply === 'You awaken.');
    check('anthropic: complete() sends the direct-browser-access header (CORS opt-in for web/Tauri WebView)',
      captured!.headers['anthropic-dangerous-direct-browser-access'] === 'true');
    check('anthropic: complete() still sends x-api-key + version and posts to /v1/messages',
      captured!.headers['x-api-key'] === 'sk-secret' &&
      captured!.headers['anthropic-version'] === '2023-06-01' &&
      captured!.url.endsWith('/v1/messages'));
  }

  });
  suite.section("Command routing + multiplayer", async () => {
  // ── Command routing + multiplayer ──
  await bot.handle(from('u1', 'Alice', '/dm new'), send);
  check('new: campaign created reply', out.at(-1)!.text.includes('new campaign'));

  await bot.handle(from('u1', 'Alice', '/dm join Thorin'), send);
  await bot.handle(from('u2', 'Bob', '/dm join Elaria'), send);
  out.length = 0;
  await bot.handle(from('u1', 'Alice', '/dm who'), send);
  check('multiplayer: both characters in party', out.at(-1)!.text.includes('Thorin') && out.at(-1)!.text.includes('Elaria'));

  });
  suite.section("Spectator guard", async () => {
  // ── Spectator guard ──
  out.length = 0;
  await bot.handle(from('u3', 'Carol', 'I sneak in'), send);
  check('spectator: non-player is gated', out.at(-1)!.text.includes('spectating'));

  });
  suite.section("Full turn: resolve dice BEFORE narration", async () => {
  // ── Full turn: resolve dice BEFORE narration ──
  out.length = 0;
  await bot.handle(from('u1', 'Alice', 'I attack the goblin with my d20+5 sword'), send);
  check('turn: DM narration returned', out.at(-1)!.speaker === 'Dungeon Master');
  check('turn: resolved roll was injected into the prompt', /RESOLVED ROLLS/.test(provider.lastPrompt) && /d20\+5/.test(provider.lastPrompt));

  });
  suite.section("Model dropdown", async () => {
  // ── Model dropdown ──
  out.length = 0;
  await bot.handle(from('u1', 'Alice', '/dm models'), send);
  check('models: lists the free mock model', out.at(-1)!.text.includes('mock/free-model'));

  });
  suite.section("Persistence to disk", async () => {
  // ── Persistence to disk ──
  const files = await fs.readdir(dataDir);
  sessionFile = files.find((f) => f.startsWith('session_'));
  check('persistence: session file written to disk', Boolean(sessionFile));
  if (sessionFile) {
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, sessionFile), 'utf8'));
    check('persistence: history has the played turn', saved.history.length === 1);
    check('persistence: roll persisted with the turn', saved.history[0].rolls[0]?.notation === 'd20+5');
  }

  });
  suite.section("Structured dice events: the DM narration carries the deterministic roll", async () => {
  // ── Structured dice events: the DM narration carries the deterministic roll ──
  out.length = 0;
  await bot.handle(from('u1', 'Alice', '/dm roll d20+5'), send);
  const rollMsg = out.find((m) => m.speaker === 'Dungeon Master');
  check('roll: /dm roll attaches structured roll data to the DM narration',
    Array.isArray(rollMsg?.rolls) && rollMsg!.rolls!.length === 1 &&
    rollMsg!.rolls![0].notation === 'd20+5' && rollMsg!.rolls![0].actor === 'Thorin');
  const rl = rollMsg!.rolls![0];
  check('roll: total is self-consistent (dice + modifier) and in d20+5 range',
    rl.total === rl.dice.reduce((s, x) => s + x, 0) + (rl.modifier ?? 0) &&
    rl.dice.length === 1 && rl.dice[0] >= 1 && rl.dice[0] <= 20 && rl.total >= 6 && rl.total <= 25);
  const rollPersisted = await new NodeFileStorage(dataDir).load('cli:chan1');
  check('roll: surfaced total matches the persisted engine roll (no adapter re-roll)',
    rollPersisted?.history.at(-1)?.rolls[0]?.total === rl.total &&
    rollPersisted?.history.at(-1)?.rolls[0]?.notation === 'd20+5');

  out.length = 0;
  await bot.handle(from('u1', 'Alice', 'I swing my d20+3 mace at the goblin'), send);
  const actRollMsg = out.find((m) => m.speaker === 'Dungeon Master');
  check('roll: an in-character action with dice notation also carries a roll',
    Array.isArray(actRollMsg?.rolls) && actRollMsg!.rolls![0].notation === 'd20+3' && actRollMsg!.rolls![0].actor === 'Thorin');

  out.length = 0;
  await bot.handle(from('u1', 'Alice', 'I gaze thoughtfully across the tavern'), send);
  const plainMsg = out.find((m) => m.speaker === 'Dungeon Master');
  check('roll: a plain narration action carries no roll data', Boolean(plainMsg) && plainMsg!.rolls === undefined);

  });
  suite.section("Round-robin turn mode", async () => {
  // ── Round-robin turn mode ──
  out.length = 0;
  await bot.handle(from('u1', 'Alice', '/dm mode round-robin'), send);
  check('mode: switch to round-robin', out.at(-1)!.text.includes('Round-robin'));
  await bot.handle(from('u2', 'Bob', '/dm turn'), send);
  check('turn: first joiner (Thorin) is up', out.at(-1)!.text.includes('Thorin'));

  out.length = 0;
  await bot.handle(from('u2', 'Bob', 'I loose an arrow'), send);
  check('round-robin: out-of-turn player is gated with whose-turn notice',
    out.length === 1 && out[0].speaker !== 'Dungeon Master' && out[0].text.includes('Thorin'));
  await bot.handle(from('u2', 'Bob', '/dm who'), send);
  check('round-robin: commands still work out of turn', out.at(-1)!.text.includes('Elaria'));

  out.length = 0;
  await bot.handle(from('u1', 'Alice', 'I charge with my d20 axe'), send);
  check('round-robin: in-turn action resolves to narration', out.some((m) => m.speaker === 'Dungeon Master'));
  check('round-robin: turn advances to Elaria', out.at(-1)!.text.includes('Elaria'));
  await bot.handle(from('u2', 'Bob', '/dm pass'), send);
  check('pass: advances (wraps) back to Thorin', out.at(-1)!.text.includes('passes') && out.at(-1)!.text.includes('Thorin'));
  await bot.handle(from('u1', 'Alice', '/dm turn'), send);
  check('turn: pointer persisted as Thorin', out.at(-1)!.text.includes('Thorin'));

  });
  suite.section("Round-robin: a double-send racing the in-flight turn must not consume Bob's turn", async () => {
  // ── Round-robin: a double-send racing the in-flight turn must not consume Bob's turn ──
  out.length = 0;
  await Promise.all([
    bot.handle(from('u1', 'Alice', 'I swing my axe'), send),
    bot.handle(from('u1', 'Alice', 'I swing again, twice as hard'), send),
  ]);
  check('round-robin: concurrent double-send resolves exactly one turn',
    out.filter((m) => m.speaker === 'Dungeon Master').length === 1);
  check('round-robin: the queued duplicate is rejected inside the lock',
    out.some((m) => m.text.includes("It's Elaria's turn")));
  out.length = 0;
  await bot.handle(from('u2', 'Bob', '/dm turn'), send);
  check("round-robin: after the double-send it is Elaria's turn, not skipped", out.at(-1)!.text.includes('Elaria'));

  });
  suite.section("Round-robin: the pointer stays normalized, so a join at the wrap point can't steal the turn", async () => {
  // ── Round-robin: the pointer stays normalized, so a join at the wrap point can't steal the turn ──
  {
    const mgr = new SessionManager(new NodeFileStorage(dataDir), 'mock/free-model');
    const wm = (userId: string, userName: string): IncomingMessage => ({ platform: 'cli', channelId: 'wrap', userId, userName, text: '' });
    const s = await mgr.create(wm('a', 'A'));
    await mgr.join(s, wm('a', 'A'));
    await mgr.join(s, wm('b', 'B'));
    await mgr.join(s, wm('c', 'C'));
    for (let i = 0; i < 3; i++) await mgr.advanceTurn(s); // full round — C acts last, wraps to A
    check('round-robin: pointer normalizes to 0 on wrap', s.turnIndex === 0);
    await mgr.join(s, wm('d', 'D'));
    check('round-robin: joining at the wrap point does not steal the announced turn',
      mgr.currentPlayer(s)?.userId === 'a');
  }

  });
  suite.section("Seat re-claim: a fresh userId re-joining as an existing character migrates the seat", async () => {
  // ── Seat re-claim: a fresh userId re-joining as an existing character migrates the seat ──
  // (The web adapter mints a new userId per connection; without this, a
  // reconnect + `/dm join <name>` ghosts the party: round-robin deadlocks on
  // the dead entry and fog whispers target a userId with no socket.)
  {
    const mgr = new SessionManager(new MemoryStorage(), 'mock/free-model');
    // A reconnect presents the SAME per-browser ownership token it first joined
    // with — that's what authorizes reclaiming the seat under a fresh userId.
    const ALICE = 'tok-alice-000000000000000000';
    const BOB = 'tok-bob-1111111111111111111';
    const rm = (userId: string, userName: string, resumeToken?: string): IncomingMessage =>
      ({ platform: 'web', channelId: 'reclaim', userId, userName, text: '', resumeToken });
    const s = await mgr.create(rm('w1', 'Alice', ALICE));
    await mgr.join(s, rm('w1', 'Alice', ALICE), 'Thorin');
    await mgr.join(s, rm('w2', 'Bob', BOB), 'Elaria');
    s.players.w1.hp = 3;
    s.players.w1.portrait = { kind: 'preset', id: 'mage' }; // set a portrait BEFORE the reconnect
    await mgr.join(s, rm('w9', 'Alice', ALICE), 'thorin'); // reconnected: new userId, same token + character (case-insensitive)
    check('reclaim: migrated seat keeps hp and its join-order slot, dead userId is gone',
      !s.players.w1 && s.players.w9?.hp === 3 && Object.keys(s.players).join(',') === 'w9,w2');
    check('reclaim: the portrait survives the seat re-claim (not reverted to the default crest)',
      s.players.w9?.portrait?.kind === 'preset' && (s.players.w9!.portrait as { id: string }).id === 'mage');
    await mgr.join(s, rm('w2', 'Bob', BOB), 'Thorin'); // a member renaming to a taken name is NOT a takeover
    check('reclaim: an existing member renaming keeps their own seat',
      Boolean(s.players.w9) && s.players.w2?.characterName === 'Thorin' && Object.keys(s.players).length === 2);
  }

  });
  suite.section("Seat-hijack prevention: reclaim-by-name REQUIRES the ownership token", async () => {
  // ── Seat-hijack prevention: reclaim-by-name REQUIRES the ownership token ──
  // Previously any room member could seize a character (and intercept its private
  // fog whispers) just by naming it in `/dm join`. A reclaim now needs the same
  // per-client token the seat was created with.
  {
    const mgr = new SessionManager(new MemoryStorage(), 'mock/free-model');
    const im = (userId: string, userName: string, resumeToken?: string): IncomingMessage =>
      ({ platform: 'web', channelId: 'hijack', userId, userName, text: '', resumeToken });
    const OWNER = 'owner-secret-token-abcdef0123';
    const s = await mgr.create(im('a1', 'Alice', OWNER));
    await mgr.join(s, im('a1', 'Alice', OWNER), 'Gandalf');

    // Attacker: a fresh userId with NO token must not take the seat.
    let noTok = false;
    try { await mgr.join(s, im('m1', 'Mallory'), 'Gandalf'); } catch (e) { noTok = e instanceof SeatTakenError; }
    check('hijack: a token-less reclaim of a taken character is refused (SeatTakenError)', noTok);
    check('hijack: the victim keeps their seat after a token-less reclaim attempt',
      Boolean(s.players.a1) && s.players.a1?.characterName === 'Gandalf' && !s.players.m1);

    // Attacker with a WRONG token — still refused.
    let wrongTok = false;
    try { await mgr.join(s, im('m2', 'Mallory', 'not-the-real-token'), 'Gandalf'); } catch (e) { wrongTok = e instanceof SeatTakenError; }
    check('hijack: a wrong-token reclaim is refused and adds no ghost seat', wrongTok && !s.players.m2);

    // The true owner reconnecting WITH the matching token still reclaims.
    await mgr.join(s, im('a2', 'Alice', OWNER), 'Gandalf');
    check('hijack: the true owner (matching token) still reclaims across a reconnect',
      Boolean(s.players.a2) && !s.players.a1 && s.players.a2?.characterName === 'Gandalf' && Object.keys(s.players).length === 1);
  }

  });
  suite.section("Character name is length-capped server-side (client maxlength is advisory)", async () => {
  // ── Character name is length-capped server-side (client maxlength is advisory) ──
  // A raw socket can send `/dm join ` + arbitrary text; an unbounded name would
  // then bloat every roster broadcast and the DM system prompt on each turn.
  {
    const mgr = new SessionManager(new MemoryStorage(), 'mock/free-model');
    const nm = (userId: string, userName: string): IncomingMessage => ({ platform: 'web', channelId: 'namecap', userId, userName, text: '' });
    const s = await mgr.create(nm('n1', 'Alice'));
    const p = await mgr.join(s, nm('n1', 'Alice'), 'N'.repeat(MAX_CHARACTER_NAME_CHARS + 500));
    check('join: an over-long character name is clamped to MAX_CHARACTER_NAME_CHARS server-side',
      p.characterName?.length === MAX_CHARACTER_NAME_CHARS && s.players.n1?.characterName?.length === MAX_CHARACTER_NAME_CHARS);
    // A short name is stored verbatim (the clamp is a ceiling, not a mangle).
    await mgr.join(s, nm('n1', 'Alice'), 'Thorin the Bold');
    check('join: a normal-length character name is stored unchanged', s.players.n1?.characterName === 'Thorin the Bold');
  }
  {
    const rcBot = new Bot(config, provider, new MemoryStorage());
    const rcOut: OutgoingMessage[] = [];
    const rcSend = async (m: OutgoingMessage) => void rcOut.push(m);
    // Per-browser ownership tokens: a reconnect re-presents the same one.
    const A_TOK = 'alice-browser-token-aaaa';
    const B_TOK = 'bob-browser-token-bbbb';
    const rc = (userId: string, userName: string, text: string, resumeToken?: string): IncomingMessage =>
      ({ platform: 'web', channelId: 'rc', userId, userName, text, resumeToken });
    await rcBot.handle(rc('web-a1', 'Alice', '/dm new', A_TOK), rcSend);
    await rcBot.handle(rc('web-a1', 'Alice', '/dm join Thorin', A_TOK), rcSend);
    await rcBot.handle(rc('web-b1', 'Bob', '/dm join Elaria', B_TOK), rcSend);
    await rcBot.handle(rc('web-a1', 'Alice', '/dm mode round-robin', A_TOK), rcSend);
    // Bob's browser reconnects: new userId, SAME token, so he re-claims his seat.
    await rcBot.handle(rc('web-b2', 'Bob', '/dm join Elaria', B_TOK), rcSend);
    rcOut.length = 0;
    await rcBot.handle(rc('web-b2', 'Bob', '/dm who', B_TOK), rcSend);
    check('reclaim: re-joining after a reconnect does not duplicate the character',
      (rcOut.at(-1)!.text.match(/Elaria/g) ?? []).length === 1);
    rcOut.length = 0;
    await rcBot.handle(rc('web-a1', 'Alice', 'I advance', A_TOK), rcSend);
    check('reclaim: after Thorin acts the turn reaches the re-claimed seat', rcOut.at(-1)!.text.includes('Elaria'));
    rcOut.length = 0;
    await rcBot.handle(rc('web-b2', 'Bob', 'I loose an arrow', B_TOK), rcSend);
    check('reclaim: the reconnected userId can act on its turn — no ghost deadlock',
      rcOut.some((m) => m.speaker === 'Dungeon Master'));
    // A stranger (fresh userId, NO token) tries to seize Elaria — must be refused,
    // so it cannot become the target of her private whispers.
    rcOut.length = 0;
    await rcBot.handle(rc('web-evil', 'Mallory', '/dm join Elaria'), rcSend);
    check('hijack (bot): a token-less `/dm join` of a taken character is refused, not migrated',
      rcOut.some((m) => /already claimed/i.test(String(m.text))));
    await rcBot.handle(rc('web-a1', 'Alice', '/dm fog on', A_TOK), rcSend);
    provider.narration = 'Shadows shift. [PRIVATE:Elaria]You spot a tripwire.[/PRIVATE]';
    rcOut.length = 0;
    await rcBot.handle(rc('web-a1', 'Alice', 'I press on', A_TOK), rcSend);
    const whisper = rcOut.find((m) => m.targetUserId);
    check('reclaim: fog whisper targets the live reconnected userId, not the dead one',
      whisper?.targetUserId === 'web-b2');
    check('hijack (bot): the stranger never becomes the whisper target',
      whisper?.targetUserId !== 'web-evil');
    provider.narration = 'The tavern falls silent as you act. (mock narration)';
  }

  });
  suite.section("Character Card import (V2 JSON → player persona)", async () => {
  // ── Character Card import (V2 JSON → player persona) ──
  await bot.handle(from('u1', 'Alice', '/dm mode immediate'), send);
  const v2Path = path.join(dataDir, 'zara.card.json');
  await fs.writeFile(v2Path, JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { name: 'Zara', description: 'A cunning tiefling rogue with silver eyes.', personality: 'Sly, loyal, quick-witted', scenario: 'Fresh off a botched heist', first_mes: 'Well, well.', mes_example: '', system_prompt: '' },
  }), 'utf8');
  out.length = 0;
  await bot.handle(from('u1', 'Alice', `/dm import ${v2Path}`), send);
  check('import: joined player gets the card as persona', out.at(-1)!.text.includes('Zara') && out.at(-1)!.text.includes('persona'));
  await bot.handle(from('u1', 'Alice', 'I wink at the barkeep'), send);
  check('import: persona card fields reach the prompt',
    provider.lastPrompt.includes('Imported characters') && provider.lastPrompt.includes('cunning tiefling rogue') && provider.lastPrompt.includes('Sly, loyal'));
  await bot.handle(from('u1', 'Alice', '/dm join Zara the Second'), send);
  store = new NodeFileStorage(dataDir);
  check('import: re-joining keeps the imported persona', (await store.load('cli:chan1'))?.players.u1?.card?.name === 'Zara');

  });
  suite.section("Character Card import (V3 JSON from a spectator → NPC)", async () => {
  // ── Character Card import (V3 JSON from a spectator → NPC) ──
  const v3Path = path.join(dataDir, 'grim.card.json');
  await fs.writeFile(v3Path, JSON.stringify({
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: { name: 'Grimble', description: 'A grumpy gnome shopkeeper.', personality: 'Irascible but fair', scenario: '', first_mes: '', mes_example: '', system_prompt: '', character_book: { entries: [{ content: 'Grimble secretly funds the thieves guild.' }] } },
  }), 'utf8');
  out.length = 0;
  await bot.handle(from('u3', 'Carol', `/dm import ${v3Path}`), send);
  check('import: non-player card becomes an NPC', out.at(-1)!.text.includes('Grimble') && out.at(-1)!.text.includes('NPC'));
  await bot.handle(from('u1', 'Alice', 'I browse the shop'), send);
  check('import: NPC card + lorebook entry reach the prompt',
    provider.lastPrompt.includes('grumpy gnome shopkeeper') && provider.lastPrompt.includes('thieves guild'));

  });
  suite.section("Character Card import (PNG with embedded tEXt 'chara' chunk)", async () => {
  // ── Character Card import (PNG with embedded tEXt 'chara' chunk) ──
  pngChunk = (type: string, data: Buffer) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, 'latin1');
    data.copy(b, 8);
    return b; // CRC left zeroed — the extractor doesn't verify it
  };
  embedded = Buffer.from(JSON.stringify({ spec_version: '2.0', data: { name: 'Vex', description: 'A PNG-borne spectre.' } })).toString('base64');
  pngPath = path.join(dataDir, 'vex.card.png');
  await fs.writeFile(pngPath, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.alloc(13)),
    pngChunk('tEXt', Buffer.from(`chara\0${embedded}`, 'latin1')),
    pngChunk('IEND', Buffer.alloc(0)),
  ]));
  out.length = 0;
  await bot.handle(from('u4', 'Dave', `/dm import ${pngPath}`), send);
  check('import: PNG-embedded card extracted as NPC', out.at(-1)!.text.includes('Vex'));

  });
  suite.section("Card injection stays bounded", async () => {
  // ── Card injection stays bounded ──
  check('import: very long card fields are clipped in the prompt',
    renderCard({ specVersion: '2.0', name: 'Blob', description: 'x'.repeat(5000) }, 'NPC').length < 1000);

  });
  suite.section("Cards persist in the session JSON", async () => {
  // ── Cards persist in the session JSON ──
  const savedSession = JSON.parse(await fs.readFile(path.join(dataDir, sessionFile!), 'utf8'));
  check('persistence: persona card saved on the player', savedSession.players.u1?.card?.name === 'Zara');
  check('persistence: NPC cards saved on the session', savedSession.npcs?.length === 2 && savedSession.npcs[0].name === 'Grimble');
  check('portrait: PNG card import keeps the embedded image bytes as the card portrait',
    savedSession.npcs?.some((n: { name: string; portrait?: { kind: string; mime: string; data: string } }) =>
      n.name === 'Vex' && n.portrait?.kind === 'image' && n.portrait?.mime === 'image/png' && typeof n.portrait?.data === 'string' && n.portrait.data.length > 0));

  });
  suite.section("Lorebook / world info", async () => {
  // ── Lorebook / world info ──
  out.length = 0;
  await bot.handle(from('u3', 'Carol', '/dm lore list'), send);
  check('lore: card character_book auto-imported into the session lorebook', out.at(-1)!.text.includes('Grimble'));

  await bot.handle(from('u1', 'Alice', '/dm lore add Icemaw | dragonfang, wyrm | A white wyrm named Icemaw nests atop Dragonfang Pass.'), send);
  check('lore: entry added with keywords', out.at(-1)!.text.includes('Icemaw') && out.at(-1)!.text.includes('dragonfang'));

  await bot.handle(from('u1', 'Alice', 'I polish my daggers by the fire'), send);
  check('lore: action without keywords does not inject the entry', !provider.lastPrompt.includes('Icemaw'));
  check('lore: keyword-less (constant) card entry is always injected',
    provider.lastPrompt.includes('WORLD INFO') && provider.lastPrompt.includes('thieves guild'));

  await bot.handle(from('u1', 'Alice', 'I set out for the DRAGONFANG pass at dawn'), send);
  check('lore: keyword in the action injects the entry under WORLD INFO',
    provider.lastPrompt.includes('WORLD INFO') && provider.lastPrompt.includes('white wyrm named Icemaw'));

  await bot.handle(from('u1', 'Alice', 'I make camp for the night'), send);
  check('lore: keyword in recent history still triggers', provider.lastPrompt.includes('white wyrm named Icemaw'));

  out.length = 0;
  await bot.handle(from('u1', 'Alice', '/dm lore remove Icemaw'), send);
  check('lore: remove by name', out.at(-1)!.text.includes('removed'));
  await bot.handle(from('u1', 'Alice', 'I march on toward the Dragonfang'), send);
  check('lore: removed entry no longer injected', !provider.lastPrompt.includes('Icemaw'));

  const bigLore = buildWorldInfo([makeEntry('Big', [], 'y'.repeat(5000))], ['anything']);
  check('lore: injected block is bounded', bigLore.length > 0 && bigLore.length < 600);

  const savedLore = JSON.parse(await fs.readFile(path.join(dataDir, sessionFile!), 'utf8'));
  check('persistence: lorebook saved with the session',
    Array.isArray(savedLore.lorebook) && savedLore.lorebook.some((e: { name: string }) => e.name === 'Grimble'));

  });
  suite.section("Card import hardening: /dm import sources are untrusted channel input", async () => {
  // ── Card import hardening: /dm import sources are untrusted channel input ──
  out.length = 0;
  await bot.handle(from('u3', 'Carol', '/dm import /etc/hostname'), send);
  check('import: local paths outside the data dir are refused',
    out.at(-1)!.text.includes('Could not import') && out.at(-1)!.text.includes('must live under'));

  const notesPath = path.join(dataDir, 'notes.txt');
  await fs.writeFile(notesPath, 'root:x:0:0:secret-token-abc123', 'utf8');
  out.length = 0;
  await bot.handle(from('u3', 'Carol', `/dm import ${notesPath}`), send);
  check('import: parse failure never echoes file contents back to the channel',
    out.at(-1)!.text.includes('Could not import') && !out.at(-1)!.text.includes('root:x') && !out.at(-1)!.text.includes('secret-token'));

  const rejects = async (src: string) => { try { await loadCard(src, dataDir); return false; } catch { return true; } };
  check('import: loopback URL is refused (SSRF guard)', await rejects('http://127.0.0.1:8080/card.json'));
  check('import: cloud-metadata URL is refused (SSRF guard)', await rejects('http://169.254.169.254/latest/meta-data/'));
  check('import: localhost hostname is refused (SSRF guard)', await rejects('http://localhost/card.json'));
  check('import: IPv6 loopback is refused (SSRF guard)', await rejects('http://[::1]/card.json'));
  check('import: non-http scheme is refused', await rejects('ftp://example.com/card.json'));

  const bombPath = path.join(dataDir, 'bomb.card.png');
  bomb = deflateSync(Buffer.alloc(8 * 1024 * 1024)); // a few KB compressed → 8 MB inflated
  await fs.writeFile(bombPath, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.alloc(13)),
    pngChunk('zTXt', Buffer.concat([Buffer.from('chara\0\0', 'latin1'), bomb])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]));
  check('import: zTXt decompression bomb is rejected, not inflated', await rejects(bombPath));

  const bigPath = path.join(dataDir, 'big.card.json');
  await fs.writeFile(bigPath, Buffer.alloc(MAX_CARD_BYTES + 1, 0x7b));
  check('import: oversized card file is refused', await rejects(bigPath));

  });
  suite.section("Portraits: /dm portrait preset catalog + player descriptor", async () => {
  // ── Portraits: /dm portrait preset catalog + player descriptor ──
  {
    const pFrom = (userId: string, userName: string, text: string) => from(userId, userName, text, 'portraits');
    await bot.handle(pFrom('u1', 'Alice', '/dm new'), send);
    await bot.handle(pFrom('u1', 'Alice', '/dm join Thorin'), send);
    out.length = 0;
    await bot.handle(pFrom('u1', 'Alice', '/dm portrait'), send);
    check('portrait: bare command lists the preset ids', PORTRAIT_PRESETS.every((id) => out.at(-1)!.text.includes(id)));
    out.length = 0;
    await bot.handle(pFrom('u1', 'Alice', '/dm portrait not-a-class'), send);
    check('portrait: unknown preset id is rejected', out.at(-1)!.text.includes('Unknown preset'));
    out.length = 0;
    await bot.handle(pFrom('u2', 'Bob', '/dm portrait fighter'), send);
    check('portrait: a spectator (non-player) cannot set a portrait', out.at(-1)!.text.includes('Join first'));
    out.length = 0;
    await bot.handle(pFrom('u1', 'Alice', '/dm portrait fighter'), send);
    check('portrait: preset command confirms it is set', out.at(-1)!.text.toLowerCase().includes('fighter'));
    const pSaved = await new NodeFileStorage(dataDir).load('cli:portraits');
    check('portrait: preset stored on the player as a {kind:preset,id} descriptor',
      pSaved?.players.u1?.portrait?.kind === 'preset' &&
      (pSaved!.players.u1!.portrait as { id: string }).id === 'fighter');
    check('portrait: setting a preset does not disturb other players', pSaved?.players.u2 === undefined);
  }

  });
  suite.section("Class + bio: /dm class defaults the portrait, /dm bio is bounded, both reach the prompt", async () => {
  // ── Class + bio: /dm class defaults the portrait, /dm bio is bounded, both reach the prompt ──
  {
    // A dedicated bot+storage so out-of-band mutations share the bot's cache.
    const cbStorage = new NodeFileStorage(dataDir);
    const cbBot = new Bot(config, provider, cbStorage);
    const cbFrom = (userId: string, userName: string, text: string) => from(userId, userName, text, 'classbio');
    await cbBot.handle(cbFrom('u1', 'Alice', '/dm new'), send);
    await cbBot.handle(cbFrom('u1', 'Alice', '/dm join Mira'), send);
    out.length = 0;
    await cbBot.handle(cbFrom('u1', 'Alice', '/dm class'), send);
    check('class: bare command lists all 12 D&D 5e classes',
      PORTRAIT_PRESETS.length === 12 && PORTRAIT_PRESETS.every((id) => out.at(-1)!.text.includes(id)));
    out.length = 0;
    await cbBot.handle(cbFrom('u1', 'Alice', '/dm class not-a-class'), send);
    check('class: an unknown class name is rejected', out.at(-1)!.text.includes('Unknown class'));
    out.length = 0;
    await cbBot.handle(cbFrom('u2', 'Bob', '/dm class fighter'), send);
    check('class: a spectator (non-player) cannot set a class', out.at(-1)!.text.includes('Join first'));
    out.length = 0;
    await cbBot.handle(cbFrom('u1', 'Alice', '/dm class Wizard'), send); // case-insensitive; name == id
    check('class: setting a class confirms it', out.at(-1)!.text.toLowerCase().includes('wizard'));
    const cbSaved1 = await cbStorage.load('cli:classbio');
    check('class: class is stored on the player and defaults the preset portrait to it',
      cbSaved1?.players.u1?.class === 'wizard' &&
      cbSaved1?.players.u1?.portrait?.kind === 'preset' &&
      (cbSaved1!.players.u1!.portrait as { id: string }).id === 'wizard');

    // A prior uploaded/card image portrait must NOT be clobbered by /dm class.
    // Mutate through the bot's OWN storage so its cache reflects the image.
    cbSaved1!.players.u1!.portrait = { kind: 'image', mime: 'image/png', data: 'AAAA' };
    await cbStorage.save('cli:classbio', cbSaved1!);
    await cbBot.handle(cbFrom('u1', 'Alice', '/dm class rogue'), send);
    const cbSaved2 = await cbStorage.load('cli:classbio');
    check('class: setting a class does not overwrite an uploaded image portrait',
      cbSaved2?.players.u1?.class === 'rogue' && cbSaved2?.players.u1?.portrait?.kind === 'image');

    // Bio is length-bounded server-side.
    const longBio = 'x'.repeat(MAX_BIO_CHARS + 200);
    await cbBot.handle(cbFrom('u1', 'Alice', `/dm bio ${longBio}`), send);
    const cbSaved3 = await cbStorage.load('cli:classbio');
    check('bio: a long bio is clamped to the bound', (cbSaved3?.players.u1?.bio?.length ?? 0) === MAX_BIO_CHARS);

    // A readable bio + the class flavor must both reach the narrator prompt.
    await cbBot.handle(cbFrom('u1', 'Alice', '/dm bio A wandering scholar chasing a lost spellbook.'), send);
    out.length = 0;
    await cbBot.handle(cbFrom('u1', 'Alice', 'I study the ancient runes'), send);
    check('class+bio: the class flavor and the bio both reach the narrator prompt',
      provider.lastPrompt.includes('Player characters') &&
      provider.lastPrompt.includes('Rogue') &&
      provider.lastPrompt.includes('chasing a lost spellbook'));
    check('class+bio: text adapters still get a plain DM narration (new fields are player-only)',
      out.some((m) => m.speaker === 'Dungeon Master'));
  }

  });
  suite.section("Fog of war: per-player private narration (fresh channel)", async () => {
  // ── Fog of war: per-player private narration (fresh channel) ──
  const fogFrom = (userId: string, userName: string, text: string) => from(userId, userName, text, 'chan2');
  await bot.handle(fogFrom('u1', 'Alice', '/dm new'), send);
  await bot.handle(fogFrom('u1', 'Alice', '/dm join Thorin'), send);
  await bot.handle(fogFrom('u2', 'Bob', '/dm join Elaria'), send);
  await bot.handle(fogFrom('u1', 'Alice', 'I scout ahead'), send);
  check('fog: off by default — no fog instructions in the prompt', !provider.lastPrompt.includes('Fog of war'));

  out.length = 0;
  await bot.handle(fogFrom('u1', 'Alice', '/dm fog on'), send);
  check('fog: /dm fog on enables it', out.at(-1)!.text.includes('Fog of war ON'));

  provider.narration =
    'The party enters the crypt. [PRIVATE:Thorin]You alone spot a glint of gold behind the sarcophagus.[/PRIVATE] Dust swirls in the torchlight.';
  out.length = 0;
  await bot.handle(fogFrom('u1', 'Alice', 'I search the crypt'), send);
  check('fog: prompt instructs the model about [PRIVATE:...] sections', provider.lastPrompt.includes('Fog of war is ON') && provider.lastPrompt.includes('[/PRIVATE]'));
  const publicMsg = out.find((m) => m.speaker === 'Dungeon Master' && !m.targetUserId);
  check('fog: public remainder broadcast to the channel',
    Boolean(publicMsg) && publicMsg!.text.includes('enters the crypt') && publicMsg!.text.includes('Dust swirls'));
  check('fog: public text carries no private content or markers',
    !publicMsg!.text.includes('glint of gold') && !publicMsg!.text.includes('[PRIVATE'));
  const whisper = out.find((m) => m.targetUserId);
  check("fog: private section targeted at Thorin's player",
    whisper?.targetUserId === 'u1' && whisper.text.includes('glint of gold') && !whisper.text.includes('[PRIVATE'));

  provider.narration = 'A cold wind blows. [PRIVATE:Gandalf]You sense a Balrog.[/PRIVATE]';
  out.length = 0;
  await bot.handle(fogFrom('u2', 'Bob', 'I listen at the door'), send);
  check('fog: unknown character name in a marker is dropped silently',
    !out.some((m) => m.targetUserId) && !out.some((m) => m.text.includes('Balrog')));

  // Token-cap truncation: the model opens a private section but the completion
  // ends before [/PRIVATE]. The secret must be whispered, never broadcast.
  provider.narration = 'The seal cracks open. [PRIVATE:Elaria]The rune spells your true name';
  out.length = 0;
  await bot.handle(fogFrom('u1', 'Alice', 'I pry at the seal'), send);
  const truncPub = out.find((m) => m.speaker === 'Dungeon Master' && !m.targetUserId);
  const truncWhisper = out.find((m) => m.targetUserId);
  check('fog: truncated (unclosed) private section is whispered, never broadcast',
    Boolean(truncPub) && truncPub!.text.includes('seal cracks') && !truncPub!.text.includes('rune') &&
    truncWhisper?.targetUserId === 'u2' && truncWhisper.text.includes('rune'));

  // splitFog is fail-closed against every malformed-marker shape (pure).
  {
    const trunc = splitFog('The party rests. [PRIVATE:Alice] the innkeeper is the assassin');
    check('fog: unclosed marker keeps the tail private (fail-closed)',
      trunc.publicText === 'The party rests.' && trunc.privates.length === 1 &&
      trunc.privates[0].characterName === 'Alice' && trunc.privates[0].content.includes('assassin'));

    const nested = splitFog('[PRIVATE:A]x[PRIVATE:B]y[/PRIVATE]z[/PRIVATE]w');
    const forA = nested.privates.filter((p) => p.characterName === 'A').map((p) => p.content).join(' ');
    const forB = nested.privates.filter((p) => p.characterName === 'B').map((p) => p.content).join(' ');
    check('fog: nested markers route each section to its own character, nothing leaks',
      forA === 'x z' && forB === 'y' && nested.publicText === 'w');

    const stray = splitFog('All quiet. [/PRIVATE] Nothing stirs.');
    check('fog: stray closer is dropped from the public text',
      !stray.publicText.includes('[/PRIVATE]') && stray.publicText.includes('All quiet.') &&
      stray.publicText.includes('Nothing stirs.') && stray.privates.length === 0);
  }

  // Fog + a roll whose narration is addressed WHOLLY to one character (empty
  // public remainder): the dice outcome is a shared fact, so the structured roll
  // must still ride out on a PUBLIC frame (else no client animates it and the
  // board never pops), while the private prose is whispered.
  provider.narration = '[PRIVATE:Thorin]The rune answers only you.[/PRIVATE]';
  out.length = 0;
  await bot.handle(fogFrom('u1', 'Alice', '/dm roll d20'), send);
  const fogRollPublic = out.find((m) => !m.targetUserId && Array.isArray(m.rolls) && m.rolls.length > 0);
  const fogRollWhisper = out.find((m) => m.targetUserId === 'u1');
  check('fog: an all-private narration still emits the roll on a public frame (board can pop, dice animate)',
    Boolean(fogRollPublic) && fogRollPublic!.rolls![0].notation === 'd20' &&
    !fogRollPublic!.text.includes('rune answers') && Boolean(fogRollWhisper) && fogRollWhisper!.text.includes('rune answers'));

  provider.narration = 'The tavern falls silent as you act. (mock narration)';
  out.length = 0;
  await bot.handle(fogFrom('u1', 'Alice', '/dm fog off'), send);
  check('fog: /dm fog off disables it', out.at(-1)!.text.includes('Fog of war OFF'));
  await bot.handle(fogFrom('u1', 'Alice', 'I sit by the fire'), send);
  check('fog: off again — no fog instructions in the prompt', !provider.lastPrompt.includes('Fog of war'));

  });
  suite.section("Vector memory / RAG: recall of turns outside the recent-history window", async () => {
  // ── Vector memory / RAG: recall of turns outside the recent-history window ──
  const memFrom = (text: string) => from('u1', 'Alice', text, 'chan3');
  await bot.handle(memFrom('/dm new'), send);
  await bot.handle(memFrom('/dm join Thorin'), send);
  const seedTurns = [
    'We ford the icy river at dusk',
    'I pocket the obsidian raven amulet from the altar',
    'We haggle with the caravan master over salt',
    'I climb the crumbling watchtower',
    'We share stew around the campfire',
    'I question the innkeeper about the missing miners',
    'We follow wolf tracks into the pines',
    'I sharpen my blade before we break camp',
  ];
  for (const t of seedTurns) await bot.handle(memFrom(t), send);
  check('memory: no recall while every matching turn is still in recent history',
    !provider.lastPrompt.includes('RELEVANT PAST EVENTS'));

  await bot.handle(memFrom('That obsidian raven amulet I took — I study it for markings'), send);
  const pastBlock = provider.lastPrompt.match(/RELEVANT PAST EVENTS[^]*?(?=\n\nRECENT HISTORY)/)?.[0] ?? '';
  check('memory: echoed turn outside the history window is recalled under RELEVANT PAST EVENTS',
    pastBlock.includes('obsidian raven amulet from the altar'));
  check('memory: unrelated old turn scores zero and is not recalled', !pastBlock.includes('icy river'));
  check('memory: turns already in RECENT HISTORY are not duplicated as past events',
    !pastBlock.includes('sharpen my blade') && !pastBlock.includes('wolf tracks'));

  const memSession = JSON.parse(await fs.readFile(path.join(dataDir, 'session_cli_chan3.json'), 'utf8'));
  check('memory: one record persisted per resolved turn', memSession.memories?.length === 9);
  check('memory: record captures who did what plus a narration snippet',
    memSession.memories?.[1]?.text.includes('Thorin: I pocket the obsidian raven amulet') &&
    memSession.memories?.[1]?.text.includes('tavern falls silent'));

  });
  suite.section("Vector memory: embeddings backend (deterministic fake embed, no network)", async () => {
  // ── Vector memory: embeddings backend (deterministic fake embed, no network) ──
  {
    const embedProvider: LLMProvider = {
      id: 'fake-embed',
      listModels: async () => [],
      complete: async () => '',
      // 2-D "embeddings": axis 0 = combat, axis 1 = commerce.
      embed: async (texts) => texts.map((t) => (t.includes('goblin') || t.includes('fought') ? [1, 0] : [0, 1])),
    };
    const retriever = new MemoryRetriever(embedProvider);
    const fake = {
      history: [],
      memories: [
        { turn: 0, text: 'Thorin: bought rope in the goblin market → done', vector: [0, 1], ts: 1 },
        { turn: 1, text: 'Thorin: fought off an ambush → done', vector: [1, 0], ts: 2 },
      ],
    } as unknown as GameSession;
    const hits = await retriever.retrieve(fake, 'a goblin leaps at me', 1);
    check('memory: embed() backend ranks by cosine similarity, not word overlap',
      hits.length === 1 && hits[0].turn === 1);
    const rec: TurnRecord = { actions: [{ name: 'Thorin', text: 'I stab the goblin' }], rolls: [], narration: 'It shrieks.', ts: 3 };
    await retriever.remember(fake, rec);
    check('memory: remember() stores the embedding vector with the record',
      fake.memories.length === 3 && fake.memories[2].vector?.[0] === 1);
    check('memory: cosine similarity is sane', cosine([1, 0], [1, 0]) === 1 && cosine([1, 0], [0, 1]) === 0);

    // Mixed backends: memories stored BEFORE embeddings were enabled have no
    // vector and score on the (much smaller) Jaccard scale. They must still be
    // retrievable — per-backend ranking, not one mixed sort.
    const mixed = {
      history: [],
      memories: [
        { turn: 0, text: 'Thorin: I pocket the obsidian amulet from the altar → It hums', ts: 1 }, // pre-embeddings
        { turn: 1, text: 'Thorin: we share stew by the goblin fire → cozy', vector: [1, 0], ts: 2 },
        { turn: 2, text: 'Thorin: the goblin scout flees north → uneventful', vector: [1, 0], ts: 3 },
        { turn: 3, text: 'Thorin: we sleep near the goblin cave → quiet night', vector: [1, 0], ts: 4 },
      ],
    } as unknown as GameSession;
    const mixedHits = await retriever.retrieve(mixed, 'the goblin amulet from the altar', 3);
    check('memory: vectorless pre-embeddings record is still retrievable after embeddings are enabled',
      mixedHits.some((h) => h.turn === 0));
  }

  });
  suite.section("Vector memory: bounded growth + compact persistence", async () => {
  // ── Vector memory: bounded growth + compact persistence ──
  {
    const retriever = new MemoryRetriever(provider);
    const fake = { history: [], memories: [] } as unknown as GameSession;
    for (let i = 0; i < MAX_MEMORIES + 25; i++)
      await retriever.remember(fake, { actions: [{ name: 'T', text: `turn ${i}` }], rolls: [], narration: 'ok', ts: i });
    check('memory: stored records are capped', fake.memories.length === MAX_MEMORIES);
    check('memory: turn ids keep counting past pruning', fake.memories.at(-1)!.turn === MAX_MEMORIES + 24);
  }
  {
    const vecStore = new NodeFileStorage(dataDir);
    const vecSession: GameSession = {
      id: 'v1', platform: 'cli', channelId: 'vec', systemId: 'dnd5e', model: 'mock/free-model',
      players: {}, npcs: [], lorebook: [], history: [], summary: '',
      memories: [{ turn: 0, text: 'x', vector: Array.from({ length: 64 }, (_, i) => i / 64), ts: 1 }],
      turnMode: 'immediate', turnIndex: 0, fogOfWar: false, createdAt: 1,
    };
    await vecStore.save('cli:vec', vecSession);
    const rawVec = await fs.readFile(path.join(dataDir, 'session_cli_vec.json'), 'utf8');
    check('persistence: embedding vectors serialize on one line, not one element per line',
      /"vector": \[[^\n]*\]/.test(rawVec) && rawVec.split('\n').length < 40);
    const roundTrip = await new NodeFileStorage(dataDir).load('cli:vec');
    check('persistence: inlined vectors round-trip through load', roundTrip?.memories[0]?.vector?.length === 64);
  }
  check('memory: embeddings are off by default and opt-in via EMBEDDINGS_MODEL',
    new OpenAICompatibleProvider({ baseUrl: 'http://mock', apiKey: 'x' }).embed === undefined &&
    typeof new OpenAICompatibleProvider({ baseUrl: 'http://mock', apiKey: 'x', embeddingsModel: 'text-embedding-3-small' }).embed === 'function');

  });
  suite.section("Slack adapter: module loads offline; missing tokens fail fast", async () => {
  // ── Slack adapter: module loads offline; missing tokens fail fast ──
  check('slack: constructing without tokens throws a clear error', (() => {
    try { new SlackAdapter('', ''); return false; }
    catch (e) { return e instanceof Error && e.message.includes('SLACK_BOT_TOKEN') && e.message.includes('SLACK_APP_TOKEN'); }
  })());
  {
    const slack = new SlackAdapter('xoxb-test', 'xapp-test'); // constructs offline; no connection until start()
    check('slack: adapter exposes the PlatformAdapter surface', slack.name === 'slack' &&
      typeof slack.start === 'function' && typeof slack.stop === 'function' &&
      typeof slack.send === 'function' && typeof slack.onMessage === 'function');
  }

  });
  suite.section("Matrix adapter: module loads offline; missing config fails fast", async () => {
  // ── Matrix adapter: module loads offline; missing config fails fast ──
  check('matrix: constructing without config throws a clear error', (() => {
    try { new MatrixAdapter('', ''); return false; }
    catch (e) { return e instanceof Error && e.message.includes('MATRIX_HOMESERVER_URL') && e.message.includes('MATRIX_ACCESS_TOKEN'); }
  })());
  {
    const matrix = new MatrixAdapter('https://matrix.example.org', 'syt-test', dataDir); // constructs offline; no connection until start()
    check('matrix: adapter exposes the PlatformAdapter surface', matrix.name === 'matrix' &&
      typeof matrix.start === 'function' && typeof matrix.stop === 'function' &&
      typeof matrix.send === 'function' && typeof matrix.onMessage === 'function');
  }

  });
  suite.section("Mattermost adapter: module loads offline; missing config fails fast", async () => {
  // ── Mattermost adapter: module loads offline; missing config fails fast ──
  check('mattermost: constructing without config throws a clear error', (() => {
    try { new MattermostAdapter('', ''); return false; }
    catch (e) { return e instanceof Error && e.message.includes('MATTERMOST_URL') && e.message.includes('MATTERMOST_TOKEN'); }
  })());
  {
    const mm = new MattermostAdapter('https://chat.example.com/', 'mm-test'); // constructs offline; no connection until start()
    check('mattermost: adapter exposes the PlatformAdapter surface', mm.name === 'mattermost' &&
      typeof mm.start === 'function' && typeof mm.stop === 'function' &&
      typeof mm.send === 'function' && typeof mm.onMessage === 'function');
  }

  });
  suite.section("CLI adapter: a scripted turn through injected streams (no real tty)", async () => {
  // ── CLI adapter: a scripted turn through injected streams (no real tty) ──
  {
    const cliDataDir = path.join(dataDir, 'cli-adapter');
    const cliProvider = new MockProvider();
    const cliStorage = new NodeFileStorage(cliDataDir);
    const cliBot = new Bot(config, cliProvider, cliStorage);
    const input = new PassThrough();
    const written: string[] = [];
    const output = new PassThrough();
    output.on('data', (d) => written.push(d.toString('utf8')));
    const cli = new CliAdapter(input, output);
    check('cli: adapter exposes the PlatformAdapter surface', cli.name === 'cli' &&
      typeof cli.start === 'function' && typeof cli.stop === 'function' &&
      typeof cli.send === 'function' && typeof cli.onMessage === 'function');

    cli.onMessage((msg) => cliBot.handle(msg, (out) => cli.send(out)));
    const started = cli.start();
    input.write('/dm new\n');
    input.write('/dm join Rin\n');
    input.write('I inspect the door\n');
    input.end();
    await started; // resolves once the input stream closes AND the queued handlers drain

    const transcript = written.join('');
    check('cli: greets the terminal with the help hint', transcript.includes('OmniDM CLI'));
    check('cli: a scripted /dm join reaches the bot and echoes back', transcript.includes('Rin'));
    check('cli: a scripted action reaches the DM narration', transcript.includes('mock narration'));
    check('cli: the userId/userName/platform routed through are the CLI’s fixed local seat',
      cliProvider.lastPrompt.length > 0);
    await fs.rm(cliDataDir, { recursive: true, force: true });
  }

  });
  suite.section("Discord adapter: message-in → message-out via a fake client (no network)", async () => {
  // ── Discord adapter: message-in → message-out via a fake client (no network) ──
  {
    class FakeDiscordClient extends EventEmitter {
      loginCalls: string[] = [];
      destroyed = false;
      dmFailFor = new Set<string>();
      sentDMs: { userId: string; text: string }[] = [];
      sentChannel: { channelId: string; text: string }[] = [];
      users = {
        fetch: async (id: string) => {
          if (this.dmFailFor.has(id)) throw new Error('Cannot send messages to this user');
          return { send: async (text: string) => { this.sentDMs.push({ userId: id, text }); } };
        },
      };
      channels = {
        fetch: async (id: string) => ({
          isTextBased: () => true,
          send: async (text: string) => { this.sentChannel.push({ channelId: id, text }); },
        }),
      };
      async login(token: string) { this.loginCalls.push(token); return token; }
      async destroy() { this.destroyed = true; }
    }

    const fakeClient = new FakeDiscordClient();
    const discord = new DiscordAdapter('fake-token', fakeClient as unknown as Client);
    check('discord: adapter exposes the PlatformAdapter surface', discord.name === 'discord' &&
      typeof discord.start === 'function' && typeof discord.stop === 'function' &&
      typeof discord.send === 'function' && typeof discord.onMessage === 'function');

    const received: IncomingMessage[] = [];
    discord.onMessage((msg) => { received.push(msg); });
    await discord.start();
    check('discord: start() logs in with the configured token via the injected client', fakeClient.loginCalls[0] === 'fake-token');

    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

    // A bot message must never reach the game.
    fakeClient.emit(Events.MessageCreate, {
      author: { bot: true, id: 'bot1', username: 'OtherBot' },
      member: null, channelId: 'chanA', content: '/dm help',
    });
    await settle();
    check('discord: messages from other bots are ignored', received.length === 0);

    // A real member message translates to the canonical shape.
    fakeClient.emit(Events.MessageCreate, {
      author: { bot: false, id: 'u1', username: 'alice' },
      member: { displayName: 'Alice' }, channelId: 'chanA', content: '/dm join Rin',
    });
    await settle();
    check('discord: a member message-in translates to the canonical IncomingMessage',
      received.length === 1 && received[0].platform === 'discord' && received[0].channelId === 'chanA' &&
      received[0].userId === 'u1' && received[0].userName === 'Alice' && received[0].text === '/dm join Rin');

    // Falls back to the username when no guild member display name is set (e.g. a DM).
    fakeClient.emit(Events.MessageCreate, {
      author: { bot: false, id: 'u2', username: 'bobby' },
      member: undefined, channelId: 'chanA', content: 'hi',
    });
    await settle();
    check('discord: userName falls back to the account username with no member display name', received[1]?.userName === 'bobby');

    // A throwing handler is caught, logged, and never crashes the process — later messages still flow.
    const origError = console.error;
    let loggedThrow = '';
    console.error = (...args: unknown[]) => { loggedThrow += args.join(' '); };
    discord.onMessage(() => { throw new Error('handler boom'); });
    fakeClient.emit(Events.MessageCreate, {
      author: { bot: false, id: 'u3', username: 'carol' },
      member: { displayName: 'Carol' }, channelId: 'chanA', content: 'boom',
    });
    await settle();
    console.error = origError;
    check('discord: a throwing handler is caught + logged, not left to crash the gateway listener',
      loggedThrow.includes('[discord] message handling failed') && loggedThrow.includes('handler boom'));
    discord.onMessage((msg) => { received.push(msg); });

    // message-out: a plain (non-whisper) send reaches the channel.
    await discord.send({ speaker: 'Dungeon Master', channelId: 'chanA', text: 'The door creaks open.' });
    check('discord: a channel-scoped send reaches channels.fetch(...).send(...)',
      fakeClient.sentChannel.at(-1)?.channelId === 'chanA' && fakeClient.sentChannel.at(-1)?.text === 'The door creaks open.');

    // message-out: a fog-of-war whisper DMs the target user, not the channel.
    const beforeChannelCount = fakeClient.sentChannel.length;
    await discord.send({ speaker: 'Dungeon Master', channelId: 'chanA', targetUserId: 'u1', targetUserName: 'Alice', text: 'You spot a hidden lever.' });
    check('discord: a targeted send DMs the user via users.fetch(...).send(...), not the channel',
      fakeClient.sentDMs.at(-1)?.userId === 'u1' && fakeClient.sentDMs.at(-1)?.text === 'You spot a hidden lever.' &&
      fakeClient.sentChannel.length === beforeChannelCount);

    // message-out: closed DMs get a content-free channel notice, never the secret text.
    fakeClient.dmFailFor.add('u2');
    await discord.send({ speaker: 'Dungeon Master', channelId: 'chanA', targetUserId: 'u2', targetUserName: 'Bobby', text: 'The vault code is 4471.' });
    const notice = fakeClient.sentChannel.at(-1);
    check('discord: a closed-DM whisper falls back to a content-free channel notice (never the secret text)',
      notice?.channelId === 'chanA' && notice.text.includes('u2') && !notice.text.includes('4471'));

    await discord.stop();
    check('discord: stop() destroys the underlying client', fakeClient.destroyed === true);
  }

  });
  suite.section("index.ts: adapter selection + argv parsing (pure, no process started)", async () => {
  // ── index.ts: adapter selection + argv parsing (pure, no process started) ──
  {
    check('index: parseAdapterArg defaults to cli with no --adapter flag', parseAdapterArg(['node', 'index.js']) === 'cli');
    check('index: parseAdapterArg reads the flag value', parseAdapterArg(['node', 'index.js', '--adapter', 'discord']) === 'discord');
    check('index: parseAdapterArg falls back to cli when --adapter is the last, valueless argument',
      parseAdapterArg(['node', 'index.js', '--adapter']) === 'cli');

    const pickStorage = new NodeFileStorage(path.join(dataDir, 'pick-adapter'));
    check('index: pickAdapter("cli") returns a CliAdapter', pickAdapter('cli', config, pickStorage) instanceof CliAdapter);
    check('index: an unrecognized adapter name falls back to CliAdapter', pickAdapter('something-unknown', config, pickStorage) instanceof CliAdapter);
    check('index: pickAdapter("discord") returns a DiscordAdapter wired to config.discord.token',
      pickAdapter('discord', config, pickStorage) instanceof DiscordAdapter);
    check('index: pickAdapter("web") returns a WebAdapter sharing the passed-in storage', pickAdapter('web', config, pickStorage) instanceof WebAdapter);
    check('index: pickAdapter("matrix") throws without homeserver/token config (fails fast, not silently)', (() => {
      try { pickAdapter('matrix', config, pickStorage); return false; }
      catch (e) { return e instanceof Error && e.message.includes('MATRIX_HOMESERVER_URL'); }
    })());
  }

  });
  suite.section("Web adapter: real loopback round-trip on an ephemeral port", async () => {
  // ── Web adapter: real loopback round-trip on an ephemeral port ──
  {
    const webStorage = new MemoryStorage();
    const webBot = new Bot(config, provider, webStorage);
    const web = new WebAdapter('127.0.0.1', 0, 'hunter2', undefined, undefined, webStorage); // port 0 = ephemeral; password required; shares the bot's storage
    web.onMessage((m) => webBot.handle(m, (out) => web.send(out)));
    await web.start();
    const port = web.port;
    check('web: server binds an ephemeral port', port > 0);
    const url = `ws://127.0.0.1:${port}/ws`;

    const page = await fetch(`http://127.0.0.1:${port}/`);
    check('web: static client served at /', page.ok && (await page.text()).includes('OmniDM'));
    check('web: missing static file is a 404, not a crash', (await fetch(`http://127.0.0.1:${port}/nope.js`)).status === 404);

    // Node's HTTP parser accepts request-targets the WHATWG URL parser throws
    // on (e.g. "//["); an uncaught throw there would kill the whole process.
    const rawHttp = (payload: string) => new Promise<string>((resolve) => {
      const sock = connect(port, '127.0.0.1', () => sock.write(payload));
      let buf = '';
      sock.on('data', (d) => { buf += d; });
      sock.on('close', () => resolve(buf));
      sock.on('error', () => resolve(buf));
      sock.setTimeout(3000, () => sock.destroy());
    });
    const evil = await rawHttp('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    check('web: malformed request-target answers 400 instead of crashing the server', evil.startsWith('HTTP/1.1 400'));
    check('web: the server still serves after the malformed request-target', (await fetch(`http://127.0.0.1:${port}/`)).ok);

    // The browser UI ships as three plain files; each must arrive with a sane
    // content-type, and the HTML must be self-contained (no external origins —
    // players and the LLM are untrusted, and Capacitor will wrap this offline).
    const [htmlRes, jsRes, cssRes, portraitJsRes] = await Promise.all(
      ['index.html', 'app.js', 'style.css', 'portraits.js'].map((f) => fetch(`http://127.0.0.1:${port}/${f}`)),
    );
    check('web-ui: index.html served as text/html', htmlRes.ok && Boolean(htmlRes.headers.get('content-type')?.startsWith('text/html')));
    check('web-ui: app.js served as text/javascript', jsRes.ok && Boolean(jsRes.headers.get('content-type')?.startsWith('text/javascript')));
    check('web-ui: style.css served as text/css', cssRes.ok && Boolean(cssRes.headers.get('content-type')?.startsWith('text/css')));
    check('web-ui: portraits.js served as text/javascript', portraitJsRes.ok && Boolean(portraitJsRes.headers.get('content-type')?.startsWith('text/javascript')));
    const html = await htmlRes.text();
    staticCheck('web-ui: HTML wires up app.js, portraits.js and style.css',
      html.includes('src="app.js"') && html.includes('src="portraits.js"') && html.includes('href="style.css"'));
    const srcHrefs = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);
    staticCheck('web-ui: every asset reference is same-origin (relative), never an external origin',
      srcHrefs.length >= 4 && srcHrefs.every((v) => !/^(?:https?:)?\/\//i.test(v)));

    // ── Marketing landing page (web/landing.html) ──
    // A separate static page, served by the same generic static handler as
    // everything else in web/. It must actually exist on disk (not just be
    // implied by the server not 404ing) and, like index.html, must load NO
    // external RESOURCE (script/style/image/frame) — only a plain <a href>
    // out to GitHub is allowed, since that's a normal outbound navigation a
    // visitor clicks, not a fetch this untrusted-input-free static page makes
    // on its own; CSP's script/style/img/connect-src stay locked to
    // self/data: with no https: scheme allowance at all (unlike index.html,
    // this page never needs to reach a user-configured LLM endpoint).
    staticCheck('web-ui: web/landing.html exists on disk', await fs.access(path.join(WEB_ROOT, 'landing.html')).then(() => true, () => false));
    const landingRes = await fetch(`http://127.0.0.1:${port}/landing.html`);
    check('web-ui: landing.html served as text/html', landingRes.ok && Boolean(landingRes.headers.get('content-type')?.startsWith('text/html')));
    const landingHtml = await landingRes.text();
    const landingResourceSrcs = [...landingHtml.matchAll(/<(?:script|img|link|iframe|source|embed|object)\b[^>]*\s(?:src|href)\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);
    staticCheck('web-ui: landing.html loads no external resource (script/style/image/frame) — same-origin or data: only',
      landingResourceSrcs.every((v) => v.startsWith('data:') || v.startsWith('#') || !/^[a-z][a-z0-9+.-]*:\/\//i.test(v)));
    staticCheck('web-ui: landing.html sets a strict CSP with no external origin in script/style/img/connect-src',
      /Content-Security-Policy/.test(landingHtml) && !/(script-src|style-src|img-src|connect-src)[^;"]*https?:\/\//i.test(landingHtml));
    staticCheck('web-ui: landing.html links to the real app, the desktop app, and GitHub (no fabricated metrics/testimonials)',
      /href="index\.html"/.test(landingHtml) && /github\.com\/Judgernaut777\/OmniDM/.test(landingHtml) &&
      !/testimonial|★★★★★|\d[,.]?\d*\s*(?:stars|users|downloads|players)\b/i.test(landingHtml));
    // The client is DOM code smoke can't execute, so pin its two reconnect-UX
    // fixes statically: Leave must not depend on a close event (a CLOSED socket
    // fires none), and a trailing close must not wipe a shown join error.
    const appSrc = await jsRes.text();
    staticCheck('web-ui: Leave cancels the retry timer and shows the join screen directly',
      /'leave-btn'\)[^]*?clearTimeout\(state\.retryTimer\)[^]*?showJoin\(''\)/.test(appSrc));
    staticCheck('web-ui: a close event after a refused hello cannot wipe the join-screen error',
      /if \(\$\('join-screen'\)\.hidden\) showJoin\(''\)/.test(appSrc));
    // The portrait helper must be procedural + XSS-safe: crests are built with
    // createElementNS (never innerHTML) and cover all eight preset archetypes.
    const portraitSrc = await portraitJsRes.text();
    staticCheck('web-ui: portraits.js exposes portraitSVG and the full preset catalog',
      /function portraitSVG\(/.test(portraitSrc) &&
      PORTRAIT_PRESETS.every((id) => portraitSrc.includes(`${id}:`)));
    staticCheck('web-ui: crests are built with createElementNS, with no innerHTML assignment',
      portraitSrc.includes('createElementNS') && !/\.innerHTML\s*=/.test(portraitSrc));
    staticCheck('web-ui: the roster token and card sheet render portraits, not a bare hue dot',
      appSrc.includes('makePortrait') && appSrc.includes("el('span', 'seat-portrait')") &&
      /function openCard\(/.test(appSrc) && appSrc.includes('/portrait/'));
    // Cross-origin portrait parity: roster/board descriptors carry a server-RELATIVE
    // /portrait/… path, so BOTH the roster <img> and the board <image> must resolve it
    // through the transport's httpBase() — else, when the client is hosted apart from
    // the server, every portrait 404s against the page origin and falls back to a crest.
    staticCheck('web-ui: portraits resolve their URL through the transport httpBase (cross-origin display parity)',
      /function portraitUrl\(/.test(appSrc) && /httpBase\(\)/.test(appSrc) &&
      /img\.src = portraitUrl\(/.test(appSrc) &&
      /setAttribute\('href', portraitUrl\(/.test(appSrc));
    staticCheck('web-ui: index.html includes the character-card sheet with a crest gallery + upload',
      html.includes('id="card-sheet"') && html.includes('id="card-gallery"') && html.includes('id="card-file"'));

    // Character-setup flow: a prominent, discoverable creator with a persistent
    // topbar entry, name/class/bio/import controls, and a live portrait preview.
    staticCheck('web-ui: index.html has a persistent "Your character" button and the creator panel',
      html.includes('id="creator-btn"') && html.includes('id="creator"') &&
      html.includes('id="creator-name"') && html.includes('id="creator-bio"') &&
      html.includes('id="creator-portrait"') && html.includes('id="creator-import"'));
    staticCheck('web-ui: the creator opens from the button/own seat, auto-prompts first-timers, and wires class/name/bio/import',
      appSrc.includes('function openCreator(') && appSrc.includes('maybePromptCreator') &&
      /openCard[\s\S]*openCreator\(\)/.test(appSrc) &&
      appSrc.includes('/dm join ') && appSrc.includes('/dm class ') &&
      appSrc.includes('/dm bio ') && appSrc.includes('/dm import '));
    staticCheck('web-ui: the creator class gallery previews all 12 classes with the procedural bust',
      appSrc.includes('buildCreatorGallery') && appSrc.includes('CLASS_INFO') &&
      PORTRAIT_PRESETS.every((id) => appSrc.includes(`'${id}'`)) && appSrc.includes('portraitSVG(seed'));

    // The token board draws each scene token as a PORTRAIT (reusing the roster's
    // descriptor + portraitSVG), with a name label and distinct pc/npc + actor
    // styling; drags are throttled and send a final position on drop.
    const styleSrc = await cssRes.text();
    staticCheck('web-ui: the board draws portrait tokens (crest/image) with a name label, not bare hue dots',
      appSrc.includes('renderBoard') && appSrc.includes('tokenPortrait') && appSrc.includes('portraitForToken') &&
      appSrc.includes('crestNode') && appSrc.includes('token-label'));
    staticCheck('web-ui: board CSS distinguishes pc/npc tokens, glows the actor, and fades the dice pop',
      /\.token\.pc/.test(styleSrc) && /\.token\.npc/.test(styleSrc) &&
      /\.token\.actor/.test(styleSrc) && /@keyframes tokenglow/.test(styleSrc) && /\.board-pop/.test(styleSrc));
    staticCheck('web-ui: index.html carries the token board with a Map toggle',
      html.includes('id="board-svg"') && html.includes('id="board-toggle"'));
    staticCheck('web-ui: token drags are throttled and send a final move on drop',
      appSrc.includes('lastMoveSent') && appSrc.includes("type: 'move'") && /pointerup/.test(appSrc));
    // Client fixes smoke can't execute, pinned statically: the portrait upload
    // authorizes with the per-seat token (never the room password), and the board
    // dice-pop dedupes on the monotonic rollSeq with a first-frame baseline (so
    // repeat rolls still pop and a late joiner never pops a roll that predates it).
    staticCheck('web-ui: portrait upload authorizes with the per-seat upload token (not the password)',
      appSrc.includes("'x-upload-token'") && appSrc.includes('state.uploadToken') && !/password=\$\{/.test(appSrc));
    staticCheck('web-ui: the board dice-pop dedupes on rollSeq with a first-frame baseline',
      appSrc.includes('rollSeq') && appSrc.includes('lastRollSeen') && !appSrc.includes('lastRollSig'));
    // Creator Save honesty: a name/bio Save must NOT flip the status to "Saved"
    // optimistically (a `/dm join`/`/dm bio` before `/dm new` is rejected). It
    // shows "Saving…" and only reconcileCreatorStatus() promotes it once the
    // enriched roster actually reflects the change.
    staticCheck('web-ui: creator name/bio Saves confirm from the server roster, never optimistically (no false "Saved")',
      appSrc.includes('reconcileCreatorStatus') && appSrc.includes('state.creator.pendingName') &&
      appSrc.includes('state.creator.pendingBio') && appSrc.includes("textContent = 'Saving…'") &&
      !/\/dm join \$\{name\}`\);\s*\$\('creator-name-status'\)\.textContent = `Saved/.test(appSrc));
    // Class highlight/label must track the optimistic pick (like the live preview),
    // not lag a class change behind a roster round-trip on the stale server value.
    staticCheck('web-ui: currentClassId prefers the optimistic pendingClass, matching creatorPreviewSeat',
      /function currentClassId\(\)[^]*?state\.creator\.pendingClass \|\| \(u &&/.test(appSrc));

    // Optional, offline: render a crest in headless chromium to prove the
    // procedural SVG actually builds (createElementNS path) and is deterministic,
    // then render a full scene onto the real board. Both are best-effort —
    // skipped (never failed) when chromium is unavailable.
    await headlessCrestCheck(portraitSrc);
    await headlessBoardCheck(html, portraitSrc, appSrc);
    await headlessClassGalleryCheck(portraitSrc);
    await headlessCreatorCheck(html, portraitSrc, appSrc);

    // ── Client transport (hybrid model): in-app engine vs. server ──
    // The client talks to a Transport, not a raw WebSocket, so the SAME UI runs
    // the engine in-app OR connects to a server. Verify both files ship, are
    // wired into the page, and encode the two transports + the launch/settings UI.
    const [transportRes, bundleRes] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/transport.js`),
      fetch(`http://127.0.0.1:${port}/engine.bundle.js`),
    ]);
    check('web-ui: transport.js served as text/javascript',
      transportRes.ok && Boolean(transportRes.headers.get('content-type')?.startsWith('text/javascript')));
    check('web-ui: engine.bundle.js (in-app engine) served as text/javascript',
      bundleRes.ok && Boolean(bundleRes.headers.get('content-type')?.startsWith('text/javascript')));
    const transportSrc = await transportRes.text();
    const engineSrc = await bundleRes.text();
    staticCheck('web-ui: HTML loads the in-app engine bundle and the transport layer (same-origin scripts)',
      html.includes('src="engine.bundle.js"') && html.includes('src="transport.js"'));
    staticCheck('web-ui: transport.js defines both Remote and Local transports and exposes them',
      /class RemoteTransport/.test(transportSrc) && /class LocalTransport/.test(transportSrc) &&
      transportSrc.includes('OmniDMTransport'));
    staticCheck('web-ui: RemoteTransport keeps the unchanged WebSocket protocol (hello/say/move over ws), Local drives the in-page engine',
      /new WebSocket\(/.test(transportSrc) && transportSrc.includes('createLocalEngine') && transportSrc.includes('handleFrame'));
    staticCheck('web-ui: the engine bundle exposes OmniDMEngine.createLocalEngine and pulls in NO live node: builtin',
      engineSrc.includes('OmniDMEngine') && engineSrc.includes('createLocalEngine') &&
      !/\brequire\(["']node:/.test(engineSrc) && !/from\s*["']node:/.test(engineSrc) && !/import\(["']node:/.test(engineSrc));
    staticCheck('web-ui: app.js selects a transport (never a bare WebSocket) and sends hello through it',
      appSrc.includes('OmniDMTransport') && appSrc.includes('LocalTransport') && appSrc.includes('RemoteTransport') &&
      !/new WebSocket\(/.test(appSrc) && appSrc.includes("type: 'hello'"));

    // Launch/settings UI: choose in-app vs server, name/room, the BYO-model
    // fields (local) and server URL/password (server), with a Settings re-entry.
    staticCheck('web-ui: index.html has the launch mode picker (this device vs a server) and a Settings button',
      html.includes('id="mode-local"') && html.includes('id="mode-server"') && html.includes('id="settings-btn"'));
    staticCheck('web-ui: index.html has the in-app BYO-model fields and the server fields',
      html.includes('id="llm-provider"') && html.includes('id="llm-baseurl"') && html.includes('id="llm-apikey"') &&
      html.includes('id="llm-model"') && html.includes('id="j-server"') && html.includes('id="j-pass"'));
    staticCheck('web-ui: app.js persists the mode/settings choice and can change it later (settings button reopens launch)',
      appSrc.includes('omnidm-settings') && appSrc.includes('persistSettings') && appSrc.includes('applyLaunchMode') &&
      /'settings-btn'\)/.test(appSrc));
    check('web-ui: the in-app mode advertises single-device (solo/hotseat), server mode advertises multiplayer',
      /multiplayer/i.test(html) && /(this device|hotseat|solo)/i.test(html));

    // KEY SECRECY: the user's LLM API key must never be logged/rendered. It may
    // only be read from the settings field / storage and handed to the provider.
    const apiKeyLogged = /console\.[a-z]+\([^)]*(apiKey|llm-apikey|__omnidm)/i;
    staticCheck('web-ui: the LLM API key is never logged or rendered (secret stays on-device → provider only)',
      !apiKeyLogged.test(appSrc) && !apiKeyLogged.test(transportSrc) &&
      !/textContent\s*=\s*[^;]*apiKey/i.test(appSrc) && !/textContent\s*=\s*[^;]*apiKey/i.test(transportSrc));
    // The in-app engine must NOT serialize the key into a session (BrowserSessionStorage
    // stores the GameSession, which has no key field) — pin the source note + shape.
    staticCheck('local-engine: the in-app Config carries no secret (apiKey lives only inside the provider)',
      engineSrc.includes('createLocalEngine'));

    // ── First-run onboarding polish ──
    // The launch card must spell out the free-model path as plain TEXT (never a
    // fetched external origin: no <a href>/<script src>/<link href> to it — the
    // asset-origin check above already proves every src/href is same-origin).
    staticCheck('web-ui: the launch card shows free-model guidance (local/Ollama + a free OpenRouter key) as plain text',
      html.includes('localhost:11434/v1') && /openrouter\.ai\/keys/.test(html) &&
      !/<a\s[^>]*href="https?:\/\/[^"]*openrouter/i.test(html));
    check('web-ui: the API key field explains the local-model (no key) case inline',
      /leave blank for a local model/i.test(html));
    // Help/About: reachable from the join screen AND the topbar, explains what
    // OmniDM is, reuses the command palette (no duplicated /dm reference), and
    // states where state + the key live.
    staticCheck('web-ui: index.html has a Help/About affordance (join screen + topbar) and modal',
      html.includes('id="help-btn-join"') && html.includes('id="help-btn"') &&
      html.includes('id="help-sheet"') && html.includes('id="help-open-palette"'));
    staticCheck('web-ui: the Help modal explains device-only storage and key secrecy, textContent-safe (static HTML, no innerHTML)',
      /stored only in this browser/i.test(html) && /scrubbed of\s+key-shaped/i.test(html) && !/innerHTML/.test(appSrc.match(/openHelp[\s\S]{0,300}/)?.[0] ?? ''));
    staticCheck('web-ui: app.js wires the Help modal open/close (join screen, topbar, Escape, backdrop click) and hands off to the palette',
      appSrc.includes('function openHelp()') && appSrc.includes('function closeHelp()') &&
      appSrc.includes("'help-btn-join'") && appSrc.includes("'help-btn'") &&
      /Escape'\)[\s\S]{0,120}closeHelp\(\)/.test(appSrc) &&
      appSrc.includes("'help-open-palette'"));
    // Graceful errors: a proactive check for the single most common dead end
    // (default/typed endpoint isn't local, no key entered) plus a rewrite of the
    // engine's generic turn-failure notice into an actionable, non-stack message.
    staticCheck('web-ui: app.js proactively warns (once, on first join) when a non-local endpoint has no API key',
      appSrc.includes('function isLocalEndpoint(') && appSrc.includes('function warnIfNoKeyForRemoteEndpoint(') &&
      appSrc.includes('warnIfNoKeyForRemoteEndpoint()'));
    staticCheck('web-ui: app.js turns a failed turn into a friendly, Settings-pointing message — never the raw text verbatim',
      appSrc.includes('function friendlyEngineError(') && appSrc.includes('⚙ Settings') &&
      appSrc.includes("addLine('warn', '', friendly)"));
    // API key at rest: sessionStorage by default, localStorage only opt-in.
    staticCheck('web-ui: app.js keeps the API key OUT of the durable localStorage record unless "remember" is ticked (sessionStorage by default)',
      appSrc.includes("sessionStorage.setItem(SESSION_KEY_STORAGE") &&
      /apiKey:\s*remember\s*\?\s*apiKey\s*:\s*''/.test(appSrc) &&
      appSrc.includes("localStorage.setItem(SETTINGS_KEY"));
    staticCheck('web-ui: the launch form has an unticked-by-default "remember this key" opt-in',
      html.includes('id="llm-remember-key"') && !html.includes('id="llm-remember-key" checked'));
    // connect-src narrowing: app.js locks this tab's CSP to the actual configured
    // provider origin at connect-time (see web/index.html's CSP comment for why
    // this can't be baked in statically), never widening a lock it already set.
    staticCheck('web-ui: app.js narrows connect-src to the configured provider origin via a second, stricter <meta> CSP at connect-time',
      appSrc.includes('function computeProviderOrigin(') && appSrc.includes('function applyProviderCsp(') &&
      appSrc.includes("meta.setAttribute('http-equiv', 'Content-Security-Policy')") &&
      appSrc.includes("=== 'reload-required'"));

    const clientSrcs = { engine: engineSrc, transport: transportSrc, portraits: portraitSrc, app: appSrc };
    await headlessLocalTurnCheck(html, clientSrcs);
    await headlessServerTurnCheck(html, clientSrcs, url, 'hunter2');
    await headlessLocalErrorAndHelpCheck(html, clientSrcs);
    await headlessKeyStorageCheck(html, clientSrcs);
    await headlessStatusStateCheck(html, clientSrcs);
    await headlessRosterOverflowCheck(html, styleSrc, clientSrcs);

    const bad = new WsClient(url);
    await bad.open();
    bad.send({ type: 'hello', userName: 'Mallory', channelId: 'room1', password: 'wrong' });
    const badErr = await bad.next((f) => f.type === 'error');
    check('web: wrong password is rejected with an error frame', Boolean(badErr?.error && String(badErr.error).includes('password')));
    await bad.closed(); // the server hangs up on a failed password — closed() resolving proves it

    const a = new WsClient(url);
    await a.open();
    a.send({ type: 'hello', userName: 'Alice', channelId: 'room1', password: 'hunter2' });
    const welcome = await a.next((f) => f.type === 'welcome');
    check('web: hello is answered with a welcome carrying an assigned userId',
      typeof welcome?.userId === 'string' && (welcome.userId as string).startsWith('web-'));
    const aliceId = welcome!.userId as string;
    const aliceToken = welcome!.uploadToken as string;
    check('web: welcome carries a per-seat upload token (binds HTTP portrait uploads to this seat)',
      typeof aliceToken === 'string' && aliceToken.length >= 12);
    await a.next((f) => f.type === 'roster'); // consume the initial 1-user roster

    const b = new WsClient(url);
    await b.open();
    b.send({ type: 'hello', userName: 'Bob', channelId: 'room1', password: 'hunter2' });
    const bWelcome = await b.next((f) => f.type === 'welcome');
    const bobId = bWelcome!.userId as string;
    const roster = await a.next((f) => f.type === 'roster');
    check('web: a join broadcasts the updated roster to existing members',
      Array.isArray(roster?.users) && (roster!.users as { userName: string }[]).map((u) => u.userName).join(',') === 'Alice,Bob');

    a.send({ type: 'say', text: '/dm new' });
    const newA = await a.next((f) => f.type === 'msg' && String(f.text).includes('new campaign'));
    const newB = await b.next((f) => f.type === 'msg' && String(f.text).includes('new campaign'));
    check('web: bot reply broadcasts to every client in the room', Boolean(newA) && Boolean(newB));
    check('web: player lines are relayed to the room', b.sawText('/dm new'));

    a.send({ type: 'say', text: '/dm join Thorin' });
    await a.next((f) => f.type === 'msg' && String(f.text).includes('Thorin joins'));
    b.send({ type: 'say', text: '/dm join Elaria' });
    await b.next((f) => f.type === 'msg' && String(f.text).includes('Elaria joins'));
    a.send({ type: 'say', text: '/dm fog on' });
    await a.next((f) => f.type === 'msg' && String(f.text).includes('Fog of war ON'));

    provider.narration = 'Torchlight flickers over the walls. [PRIVATE:Elaria]A hidden lever glints beside you.[/PRIVATE]';
    await new Promise((r) => setTimeout(r, 1100)); // let the rate-limit window drain before the turn
    a.send({ type: 'say', text: 'I scan the walls' });
    const pubA = await a.next((f) => f.type === 'msg' && String(f.text).includes('Torchlight'));
    const pubB = await b.next((f) => f.type === 'msg' && String(f.text).includes('Torchlight'));
    check('web: public narration reaches both clients, unflagged', Boolean(pubA) && Boolean(pubB) && !pubA!.private && !pubB!.private);
    const whisper = await b.next((f) => f.type === 'msg' && f.private === true);
    check('web: fog whisper reaches its target flagged private', Boolean(whisper?.text && String(whisper.text).includes('hidden lever')));
    a.send({ type: 'say', text: '/dm who' });
    await a.next((f) => f.type === 'msg' && String(f.text).includes('party')); // per-socket FIFO: a misdelivered whisper would already be buffered
    check("web: the whisper never reached the other client's socket", !a.sawText('hidden lever'));
    provider.narration = 'The tavern falls silent as you act. (mock narration)';

    // ── Structured dice over the web protocol: a 'roll' frame alongside 'msg' ──
    await new Promise((r) => setTimeout(r, 1100)); // drain the rate-limit window
    a.send({ type: 'say', text: '/dm roll d20+5' });
    const rollFrame = await a.next((f) => f.type === 'roll');
    const rfDice = rollFrame?.dice as number[] | undefined;
    check('web: /dm roll emits a roll frame with the right notation and actor',
      rollFrame?.notation === 'd20+5' && rollFrame?.actor === 'Thorin');
    check('web: roll frame total is self-consistent (dice + modifier)',
      Array.isArray(rfDice) && rfDice.length === 1 && rfDice[0] >= 1 && rfDice[0] <= 20 &&
      (rollFrame!.total as number) === rfDice[0] + ((rollFrame!.modifier as number) ?? 0));
    const wsRoom = await webStorage.load('web:room1');
    check('web: roll frame total matches the deterministic engine roll (no re-roll)',
      wsRoom?.history.at(-1)?.rolls[0]?.total === rollFrame!.total &&
      wsRoom?.history.at(-1)?.rolls[0]?.notation === 'd20+5');
    check('web: the roll also produced a normal msg narration frame (transcript intact)',
      Boolean(await a.next((f) => f.type === 'msg' && f.speaker === 'Dungeon Master' && String(f.text).includes('tavern'))));
    const rollFrameB = await b.next((f) => f.type === 'roll');
    check('web: the roll frame broadcasts to the whole room, unflagged',
      rollFrameB?.notation === 'd20+5' && !rollFrameB?.private);

    // The board dice-pop is driven by scene.lastRoll + a monotonic rollSeq: the
    // roll stashes onto the scene and bumps the sequence so every client pops it
    // exactly once (and a late joiner can tell a stale roll from a fresh one).
    const rollScene1 = await a.next((f) => f.type === 'scene' && Boolean(f.lastRoll) && Number.isFinite(f.rollSeq));
    const seq1 = rollScene1!.rollSeq as number;
    check('web: a roll stashes onto the scene with a numeric rollSeq for the board pop',
      (rollScene1!.lastRoll as { notation?: string })?.notation === 'd20+5' && seq1 >= 1);
    // A SECOND identical roll (same actor/notation) must still advance rollSeq,
    // so an unchanged-fingerprint client no longer swallows the repeat pop.
    await new Promise((r) => setTimeout(r, 1100)); // drain the rate-limit window
    a.send({ type: 'say', text: '/dm roll d20+5' });
    const rollScene2 = await a.next((f) => f.type === 'scene' && Number.isFinite(f.rollSeq) && (f.rollSeq as number) > seq1);
    check('web: a second identical roll advances rollSeq (repeat pop is not suppressed)',
      Boolean(rollScene2) && (rollScene2!.rollSeq as number) > seq1);
    await a.next((f) => f.type === 'msg' && f.speaker === 'Dungeon Master' && String(f.text).includes('tavern'));

    // A plain narration action (no dice) must yield NO roll frame.
    const rollsSoFar = a.all.filter((f) => f.type === 'roll').length;
    await new Promise((r) => setTimeout(r, 1100));
    a.send({ type: 'say', text: 'I ponder the flickering candlelight' });
    await a.next((f) => f.type === 'msg' && f.speaker === 'Dungeon Master' && String(f.text).includes('tavern'));
    a.send({ type: 'say', text: '/dm who' });
    await a.next((f) => f.type === 'msg' && String(f.text).includes('party')); // per-socket FIFO barrier: a stray roll frame would already be buffered
    check('web: a plain narration action emits no roll frame',
      a.all.filter((f) => f.type === 'roll').length === rollsSoFar);

    // ── Portraits over the web protocol: enriched roster + HTTP upload/serve ──
    type RosterUser = { userId: string; userName: string; characterName?: string; class?: string; bio?: string; portrait?: { kind?: string; id?: string; url?: string; data?: string } | null };
    await new Promise((r) => setTimeout(r, 1100)); // drain the rate-limit window
    a.send({ type: 'say', text: '/dm portrait ranger' });
    const presetRoster = await a.next(
      (f) => f.type === 'roster' && (f.users as RosterUser[]).some((u) => u.userName === 'Alice' && u.portrait?.kind === 'preset'),
    );
    const aliceSeat = (presetRoster?.users as RosterUser[] | undefined)?.find((u) => u.userName === 'Alice');
    check('web: enriched roster carries the character name and a preset portrait descriptor',
      aliceSeat?.characterName === 'Thorin' && aliceSeat?.portrait?.kind === 'preset' && aliceSeat?.portrait?.id === 'ranger');

    // Class + bio ride on the enriched roster seat too — /dm class also defaults
    // the preset portrait (ranger → wizard here, no image), and /dm bio is bounded.
    await new Promise((r) => setTimeout(r, 1100));
    a.send({ type: 'say', text: '/dm class wizard' });
    const classRoster = await a.next(
      (f) => f.type === 'roster' && (f.users as RosterUser[]).some((u) => u.userName === 'Alice' && u.class === 'wizard'),
    );
    const aliceClassed = (classRoster?.users as RosterUser[] | undefined)?.find((u) => u.userName === 'Alice');
    check('web: enriched roster carries the character class and the class-defaulted portrait',
      aliceClassed?.class === 'wizard' && aliceClassed?.portrait?.kind === 'preset' && aliceClassed?.portrait?.id === 'wizard');
    await new Promise((r) => setTimeout(r, 1100));
    a.send({ type: 'say', text: '/dm bio A wandering scholar chasing a lost spellbook.' });
    const bioRoster = await a.next(
      (f) => f.type === 'roster' && (f.users as RosterUser[]).some((u) => u.userName === 'Alice' && typeof u.bio === 'string' && u.bio.includes('spellbook')),
    );
    const aliceBio = (bioRoster?.users as RosterUser[] | undefined)?.find((u) => u.userName === 'Alice');
    check('web: enriched roster carries the character bio (no inline image bytes)',
      typeof aliceBio?.bio === 'string' && aliceBio.bio.includes('spellbook') && aliceBio.portrait?.data === undefined);

    // A bio LONGER than the card-summary clamp must ride the roster in FULL (up to
    // MAX_BIO_CHARS), not truncated with an ellipsis: the creator pre-fills its
    // editable textarea from this value, so a clamped bio would round-trip back
    // through `/dm bio` on the next save and silently overwrite the real 500-char
    // bio (and inject a literal '…'). The narrator already uses the full bio.
    await new Promise((r) => setTimeout(r, 1100));
    const longBioText = 'Lorekeeper of the Obsidian Spire; ' + 'a'.repeat(300);
    check('web: the long-bio fixture is deliberately over the card-summary clamp',
      longBioText.length > MAX_CARD_SUMMARY_CHARS && longBioText.length <= MAX_BIO_CHARS);
    a.send({ type: 'say', text: `/dm bio ${longBioText}` });
    const longBioRoster = await a.next(
      (f) => f.type === 'roster' && (f.users as RosterUser[]).some((u) => u.userName === 'Alice' && typeof u.bio === 'string' && u.bio.length > MAX_CARD_SUMMARY_CHARS),
    );
    const aliceLongBio = (longBioRoster?.users as RosterUser[] | undefined)?.find((u) => u.userName === 'Alice');
    check('web: a bio past the card-summary clamp rides the roster in full, un-ellipsised (creator round-trips it losslessly)',
      aliceLongBio?.bio === longBioText && aliceLongBio.bio.length === longBioText.length && !aliceLongBio.bio.endsWith('…'));

    // POST an image upload (carrying the seat's upload token), then GET it back
    // byte-for-byte. The token — not the URL userId — is what authorizes the write.
    const upBody = Buffer.from('\x89PNG\r\n\x1a\nMOCK-PORTRAIT-BYTES', 'latin1');
    const upRes = await fetch(`http://127.0.0.1:${port}/portrait/room1/${aliceId}`, {
      method: 'POST', headers: { 'Content-Type': 'image/png', 'x-upload-token': aliceToken }, body: upBody,
    });
    check('web: POST /portrait accepts an image upload carrying the seat upload token', upRes.ok);
    const getRes = await fetch(`http://127.0.0.1:${port}/portrait/room1/${aliceId}`);
    const gotBytes = Buffer.from(await getRes.arrayBuffer());
    check('web: GET /portrait round-trips the uploaded bytes with an image content-type',
      getRes.ok && (getRes.headers.get('content-type') ?? '').startsWith('image/') && gotBytes.equals(upBody));
    // The one endpoint that echoes attacker-supplied bytes must defang them:
    // nosniff (no MIME sniffing to an active type) + an explicit disposition.
    check('web: GET /portrait sends X-Content-Type-Options: nosniff and a Content-Disposition',
      getRes.headers.get('x-content-type-options') === 'nosniff' &&
      (getRes.headers.get('content-disposition') ?? '').includes('inline'));

    // No token → refused (userIds are public in the roster; they authorize nothing).
    const noTok = await fetch(`http://127.0.0.1:${port}/portrait/room1/${aliceId}`, {
      method: 'POST', headers: { 'Content-Type': 'image/png' }, body: upBody,
    });
    check('web: POST /portrait without an upload token is refused', noTok.status === 401);

    // Cross-user spoofing: Bob's token must NOT authorize writing Alice's portrait.
    const bobToken = bWelcome!.uploadToken as string;
    const spoof = await fetch(`http://127.0.0.1:${port}/portrait/room1/${aliceId}`, {
      method: 'POST', headers: { 'Content-Type': 'image/png', 'x-upload-token': bobToken }, body: upBody,
    });
    check("web: one seat's token cannot overwrite another seat's portrait (no impersonation)", spoof.status === 401);
    const afterSpoof = Buffer.from(await (await fetch(`http://127.0.0.1:${port}/portrait/room1/${aliceId}`)).arrayBuffer());
    check("web: the spoof attempt left Alice's portrait untouched", afterSpoof.equals(upBody));

    // Stored-XSS guard: an SVG (an active document) must be rejected outright.
    const svg = await fetch(`http://127.0.0.1:${port}/portrait/room1/${aliceId}`, {
      method: 'POST', headers: { 'Content-Type': 'image/svg+xml', 'x-upload-token': aliceToken },
      body: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>',
    });
    check('web: POST /portrait rejects image/svg+xml (stored-XSS vector)', svg.status === 415);

    const badType = await fetch(`http://127.0.0.1:${port}/portrait/room1/${aliceId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-upload-token': aliceToken }, body: '{}',
    });
    check('web: POST /portrait rejects a non-image content-type', badType.status === 415);
    const tooBig = await fetch(`http://127.0.0.1:${port}/portrait/room1/${aliceId}`, {
      method: 'POST', headers: { 'Content-Type': 'image/png', 'x-upload-token': aliceToken }, body: Buffer.alloc(MAX_PORTRAIT_BYTES + 1, 0x61),
    });
    check('web: POST /portrait rejects an oversize upload', tooBig.status === 413);
    const missing = await fetch(`http://127.0.0.1:${port}/portrait/room1/web-nobody`);
    check('web: GET /portrait for a user with no portrait is a 404', missing.status === 404);

    // A card import over the web: the embedded PNG becomes Bob's portrait,
    // referenced by URL in the roster and served (bytes) over HTTP — never a WS frame.
    await new Promise((r) => setTimeout(r, 1100));
    b.send({ type: 'say', text: `/dm import ${pngPath}` });
    await b.next((f) => f.type === 'msg' && String(f.text).includes('Vex'));
    const imgRoster = await b.next(
      (f) => f.type === 'roster' && (f.users as RosterUser[]).some((u) => u.userName === 'Bob' && u.portrait?.kind === 'image'),
    );
    const bobSeat = (imgRoster?.users as RosterUser[] | undefined)?.find((u) => u.userName === 'Bob');
    check('web: enriched roster references a card image portrait by URL, never inline bytes',
      bobSeat?.portrait?.kind === 'image' && typeof bobSeat.portrait.url === 'string' &&
      bobSeat.portrait.url.includes(`/portrait/room1/${bobId}`) && bobSeat.portrait.data === undefined &&
      JSON.stringify(imgRoster).length < MAX_FRAME_BYTES);
    const cardImg = await fetch(`http://127.0.0.1:${port}/portrait/room1/${bobId}`);
    const cardBytes = Buffer.from(await cardImg.arrayBuffer());
    const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    check('web: GET /portrait serves an imported card image (PNG bytes, image content-type)',
      cardImg.ok && (cardImg.headers.get('content-type') ?? '').startsWith('image/') &&
      cardBytes.length > 8 && cardBytes.subarray(0, 8).equals(PNG_SIG));

    // ── Scene token-board (VTT-lite): shared, server-authoritative state ──
    type SToken = { id: string; who: string; kind: string; x: number; y: number };
    // After /dm new + both joins, the board carries one pc token per party
    // member, each seeded to a normalized 0..1 position.
    const partyScene = await a.next(
      (f) => f.type === 'scene' && Array.isArray(f.tokens) && (f.tokens as SToken[]).filter((t) => t.kind === 'pc').length === 2,
    );
    const pcTokens = (partyScene!.tokens as SToken[]).filter((t) => t.kind === 'pc');
    check('web: the scene frame carries a pc token per party member, seeded inside 0..1',
      pcTokens.length === 2 && pcTokens.some((t) => t.who === 'Thorin') &&
      pcTokens.some((t) => t.id === `pc:${aliceId}`) &&
      pcTokens.every((t) => t.x >= 0 && t.x <= 1 && t.y >= 0 && t.y <= 1));

    // A move with out-of-range coords is clamped to 0..1 and rebroadcast to
    // everyone (the mover included — the server is authoritative).
    a.send({ type: 'move', id: `pc:${aliceId}`, x: 1.7, y: -0.4 });
    const clamped = (f: Frame) =>
      f.type === 'scene' && (f.tokens as SToken[]).some((t) => t.id === `pc:${aliceId}` && t.x === 1 && t.y === 0);
    const movedA = await a.next(clamped);
    const movedB = await b.next(clamped);
    check('web: a move updates the token, clamps x,y to 0..1, and echoes to the mover', Boolean(movedA));
    check('web: the move rebroadcasts the authoritative scene to every client in the room', Boolean(movedB));

    // Malformed / unknown moves get an error frame, never a crash.
    a.send({ type: 'move', id: 42, x: 'over-there' });
    const moveErr = await a.next((f) => f.type === 'error' && /move/i.test(String(f.error)));
    check('web: a malformed move yields an error frame, never a crash', Boolean(moveErr));
    a.send({ type: 'move', id: 'pc:web-ghost', x: 0.5, y: 0.5 });
    const ghostErr = await a.next((f) => f.type === 'error' && /Unknown token/i.test(String(f.error)));
    check('web: a move for an unknown token id is rejected, server still up', Boolean(ghostErr));

    // ── Scene: a dragged token survives a reconnect (a seat re-key keeps its spot) ──
    // A reconnect mints a fresh userId, re-keying the pc token id. The dragged
    // position must follow the character, not snap back to the default spawn.
    {
      const keep = new WsClient(url); // a co-occupant keeps the room (and its scene) alive across the reconnect
      await keep.open();
      keep.send({ type: 'hello', userName: 'Keeper', channelId: 'posroom', password: 'hunter2' });
      await keep.next((f) => f.type === 'welcome');
      const patToken = 'pat-resume-token-123456';
      const p1 = new WsClient(url);
      await p1.open();
      p1.send({ type: 'hello', userName: 'Pat', channelId: 'posroom', password: 'hunter2', resumeToken: patToken });
      const p1id = (await p1.next((f) => f.type === 'welcome'))!.userId as string;
      await new Promise((r) => setTimeout(r, 1100));
      p1.send({ type: 'say', text: '/dm new' });
      await p1.next((f) => f.type === 'msg' && String(f.text).includes('new campaign'));
      await new Promise((r) => setTimeout(r, 1100));
      p1.send({ type: 'say', text: '/dm join Ranger' });
      await p1.next((f) => f.type === 'msg' && String(f.text).includes('Ranger joins'));
      await p1.next((f) => f.type === 'scene' && (f.tokens as SToken[]).some((t) => t.id === `pc:${p1id}`));
      p1.send({ type: 'move', id: `pc:${p1id}`, x: 0.87, y: 0.12 });
      const placed = await p1.next(
        (f) => f.type === 'scene' && (f.tokens as SToken[]).some((t) => t.id === `pc:${p1id}` && Math.abs(t.x - 0.87) < 1e-6 && Math.abs(t.y - 0.12) < 1e-6),
      );
      check('web: a token drag is recorded before the reconnect', Boolean(placed));
      p1.close(); // Pat's socket drops; Keeper remains so the scene is not reclaimed
      await p1.closed();
      const p2 = new WsClient(url);
      await p2.open();
      p2.send({ type: 'hello', userName: 'Pat', channelId: 'posroom', password: 'hunter2', resumeToken: patToken });
      const p2id = (await p2.next((f) => f.type === 'welcome'))!.userId as string;
      await new Promise((r) => setTimeout(r, 1100));
      p2.send({ type: 'say', text: '/dm join Ranger' }); // re-claim the seat under a fresh userId (matching token)
      await p2.next((f) => f.type === 'msg' && String(f.text).includes('Ranger joins'));
      const reScene = await p2.next((f) => f.type === 'scene' && (f.tokens as SToken[]).some((t) => t.id === `pc:${p2id}`));
      const reTok = (reScene!.tokens as SToken[]).find((t) => t.id === `pc:${p2id}`);
      check('web: a dragged token survives a reconnect — the re-keyed seat keeps its board position, not a fresh spawn',
        p2id !== p1id && Boolean(reTok) && Math.abs(reTok!.x - 0.87) < 1e-6 && Math.abs(reTok!.y - 0.12) < 1e-6 &&
        !(reScene!.tokens as SToken[]).some((t) => t.id === `pc:${p1id}`));
      keep.close();
      p2.close();
    }

    // An NPC import (by a spectator, so it lands as an NPC) adds an npc token.
    const sp = new WsClient(url);
    await sp.open();
    sp.send({ type: 'hello', userName: 'Watcher', channelId: 'room1', password: 'hunter2' });
    await sp.next((f) => f.type === 'welcome');
    await new Promise((r) => setTimeout(r, 1100)); // drain the rate-limit window before a say
    sp.send({ type: 'say', text: `/dm import ${pngPath}` });
    await sp.next((f) => f.type === 'msg' && String(f.text).includes('as an NPC'));
    const npcScene = await sp.next((f) => f.type === 'scene' && (f.tokens as SToken[]).some((t) => t.kind === 'npc'));
    const npcTok = (npcScene!.tokens as SToken[]).find((t) => t.kind === 'npc');
    check('web: importing an NPC adds an npc token to the shared board',
      Boolean(npcTok) && npcTok!.who === 'Vex' && npcTok!.id.startsWith('npc:') &&
      npcTok!.x >= 0 && npcTok!.x <= 1 && npcTok!.y >= 0 && npcTok!.y <= 1);

    // The actor field reflects the round-robin turn pointer once round-robin is on.
    await new Promise((r) => setTimeout(r, 1100));
    a.send({ type: 'say', text: '/dm mode round-robin' });
    await a.next((f) => f.type === 'msg' && String(f.text).includes('Round-robin'));
    const rrScene = await a.next((f) => f.type === 'scene' && typeof f.actor === 'string');
    check('web: the scene actor reflects the round-robin turn pointer when set', rrScene?.actor === 'Thorin');
    sp.close(); // the spectator leaves room1 so the later roster-shrink check sees only Alice + Bob

    const c = new WsClient(url);
    await c.open();
    c.send({ type: 'say', text: 'too eager' });
    const early = await c.next((f) => f.type === 'error');
    check('web: say before hello gets an error frame', Boolean(early?.error && String(early.error).includes('hello')));
    c.send('this is not json {');
    const malformed = await c.next((f) => f.type === 'error' && String(f.error).includes('JSON'));
    check('web: malformed frame gets an error frame', Boolean(malformed));
    c.send({ type: 'wibble' });
    const unknown = await c.next((f) => f.type === 'error' && String(f.error).includes('Unknown frame type'));
    check('web: unknown frame type gets an error frame — server still up', Boolean(unknown));

    c.send({ type: 'hello', userName: 'Carl', channelId: 'spam', password: 'hunter2' });
    await c.next((f) => f.type === 'welcome');
    for (let i = 0; i <= RATE_LIMIT_PER_SEC; i++) c.send({ type: 'say', text: `spam ${i}` });
    const limited = await c.next((f) => f.type === 'error' && String(f.error).includes('Rate limit'));
    check(`web: message ${RATE_LIMIT_PER_SEC + 1} inside one second is rate-limited`, Boolean(limited));

    // Size caps: the rate limit bounds frequency, these bound bytes — the
    // client's maxlength attributes are trivially bypassed by a raw socket.
    a.send({ type: 'say', text: 'x'.repeat(MAX_TEXT_CHARS + 1) });
    const tooLong = await a.next((f) => f.type === 'error' && String(f.error).includes('too long'));
    check('web: over-length say text is refused server-side', Boolean(tooLong));
    check('web: the oversized text was never relayed to the room', !b.sawText('x'.repeat(50)));
    const d = new WsClient(url);
    await d.open();
    d.send({ type: 'hello', userName: 'x'.repeat(MAX_NAME_CHARS + 1), channelId: 'room1', password: 'hunter2' });
    const longName = await d.next((f) => f.type === 'error' && String(f.error).includes('too long'));
    check('web: over-length hello userName is refused server-side', Boolean(longName));
    d.send('z'.repeat(MAX_FRAME_BYTES + 1024));
    check('web: a frame above MAX_FRAME_BYTES drops the connection (ws maxPayload)', await d.closedWithin());

    // A socket that never says hello has no seat-level limiter — its frame
    // budget must drop it instead of answering a flood frame-for-frame.
    const flood = new WsClient(url);
    await flood.open();
    for (let i = 0; i < UNJOINED_FRAMES_PER_SEC + 3; i++) flood.send({ type: 'wibble' });
    check('web: a pre-hello frame flood drops the socket', await flood.closedWithin());

    b.close();
    const shrunk = await a.next((f) => f.type === 'roster' && (f.users as unknown[]).length === 1);
    check('web: a closing socket leaves the roster', (shrunk?.users as { userName: string }[])?.[0]?.userName === 'Alice');

    a.close();
    c.close();
    await web.stop();
    check('web: stop() releases the port', await fetch(`http://127.0.0.1:${port}/`).then(() => false, () => true));
  }

  });
  suite.section("Web adapter: connection cap + hello deadline (tight limits so the test is fast)", async () => {
  // ── Web adapter: connection cap + hello deadline (tight limits so the test is fast) ──
  {
    const tiny = new WebAdapter('127.0.0.1', 0, '', 2, 800); // cap: 2 sockets, 800 ms to complete hello
    await tiny.start();
    const turl = `ws://127.0.0.1:${tiny.port}/ws`;
    const s1 = new WsClient(turl);
    await s1.open(); // never says hello — the reaper's prey
    const s2 = new WsClient(turl);
    await s2.open();
    s2.send({ type: 'hello', userName: 'Kept', channelId: 'keep' });
    await s2.next((f) => f.type === 'welcome');
    const s3 = new WsClient(turl);
    await s3.open();
    const full = await s3.next((f) => f.type === 'error' && String(f.error).includes('full'));
    check('web: a connection beyond the cap is refused with an error frame', Boolean(full));
    check('web: the refused connection does not stay open', await s3.closedWithin());
    check('web: a socket that never completes hello is reaped after the deadline', await s1.closedWithin(4000));
    s2.send({ type: 'say', text: 'still here' }); // no bot wired — the room relay alone proves the socket lives
    check('web: a joined socket outlives the hello deadline',
      Boolean(await s2.next((f) => f.type === 'msg' && String(f.text).includes('still here'))));
    s2.close();
    await tiny.stop();
  }

  });
  suite.section("Provider switch: a persisted foreign model id must not brick old campaigns", async () => {
  // ── Provider switch: a persisted foreign model id must not brick old campaigns ──
  {
    const anthropic = new AnthropicProvider({ apiKey: 'x' });
    check('provider: anthropic declares which model ids it can serve',
      anthropic.supportsModel('claude-sonnet-5') && anthropic.supportsModel('claude-haiku-4-5-20251001') &&
      !anthropic.supportsModel('meta-llama/llama-3.3-70b-instruct:free'));
    await fs.writeFile(path.join(dataDir, 'session_cli_oldmodel.json'), JSON.stringify({
      id: 'old2', platform: 'cli', channelId: 'oldmodel', systemId: 'dnd5e',
      model: 'meta-llama/llama-3.3-70b-instruct:free', players: {}, history: [], summary: '', createdAt: 1,
    }), 'utf8');
    const mgr = new SessionManager(new NodeFileStorage(dataDir), 'meta-llama/llama-3.3-70b-instruct:free', anthropic);
    const migrated = await mgr.get({ platform: 'cli', channelId: 'oldmodel', userId: 'u', userName: 'U', text: '' });
    check('provider: persisted OpenRouter model id remaps to a servable Claude default',
      migrated?.model === 'claude-sonnet-5');
    check('provider: new sessions never pin an unservable model',
      (await mgr.create({ platform: 'cli', channelId: 'oldmodel2', userId: 'u', userName: 'U', text: '' })).model === 'claude-sonnet-5');
  }

  });
  suite.section("/dm end must evict the live session cache, not just delete the file", async () => {
  // ── /dm end must evict the live session cache, not just delete the file ──
  out.length = 0;
  await bot.handle(from('u1', 'Alice', '/dm end'), send);
  check('end: campaign ends', out.at(-1)!.text.includes('Campaign ended'));
  out.length = 0;
  await bot.handle(from('u1', 'Alice', 'I knock on the tavern door'), send);
  check('end: ended campaign does not resurrect from the live session cache',
    out.at(-1)!.text.includes('No game in this channel'));
  check('end: session file stays deleted', !(await fs.readdir(dataDir)).includes(sessionFile!));

  });
  suite.section("Storage seam: the same bot pipeline runs unchanged on MemoryStorage", async () => {
  // ── Storage seam: the same bot pipeline runs unchanged on MemoryStorage ──
  {
    const memBot = new Bot(config, provider, new MemoryStorage());
    const memOut: OutgoingMessage[] = [];
    const memSend = async (m: OutgoingMessage) => void memOut.push(m);
    const mem = (userId: string, userName: string, text: string): IncomingMessage =>
      ({ platform: 'cli', channelId: 'memchan', userId, userName, text });
    await memBot.handle(mem('u1', 'Alice', '/dm new'), memSend);
    await memBot.handle(mem('u1', 'Alice', '/dm join Thorin'), memSend);
    await memBot.handle(mem('u2', 'Bob', '/dm join Elaria'), memSend);
    memOut.length = 0;
    await memBot.handle(mem('u1', 'Alice', 'I attack the goblin with my d20+5 sword'), memSend);
    check('storage: full turn (dice → narration) resolves against MemoryStorage',
      memOut.at(-1)!.speaker === 'Dungeon Master' && /RESOLVED ROLLS/.test(provider.lastPrompt) && /d20\+5/.test(provider.lastPrompt));
    memOut.length = 0;
    await memBot.handle(mem('u1', 'Alice', '/dm who'), memSend);
    check('storage: party persists across turns in MemoryStorage', memOut.at(-1)!.text.includes('Thorin') && memOut.at(-1)!.text.includes('Elaria'));
    check('storage: MemoryStorage writes nothing to disk', !(await fs.readdir(dataDir)).some((f) => f.includes('memchan')));
    await memBot.handle(mem('u1', 'Alice', '/dm end'), memSend);
    memOut.length = 0;
    await memBot.handle(mem('u1', 'Alice', 'I knock on the tavern door'), memSend);
    check('storage: /dm end deletes through MemoryStorage — no resurrection', memOut.at(-1)!.text.includes('No game in this channel'));
  }

  });
  suite.section("Backward compatibility: session saved before turnMode/npcs existed", async () => {
  // ── Backward compatibility: session saved before turnMode/npcs existed ──
  await fs.writeFile(
    path.join(dataDir, 'session_cli_legacy.json'),
    JSON.stringify({ id: 'old1', platform: 'cli', channelId: 'legacy', systemId: 'dnd5e', model: 'mock/free-model', players: {}, history: [], summary: '', createdAt: 1 }),
    'utf8',
  );
  const legacy = await store.load('cli:legacy');
  check('legacy: pre-feature session loads with mode immediate', legacy?.turnMode === 'immediate' && legacy?.turnIndex === 0);
  check('legacy: pre-card session defaults to no NPCs', Array.isArray(legacy?.npcs) && legacy!.npcs.length === 0);
  check('legacy: pre-lorebook session defaults to an empty lorebook', Array.isArray(legacy?.lorebook) && legacy!.lorebook.length === 0);
  check('legacy: pre-fog session defaults to fog of war off', legacy?.fogOfWar === false);
  check('legacy: pre-memory session defaults to no memory records', Array.isArray(legacy?.memories) && legacy!.memories.length === 0);

  // A pre-portrait session with a seated player and an NPC card: both must load
  // with their portraits simply absent (the fields are optional / absent-safe).
  await fs.writeFile(
    path.join(dataDir, 'session_cli_oldp.json'),
    JSON.stringify({
      id: 'oldp', platform: 'cli', channelId: 'oldp', systemId: 'dnd5e', model: 'mock/free-model',
      players: { u1: { userId: 'u1', userName: 'Alice', characterName: 'Thorin', hp: 10, maxHp: 10 } },
      npcs: [{ specVersion: '2.0', name: 'Grim' }], history: [], summary: '', createdAt: 1,
    }),
    'utf8',
  );
  const oldp = await store.load('cli:oldp');
  check('legacy: pre-portrait session loads; player & NPC portraits default to absent',
    oldp?.players.u1?.characterName === 'Thorin' && oldp!.players.u1!.portrait === undefined && oldp!.npcs[0]?.portrait === undefined);

  // Retired/unknown class-or-portrait ids resolve to a sensible class — never crash.
  check('legacy: a retired preset id resolves to its successor class', resolvePresetId('mage') === 'wizard');
  check('legacy: an unknown preset id resolves to the default class', resolvePresetId('totally-made-up') === 'fighter');
  check('legacy: a current class id resolves to itself', resolvePresetId('paladin') === 'paladin');

  // A pre-class session storing a since-removed preset id must load fine; the id
  // is kept verbatim on disk and readers resolve it through resolvePresetId.
  await fs.writeFile(
    path.join(dataDir, 'session_cli_oldpreset.json'),
    JSON.stringify({
      id: 'oldpreset', platform: 'cli', channelId: 'oldpreset', systemId: 'dnd5e', model: 'mock/free-model',
      players: { u1: { userId: 'u1', userName: 'Alice', characterName: 'Thorin', hp: 10, maxHp: 10, portrait: { kind: 'preset', id: 'mage' } } },
      npcs: [], history: [], summary: '', createdAt: 1,
    }),
    'utf8',
  );
  const oldPreset = await store.load('cli:oldpreset');
  check('legacy: a session with a retired preset id loads and resolves to the fallback',
    oldPreset?.players.u1?.class === undefined &&
    oldPreset?.players.u1?.portrait?.kind === 'preset' &&
    resolvePresetId((oldPreset!.players.u1!.portrait as { id: string }).id) === 'wizard');

  });
  suite.section("Portable engine: bundled rules registry (no node:fs on the narrator path)", async () => {
  // ── Portable engine: bundled rules registry (no node:fs on the narrator path) ──
  {
    const ruleMd = await fs.readFile('src/rules/dnd5e/system.md', 'utf8');
    staticCheck('rules: bundled dnd5e module is byte-identical to rules/dnd5e/system.md (no drift)', BUNDLED_RULES.dnd5e === ruleMd);
    check('rules: provider returns bundled content and empty for unknown systems',
      bundledRulesProvider.system('dnd5e') === ruleMd && bundledRulesProvider.system('nope') === '');
    // The narrator now reads rules through the registry — the on-disk rules text
    // still reaches the prompt (behaviour preserved, proven live below).
    const rBot = new Bot(config, provider, new MemoryStorage());
    const rOut: OutgoingMessage[] = [];
    const rMsg = (t: string): IncomingMessage => ({ platform: 'cli', channelId: 'rules', userId: 'u1', userName: 'Alice', text: t });
    await rBot.handle(rMsg('/dm new'), async (m) => void rOut.push(m));
    await rBot.handle(rMsg('/dm join Thorin'), async (m) => void rOut.push(m));
    await rBot.handle(rMsg('I look around'), async (m) => void rOut.push(m));
    check('rules: bundled system module reaches the narrator prompt without node:fs',
      provider.lastPrompt.includes('System Module — D&D 5e'));
  }

  });
  suite.section("Monetization scaffold: content packs + entitlements", async () => {
  // ── Monetization scaffold: content packs + entitlements ──
  {
    // Bundled example pack: byte-identical mirror of the on-disk file (no drift),
    // same discipline as the rules-module bundling above.
    const packJsonOnDisk = await fs.readFile('content-packs/frontier-outpost.pack.json', 'utf8');
    staticCheck('content-packs: bundled frontier-outpost pack is byte-identical to content-packs/frontier-outpost.pack.json',
      FRONTIER_OUTPOST_PACK_JSON === packJsonOnDisk);

    // The Node file loader validates the same on-disk pack and agrees with the bundled one.
    const packFromFile = await loadContentPackFile('content-packs/frontier-outpost.pack.json');
    check('content-packs: loadContentPackFile validates the on-disk pack (Node loader)',
      packFromFile.id === 'frontier-outpost' && packFromFile.premium === true);

    // Eager module-load validation succeeded, and the catalog surfaces it correctly.
    const bundled = BUNDLED_CONTENT_PACKS['frontier-outpost'];
    check('content-packs: bundled catalog validated the example pack at module load',
      bundled?.id === 'frontier-outpost' && bundled.lorebook.length === 5 && bundled.npcs.length === 2 &&
      bundled.rulesModule?.id === 'frontier-lite' && bundled.campaignStarter?.systemId === 'frontier-lite');
    check('content-packs: getBundledContentPack looks up by id; unknown id is undefined',
      getBundledContentPack('frontier-outpost') === bundled && getBundledContentPack('nope') === undefined);
    const catalog = listBundledContentPacks();
    check('content-packs: listBundledContentPacks surfaces catalog metadata (premium flagged)',
      catalog.some((p) => p.id === 'frontier-outpost' && p.premium === true));

    // Malformed packs are rejected — one representative case per validated field,
    // and the error never echoes the (untrusted) raw input back.
    const malformed: [string, unknown][] = [
      ['not an object', 'nope'],
      ['wrong formatVersion', { formatVersion: 2, id: 'x', name: 'X', version: '1.0.0' }],
      ['missing id', { formatVersion: 1, name: 'X', version: '1.0.0' }],
      ['id with illegal characters (echo-bait payload)', { formatVersion: 1, id: '<script>alert(1)</script>', name: 'X', version: '1.0.0' }],
      ['missing name', { formatVersion: 1, id: 'x', version: '1.0.0' }],
      ['missing version', { formatVersion: 1, id: 'x', name: 'X' }],
      ['lorebook not an array', { formatVersion: 1, id: 'x', name: 'X', version: '1.0.0', lorebook: 'nope' }],
      ['lorebook entry missing content', { formatVersion: 1, id: 'x', name: 'X', version: '1.0.0', lorebook: [{ name: 'A', keywords: [] }] }],
      ['npc missing name', { formatVersion: 1, id: 'x', name: 'X', version: '1.0.0', npcs: [{ description: 'no name' }] }],
      ['rulesModule missing markdown', { formatVersion: 1, id: 'x', name: 'X', version: '1.0.0', rulesModule: { id: 'sys', name: 'Sys' } }],
      ['too many lorebook entries', { formatVersion: 1, id: 'x', name: 'X', version: '1.0.0', lorebook: Array.from({ length: 201 }, (_, i) => ({ name: `E${i}`, keywords: [], content: 'c' })) }],
    ];
    let allRejected = true;
    let anyLeakedInput = false;
    for (const [label, raw] of malformed) {
      try {
        validateContentPack(raw);
        allRejected = false;
        console.log(`  ⚠️ malformed pack NOT rejected: ${label}`);
      } catch (e) {
        if (!(e instanceof ContentPackError)) allRejected = false;
        if (String((e as Error).message).includes('<script>')) anyLeakedInput = true;
      }
    }
    check('content-packs: every malformed pack shape is rejected with ContentPackError', allRejected);
    check('content-packs: validation errors never echo untrusted input back', !anyLeakedInput);
    check('content-packs: malformed top-level JSON text is rejected without echoing it',
      (() => { try { parseContentPackJson('{ not json'); return false; } catch (e) { return e instanceof ContentPackError && !String((e as Error).message).includes('not json'); } })());

    // Entitlements: self-host unlocks everything (no billing = nothing gated).
    check('entitlements: self-host unlocks any pack/feature key',
      selfHostEntitlements.id === 'self-host' && selfHostEntitlements.isUnlocked('frontier-outpost') && selfHostEntitlements.isUnlocked('anything-at-all'));
    check('entitlements: selectEntitlements({}) defaults to self-host (unlocked)',
      selectEntitlements().id === 'self-host' && selectEntitlements().isUnlocked('frontier-outpost'));

    // Hosted stub: a bare flag with no enforcement is a no-op (never locks anyone out by accident).
    check('entitlements: hosted stub without enforcePremium behaves like self-host',
      createHostedEntitlements().isUnlocked('frontier-outpost') === true);
    // Hosted stub WITH the flag set actually gates premium content...
    const hostedGated = createHostedEntitlements({ enforcePremium: true });
    check('entitlements: hosted stub with the flag set gates a premium pack by default',
      hostedGated.id === 'hosted' && hostedGated.isUnlocked('frontier-outpost') === false);
    // ...unless the pack id (or '*') is on the unlocked list.
    check('entitlements: hosted stub unlocks a pack explicitly listed',
      createHostedEntitlements({ enforcePremium: true, unlockedKeys: ['frontier-outpost'] }).isUnlocked('frontier-outpost') === true);
    check('entitlements: hosted stub\'s "*" unlocks everything',
      createHostedEntitlements({ enforcePremium: true, unlockedKeys: ['*'] }).isUnlocked('anything') === true);
    check('entitlements: selectEntitlements({hosted:true}) gates with no unlocked ids',
      selectEntitlements({ hosted: true }).isUnlocked('frontier-outpost') === false);

    // Per-tenant entitlements: a hosted process serving MULTIPLE
    // guilds/rooms must be able to unlock a premium pack for the one tenant
    // that paid WITHOUT unlocking it for every other tenant in the same
    // process — the whole point of "sell a premium content pack" as a
    // business model for a realistic (single-process, multi-guild) hosted
    // deployment.
    const tenantA = { platform: 'discord', channelId: 'guild-A' };
    const tenantB = { platform: 'discord', channelId: 'guild-B' };
    check('entitlements: tenantKey derives a stable "platform:channelId" string',
      tenantKey(tenantA) === 'discord:guild-A');
    const perTenantGated = createHostedEntitlements({
      enforcePremium: true,
      perTenantUnlockedKeys: { [tenantKey(tenantA)]: ['frontier-outpost'] },
    });
    check('entitlements: a pack unlocked for ONE tenant is unlocked when checked with that tenant\'s scope',
      perTenantGated.isUnlocked('frontier-outpost', tenantA) === true);
    check('entitlements: the SAME pack stays locked for a DIFFERENT tenant in the same Entitlements instance',
      perTenantGated.isUnlocked('frontier-outpost', tenantB) === false);
    check('entitlements: a per-tenant-gated pack is still locked with no scope at all',
      perTenantGated.isUnlocked('frontier-outpost') === false);
    check('entitlements: selectEntitlements threads tenantUnlockedPackIds through to per-tenant scoping',
      selectEntitlements({ hosted: true, tenantUnlockedPackIds: { [tenantKey(tenantA)]: ['frontier-outpost'] } })
        .isUnlocked('frontier-outpost', tenantA) === true &&
      selectEntitlements({ hosted: true, tenantUnlockedPackIds: { [tenantKey(tenantA)]: ['frontier-outpost'] } })
        .isUnlocked('frontier-outpost', tenantB) === false);

    // Display never lies about a free pack: isPackLockedForDisplay (what
    // `/dm pack list` uses) must match loadContentPack's ACTUAL gate exactly
    // — a free pack is never "(locked)" even when isUnlocked(id) is false,
    // because loadContentPack only ever gates a premium pack.
    const freePackForDisplay = validateContentPack({ formatVersion: 1, id: 'free-thing', name: 'Free Thing', version: '1.0.0' });
    const alwaysDeniedEntitlements = createHostedEntitlements({ enforcePremium: true }); // locks everything not on an empty allowlist
    check('content-packs: a FREE pack is never shown "(locked)", even under entitlements that deny its id outright',
      alwaysDeniedEntitlements.isUnlocked('free-thing') === false &&
      isPackLockedForDisplay(freePackForDisplay, alwaysDeniedEntitlements) === false);
    check('content-packs: a PREMIUM pack IS shown "(locked)" when entitlements deny it, and not when they allow it',
      isPackLockedForDisplay(bundled, alwaysDeniedEntitlements) === true &&
      isPackLockedForDisplay(bundled, selfHostEntitlements) === false);

    // The loader: importing the pack into a session, reusing lorebook/card/rules types.
    const freshSession: GameSession = {
      id: 'pk1', platform: 'cli', channelId: 'pack-test', systemId: 'dnd5e', model: 'mock/free-model',
      players: {}, npcs: [], lorebook: [], history: [], summary: '', memories: [],
      turnMode: 'immediate', turnIndex: 0, fogOfWar: false, createdAt: Date.now(),
    };
    const result = loadContentPack(bundled, freshSession, selfHostEntitlements);
    check('content-packs: loadContentPack imports the pack\'s lorebook entries',
      result.lorebookAdded === 5 && freshSession.lorebook.some((e) => e.name === "Kestrel's Reach"));
    check('content-packs: loadContentPack imports the pack\'s NPCs as CharacterCards',
      result.npcsAdded === 2 && freshSession.npcs.some((n) => n.name === 'Mirelle Ashgrove' && n.specVersion === '2.0'));
    check('content-packs: loadContentPack attaches the pack\'s rules module to THIS session only (session.customRules), not the shared registry',
      result.rulesRegistered === true &&
      freshSession.customRules?.id === 'frontier-lite' && freshSession.customRules.markdown.includes('Frontier Lite') &&
      bundledRulesProvider.system('frontier-lite') === '');
    check('content-packs: loadContentPack applies the campaign starter on a fresh (history-less) session',
      result.starterApplied === true &&
      freshSession.systemId === 'frontier-lite' &&
      freshSession.summary.includes('Kestrel') &&
      freshSession.history.length === 1 &&
      freshSession.history[0].narration.includes('Mirelle Ashgrove'));

    // Loading the same pack again is idempotent: no duplicate lore/NPCs, and the
    // starter does not re-apply once the session already has history.
    const again = loadContentPack(bundled, freshSession, selfHostEntitlements);
    check('content-packs: reloading the same pack is a no-op (dedup by content/name, starter already applied)',
      again.lorebookAdded === 0 && again.npcsAdded === 0 && again.starterApplied === false &&
      freshSession.lorebook.length === 5 && freshSession.npcs.length === 2);

    // SECURITY: a pack's rules module must be scoped to the session that
    // loaded it — never a shared, process-wide registry — even when its
    // `rulesModule.id` collides with a BUNDLED system id like "dnd5e". Build
    // a hostile pack that claims to be "dnd5e" and prove (a) the session that
    // loaded it sees its own hijacked text, (b) a totally separate session in
    // the SAME bot/process on "dnd5e" is untouched, and (c) the shared
    // `bundledRulesProvider` itself was never mutated.
    const hijackPack = validateContentPack({
      formatVersion: 1, id: 'evil-pack', name: 'Evil Pack', version: '1.0.0',
      rulesModule: { id: 'dnd5e', name: 'Evil D&D', markdown: 'HIJACKED RULES — must never leak to another session.' },
    });
    const hijackStore = new MemoryStorage();
    const hijackBot = new Bot(config, provider, hijackStore);
    const hijackOut: OutgoingMessage[] = [];
    const hijackSend = async (m: OutgoingMessage) => void hijackOut.push(m);
    const hijackMsg = (t: string, ch: string): IncomingMessage => ({ platform: 'cli', channelId: ch, userId: 'u1', userName: 'Alice', text: t });
    await hijackBot.handle(hijackMsg('/dm new', 'hijack-a'), hijackSend);
    await hijackBot.handle(hijackMsg('/dm join Thorin', 'hijack-a'), hijackSend);
    const hijackedSession = await hijackStore.load('cli:hijack-a');
    loadContentPack(hijackPack, hijackedSession!, selfHostEntitlements);
    await hijackBot.handle(hijackMsg('I ready my blade', 'hijack-a'), hijackSend);
    check('content-packs: a session that loads a pack colliding with a bundled system id ("dnd5e") sees ITS OWN hijacked rules in its own prompt',
      provider.lastPrompt.includes('HIJACKED RULES'));

    await hijackBot.handle(hijackMsg('/dm new', 'hijack-b'), hijackSend);
    await hijackBot.handle(hijackMsg('/dm join Elaria', 'hijack-b'), hijackSend);
    await hijackBot.handle(hijackMsg('I look around', 'hijack-b'), hijackSend);
    check('content-packs: a SEPARATE session in the same process/bot is unaffected by another session\'s colliding rules module (no cross-session leakage)',
      provider.lastPrompt.includes('System Module — D&D 5e') && !provider.lastPrompt.includes('HIJACKED RULES'));
    check('content-packs: the shared bundledRulesProvider is never mutated by loadContentPack, even under an id collision',
      bundledRulesProvider.system('dnd5e').includes('System Module — D&D 5e') && !bundledRulesProvider.system('dnd5e').includes('HIJACKED'));

    // Two DIFFERENT packs that happen to reuse the same (non-bundled) custom
    // rulesModule.id must not clobber each other across sessions either.
    const packA = validateContentPack({
      formatVersion: 1, id: 'homebrew-a', name: 'Homebrew A', version: '1.0.0',
      rulesModule: { id: 'homebrew-shared', name: 'Homebrew Shared', markdown: 'MARKDOWN_FROM_PACK_A' },
    });
    const packB = validateContentPack({
      formatVersion: 1, id: 'homebrew-b', name: 'Homebrew B', version: '1.0.0',
      rulesModule: { id: 'homebrew-shared', name: 'Homebrew Shared', markdown: 'MARKDOWN_FROM_PACK_B' },
    });
    const sessA: GameSession = {
      id: 'ca', platform: 'cli', channelId: 'collide-a', systemId: 'homebrew-shared', model: 'mock/free-model',
      players: {}, npcs: [], lorebook: [], history: [], summary: '', memories: [],
      turnMode: 'immediate', turnIndex: 0, fogOfWar: false, createdAt: Date.now(),
    };
    const sessB: GameSession = {
      id: 'cb', platform: 'cli', channelId: 'collide-b', systemId: 'homebrew-shared', model: 'mock/free-model',
      players: {}, npcs: [], lorebook: [], history: [], summary: '', memories: [],
      turnMode: 'immediate', turnIndex: 0, fogOfWar: false, createdAt: Date.now(),
    };
    loadContentPack(packA, sessA, selfHostEntitlements);
    loadContentPack(packB, sessB, selfHostEntitlements);
    check('content-packs: two sessions loading DIFFERENT packs that reuse the same custom rulesModule.id keep independent markdown (no clobber)',
      sessA.customRules?.markdown === 'MARKDOWN_FROM_PACK_A' && sessB.customRules?.markdown === 'MARKDOWN_FROM_PACK_B');

    // The low-level, explicit, PROCESS-WIDE registry (registerRulesModule /
    // clearRuntimeRules) is a deliberate host-boot-time seam, distinct from the
    // session-scoped path above — prove it still works, and that its own
    // documented reset hook (previously dead code — never called anywhere,
    // including here) actually resets it.
    check('rules-registry: bundledRulesProvider has no runtime override for an unregistered id',
      bundledRulesProvider.system('homebrew-global-test') === '');
    registerRulesModule('homebrew-global-test', 'GLOBAL_MARKDOWN');
    check('rules-registry: registerRulesModule installs an explicit, process-wide override (host opt-in, not pack loading)',
      bundledRulesProvider.system('homebrew-global-test') === 'GLOBAL_MARKDOWN');
    clearRuntimeRules();
    check('rules-registry: clearRuntimeRules() drops all runtime-registered modules (the reset hook, now actually exercised)',
      bundledRulesProvider.system('homebrew-global-test') === '');

    // A premium pack is refused outright when entitlements don't unlock it — the
    // session must be left untouched (no partial import on a locked pack).
    const lockedSession: GameSession = {
      id: 'pk2', platform: 'cli', channelId: 'pack-locked', systemId: 'dnd5e', model: 'mock/free-model',
      players: {}, npcs: [], lorebook: [], history: [], summary: '', memories: [],
      turnMode: 'immediate', turnIndex: 0, fogOfWar: false, createdAt: Date.now(),
    };
    let lockedThrew = false;
    try {
      loadContentPack(bundled, lockedSession, hostedGated);
    } catch (e) {
      lockedThrew = e instanceof PackLockedError && (e as PackLockedError).packId === 'frontier-outpost';
    }
    check('content-packs: a premium pack throws PackLockedError under hosted entitlements without unlock',
      lockedThrew && lockedSession.lorebook.length === 0 && lockedSession.npcs.length === 0);

    // End-to-end through the Bot: `/dm pack list` + `/dm pack load` on both a
    // self-host (unlocked) and a hosted-gated (locked) configuration.
    const pkOut: OutgoingMessage[] = [];
    const pkSend = async (m: OutgoingMessage) => void pkOut.push(m);
    const pkBot = new Bot(config, provider, new MemoryStorage());
    const pkMsg = (t: string): IncomingMessage => ({ platform: 'cli', channelId: 'pack-bot', userId: 'u1', userName: 'Alice', text: t });
    await pkBot.handle(pkMsg('/dm new'), pkSend);
    await pkBot.handle(pkMsg('/dm pack list'), pkSend);
    check('content-packs: `/dm pack list` shows the bundled pack unlocked under self-host',
      /frontier-outpost/.test(pkOut.at(-1)?.text ?? '') && !/locked/.test(pkOut.at(-1)?.text ?? ''));
    await pkBot.handle(pkMsg('/dm pack load frontier-outpost'), pkSend);
    check('content-packs: `/dm pack load` succeeds under self-host default entitlements',
      /Loaded \*\*Frontier Outpost\*\*/.test(pkOut.at(-1)?.text ?? ''));
    await pkBot.handle(pkMsg('/dm pack load nope-such-pack'), pkSend);
    check('content-packs: `/dm pack load` on an unknown id replies without throwing',
      /No bundled content pack/.test(pkOut.at(-1)?.text ?? ''));

    const hostedConfig: Config = { ...config, monetization: { hosted: true, unlockedPackIds: [], tenantUnlockedPackIds: {} } };
    const hostedOut: OutgoingMessage[] = [];
    const hostedSend = async (m: OutgoingMessage) => void hostedOut.push(m);
    const hostedBot = new Bot(hostedConfig, provider, new MemoryStorage());
    const hostedMsg = (t: string): IncomingMessage => ({ platform: 'cli', channelId: 'pack-hosted', userId: 'u1', userName: 'Alice', text: t });
    await hostedBot.handle(hostedMsg('/dm new'), hostedSend);
    await hostedBot.handle(hostedMsg('/dm pack list'), hostedSend);
    check('content-packs: `/dm pack list` flags the pack "(locked)" under a hosted config with nothing unlocked',
      /\(locked\)/.test(hostedOut.at(-1)?.text ?? ''));
    await hostedBot.handle(hostedMsg('/dm pack load frontier-outpost'), hostedSend);
    check('content-packs: `/dm pack load` refuses a premium pack under hosted entitlements without unlock',
      /premium content pack and isn't unlocked/.test(hostedOut.at(-1)?.text ?? ''));

    // CRITICAL business-model repro: ONE hosted process serving MULTIPLE
    // tenants (guilds/rooms) must be able to unlock a premium pack for the
    // one that paid while it STAYS locked for another tenant in the exact
    // same process — this is the actual shape of a real hosted deployment
    // (one adapter connection serving many guilds), and is what makes
    // "sell a premium content pack" a coherent business model at all.
    const multiTenantConfig: Config = {
      ...config,
      monetization: { hosted: true, unlockedPackIds: [], tenantUnlockedPackIds: { 'cli:paid-guild': ['frontier-outpost'] } },
    };
    const mtOut: OutgoingMessage[] = [];
    const mtSend = async (m: OutgoingMessage) => void mtOut.push(m);
    const mtBot = new Bot(multiTenantConfig, provider, new MemoryStorage());
    const mtMsg = (t: string, ch: string): IncomingMessage => ({ platform: 'cli', channelId: ch, userId: 'u1', userName: 'Alice', text: t });
    await mtBot.handle(mtMsg('/dm new', 'paid-guild'), mtSend);
    await mtBot.handle(mtMsg('/dm pack list', 'paid-guild'), mtSend);
    check('content-packs: `/dm pack list` shows the pack unlocked for the ONE tenant it was unlocked for',
      !/\(locked\)/.test(mtOut.at(-1)?.text ?? ''));
    await mtBot.handle(mtMsg('/dm pack load frontier-outpost', 'paid-guild'), mtSend);
    check('content-packs: `/dm pack load` succeeds for the paying tenant, in a process that ALSO serves other (unpaid) tenants',
      /Loaded \*\*Frontier Outpost\*\*/.test(mtOut.at(-1)?.text ?? ''));

    await mtBot.handle(mtMsg('/dm new', 'unpaid-guild'), mtSend);
    await mtBot.handle(mtMsg('/dm pack list', 'unpaid-guild'), mtSend);
    check('content-packs: `/dm pack list` still flags the SAME pack "(locked)" for a DIFFERENT, unpaid tenant in the SAME process',
      /\(locked\)/.test(mtOut.at(-1)?.text ?? ''));
    await mtBot.handle(mtMsg('/dm pack load frontier-outpost', 'unpaid-guild'), mtSend);
    check('content-packs: `/dm pack load` still refuses the SAME premium pack for the unpaid tenant — one guild\'s purchase never unlocks it process-wide',
      /premium content pack and isn't unlocked/.test(mtOut.at(-1)?.text ?? ''));
  }

  });
  registerBilling(suite, ctx);
  suite.section("Portable engine: browser-safe card parsing (Uint8Array + DecompressionStream)", async () => {
  // ── Portable engine: browser-safe card parsing (Uint8Array + DecompressionStream) ──
  {
    // base64 helpers match node:Buffer exactly.
    const sample = new Uint8Array([0x00, 0x01, 0x02, 0x7f, 0x80, 0xff, 0x89, 0x50]);
    check('card-parse: bytesToBase64 matches Buffer.toString(base64)', bytesToBase64(sample) === Buffer.from(sample).toString('base64'));
    check('card-parse: base64ToBytes round-trips', Buffer.from(base64ToBytes(bytesToBase64(sample))).equals(Buffer.from(sample)));

    // JSON card via the browser (upload-only) entrypoint.
    const jsonCard = Buffer.from(JSON.stringify({ spec_version: '2.0', data: { name: 'Wisp', description: 'A browser-parsed spirit.' } }));
    const bc1 = await loadCardFromBytes(new Uint8Array(jsonCard));
    check('card-browser: parses an uploaded JSON card', bc1.name === 'Wisp' && bc1.description === 'A browser-parsed spirit.');

    // tEXt PNG card (no inflation needed) — keeps the embedded PNG as the portrait.
    const embB64 = Buffer.from(JSON.stringify({ spec_version: '2.0', data: { name: 'Glim' } })).toString('base64');
    const textPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', Buffer.alloc(13)),
      pngChunk('tEXt', Buffer.from(`chara\0${embB64}`, 'latin1')),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    const bc2 = await loadCardFromBytes(new Uint8Array(textPng));
    check('card-browser: parses a tEXt PNG card and keeps the embedded image portrait',
      bc2.name === 'Glim' && bc2.portrait?.kind === 'image' && bc2.portrait.mime === 'image/png' && (bc2.portrait.data?.length ?? 0) > 0);

    // zTXt PNG card — the browser inflate path runs over DecompressionStream (present in Node ≥18).
    const zB64 = Buffer.from(JSON.stringify({ spec_version: '2.0', data: { name: 'Zib' } })).toString('base64');
    const zPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', Buffer.alloc(13)),
      pngChunk('zTXt', Buffer.concat([Buffer.from('chara\0\0', 'latin1'), deflateSync(Buffer.from(zB64, 'latin1'))])),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    const bc3 = await loadCardFromBytes(new Uint8Array(zPng));
    check('card-browser: inflates a zTXt PNG card via DecompressionStream', bc3.name === 'Zib');

    // The zip-bomb cap holds on the browser inflate too.
    const bombPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', Buffer.alloc(13)),
      pngChunk('zTXt', Buffer.concat([Buffer.from('chara\0\0', 'latin1'), bomb])),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    let bombRejected = false;
    try { await loadCardFromBytes(new Uint8Array(bombPng)); } catch { bombRejected = true; }
    check('card-browser: a zTXt decompression bomb is rejected by the browser inflate cap', bombRejected);
  }

  });
  suite.section("Portable engine: browser SessionStorage round-trips a session", async () => {
  // ── Portable engine: browser SessionStorage round-trips a session ──
  {
    // A fake Web Storage (localStorage) backing the KV adapter.
    const backing = new Map<string, string>();
    const fakeStorage: WebStorageLike = {
      getItem: (k) => (backing.has(k) ? backing.get(k)! : null),
      setItem: (k, v) => void backing.set(k, v),
      removeItem: (k) => void backing.delete(k),
    };
    const kv: AsyncKeyValue = webStorageKeyValue(fakeStorage);
    const bStore = new BrowserSessionStorage(kv);
    const sess: GameSession = {
      id: 'b1', platform: 'web', channelId: 'r1', systemId: 'dnd5e', model: 'mock/free-model',
      players: { u1: { userId: 'u1', userName: 'Alice', characterName: 'Thorin', hp: 7, maxHp: 10 } },
      npcs: [], lorebook: [], history: [], summary: '', memories: [],
      turnMode: 'immediate', turnIndex: 0, fogOfWar: false, createdAt: 1,
    };
    await bStore.save('web:r1', sess);
    check('browser-storage: a session round-trips through the KV adapter (durable under localStorage)',
      [...backing.keys()].some((k) => k.includes('web:r1')) && backing.size === 1);
    const fresh = new BrowserSessionStorage(kv); // a fresh instance (empty cache) must reload from storage
    const loaded = await fresh.load('web:r1');
    check('browser-storage: load reconstructs the session from a cold cache',
      loaded?.players.u1?.characterName === 'Thorin' && loaded.players.u1?.hp === 7);
    await fresh.delete('web:r1');
    check('browser-storage: delete removes the record (and returns null after)', backing.size === 0 && (await new BrowserSessionStorage(kv).load('web:r1')) === null);

    // Legacy defaulting: a record written by an older build (missing post-v1
    // fields) still loads with sane defaults, like NodeFileStorage.
    backing.set('omnidm:session:web:old', JSON.stringify({ id: 'o', platform: 'web', channelId: 'old', systemId: 'dnd5e', model: 'm', players: {}, history: [], summary: '', createdAt: 1 }));
    const legacyB = await new BrowserSessionStorage(kv).load('web:old');
    check('browser-storage: a pre-feature record loads with defaulted turnMode/npcs/lorebook/fog/memories',
      legacyB?.turnMode === 'immediate' && legacyB.turnIndex === 0 && Array.isArray(legacyB.npcs) &&
      Array.isArray(legacyB.lorebook) && legacyB.fogOfWar === false && Array.isArray(legacyB.memories));

    // The full Bot pipeline runs unchanged on the browser storage.
    const bBot = new Bot(config, provider, new BrowserSessionStorage(webStorageKeyValue({
      getItem: (k) => (backing.has(k) ? backing.get(k)! : null),
      setItem: (k, v) => void backing.set(k, v),
      removeItem: (k) => void backing.delete(k),
    })));
    const bOut: OutgoingMessage[] = [];
    const bSend = async (m: OutgoingMessage) => void bOut.push(m);
    const bMsg = (t: string): IncomingMessage => ({ platform: 'cli', channelId: 'play', userId: 'u1', userName: 'Alice', text: t });
    await bBot.handle(bMsg('/dm new'), bSend);
    await bBot.handle(bMsg('/dm join Thorin'), bSend);
    bOut.length = 0;
    await bBot.handle(bMsg('I attack the goblin with my d20+5 sword'), bSend);
    check('browser-storage: a full turn (dice → narration) resolves against BrowserSessionStorage',
      bOut.at(-1)!.speaker === 'Dungeon Master' && /d20\+5/.test(provider.lastPrompt));
  }

  });
  suite.section("Portable engine: environment-neutral provider factory", async () => {
  // ── Portable engine: environment-neutral provider factory ──
  {
    check('factory: anthropic provider from LLM_PROVIDER=anthropic',
      buildProvider({ provider: 'anthropic', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'x' }).id === 'anthropic');
    check('factory: anthropic provider from an anthropic.com base URL',
      buildProvider({ baseUrl: 'https://api.anthropic.com', apiKey: 'x' }).id === 'anthropic');
    check('factory: OpenAI-compatible provider otherwise',
      buildProvider({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'x' }).id === 'openai-compatible');
    check('factory: allowBrowser flag is accepted (in-app engine builds a client-side provider)',
      buildProvider({ baseUrl: 'http://mock', apiKey: 'x', allowBrowser: true }).id === 'openai-compatible');
  }

  });
  suite.section("Portable engine: RoomEngine drives a full flow with NO node:http/ws/fs", async () => {
  // ── Portable engine: RoomEngine drives a full flow with NO node:http/ws/fs ──
  {
    /** An in-process connection collecting frames — the transport-agnostic seam. */
    class FakeConn implements RoomConnection {
      readonly all: RoomFrame[] = [];
      private pending: RoomFrame[] = [];
      private waiter?: { pred: (f: RoomFrame) => boolean; resolve: (f: RoomFrame | undefined) => void };
      send(frame: RoomFrame): void {
        const f = JSON.parse(JSON.stringify(frame)) as RoomFrame; // snapshot (engine reuses frame objects)
        this.all.push(f);
        if (this.waiter?.pred(f)) { const w = this.waiter; this.waiter = undefined; w.resolve(f); }
        else this.pending.push(f);
      }
      close(): void {}
      next(pred: (f: RoomFrame) => boolean, timeoutMs = 2000): Promise<RoomFrame | undefined> {
        const i = this.pending.findIndex(pred);
        if (i !== -1) return Promise.resolve(this.pending.splice(i, 1)[0]);
        return new Promise((resolve) => {
          const timer = setTimeout(() => { this.waiter = undefined; resolve(undefined); }, timeoutMs);
          this.waiter = { pred, resolve: (f) => { clearTimeout(timer); resolve(f); } };
        });
      }
      sawText(t: string): boolean { return this.all.some((f) => typeof f.text === 'string' && (f.text as string).includes(t)); }
    }
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    type RUser = { userId: string; userName: string; characterName?: string; portrait?: { kind?: string; id?: string; url?: string } | null };
    type STok = { id: string; who: string; kind: string; x: number; y: number };

    const reStorage = new MemoryStorage();
    const reBot = new Bot(config, provider, reStorage);
    const engine = new RoomEngine({ storage: reStorage, platform: 'web' });
    engine.setHandler((m) => reBot.handle(m, async (o) => engine.emit(o)));

    const ca = new FakeConn();
    const cb = new FakeConn();
    engine.handleFrame(ca, { type: 'hello', userName: 'Alice', channelId: 'r1' });
    const welA = await ca.next((f) => f.type === 'welcome');
    check('room-engine: hello is answered with a welcome carrying a userId and per-seat upload token',
      typeof welA?.userId === 'string' && String(welA.userId).startsWith('web-') && typeof welA.uploadToken === 'string' && (welA.uploadToken as string).length >= 12);
    const aId = welA!.userId as string;
    const aTok = welA!.uploadToken as string;
    await ca.next((f) => f.type === 'roster');
    engine.handleFrame(cb, { type: 'hello', userName: 'Bob', channelId: 'r1' });
    await cb.next((f) => f.type === 'welcome');
    const roster2 = await ca.next((f) => f.type === 'roster' && (f.users as RUser[]).length === 2);
    check('room-engine: a join broadcasts the enriched roster to the room',
      (roster2!.users as RUser[]).map((u) => u.userName).join(',') === 'Alice,Bob');

    engine.handleFrame(ca, { type: 'say', text: '/dm new' });
    check('room-engine: bot reply broadcasts to every connection in the room',
      Boolean(await ca.next((f) => f.type === 'msg' && String(f.text).includes('new campaign'))) &&
      Boolean(await cb.next((f) => f.type === 'msg' && String(f.text).includes('new campaign'))));
    check('room-engine: player lines are relayed to the room', cb.sawText('/dm new'));

    engine.handleFrame(ca, { type: 'say', text: '/dm join Thorin' });
    await ca.next((f) => f.type === 'msg' && String(f.text).includes('Thorin joins'));
    engine.handleFrame(cb, { type: 'say', text: '/dm join Elaria' });
    await cb.next((f) => f.type === 'msg' && String(f.text).includes('Elaria joins'));

    // Scene: one pc token per party member, seeded inside 0..1 with a stable id.
    const partyScene = await ca.next((f) => f.type === 'scene' && (f.tokens as STok[]).filter((t) => t.kind === 'pc').length === 2);
    const pcs = (partyScene!.tokens as STok[]).filter((t) => t.kind === 'pc');
    check('room-engine: the scene carries a pc token per party member, seeded inside 0..1 with stable ids',
      pcs.length === 2 && pcs.some((t) => t.who === 'Thorin') && pcs.some((t) => t.id === `pc:${aId}`) &&
      pcs.every((t) => t.x >= 0 && t.x <= 1 && t.y >= 0 && t.y <= 1));

    // Portrait: /dm portrait enriches the roster with a preset descriptor.
    engine.handleFrame(ca, { type: 'say', text: '/dm portrait ranger' });
    const presetRoster = await ca.next((f) => f.type === 'roster' && (f.users as RUser[]).some((u) => u.userName === 'Alice' && u.portrait?.kind === 'preset'));
    const aliceSeat = (presetRoster!.users as RUser[]).find((u) => u.userName === 'Alice');
    check('room-engine: the enriched roster carries the character name and a preset portrait descriptor',
      aliceSeat?.characterName === 'Thorin' && aliceSeat?.portrait?.kind === 'preset' && aliceSeat?.portrait?.id === 'ranger');

    // Roll: a structured roll frame + a board pop (scene lastRoll + rollSeq), plus the msg narration.
    engine.handleFrame(ca, { type: 'say', text: '/dm roll d20+5' });
    const rollFrame = await ca.next((f) => f.type === 'roll');
    const rDice = rollFrame?.dice as number[] | undefined;
    check('room-engine: /dm roll emits a self-consistent roll frame (notation, actor, dice+modifier)',
      rollFrame?.notation === 'd20+5' && rollFrame?.actor === 'Thorin' &&
      Array.isArray(rDice) && rDice.length === 1 && (rollFrame!.total as number) === rDice[0] + ((rollFrame!.modifier as number) ?? 0));
    const rollScene = await ca.next((f) => f.type === 'scene' && Boolean(f.lastRoll) && Number.isFinite(f.rollSeq));
    check('room-engine: a roll stashes onto the scene with a numeric rollSeq for the board pop',
      (rollScene!.lastRoll as { notation?: string })?.notation === 'd20+5' && (rollScene!.rollSeq as number) >= 1);
    const rollTotal = rollFrame!.total as number;
    const reRoom = await reStorage.load('web:r1');
    check('room-engine: the roll frame total matches the persisted engine roll (no re-roll)',
      reRoom?.history.at(-1)?.rolls[0]?.total === rollTotal && reRoom?.history.at(-1)?.rolls[0]?.notation === 'd20+5');
    check('room-engine: the roll also produced a normal DM narration frame (transcript intact)',
      Boolean(await ca.next((f) => f.type === 'msg' && f.speaker === 'Dungeon Master')));

    // Portrait bytes: the engine owns the session read/write; the transport only serves them.
    const okSet = await engine.setPortrait('r1', aId, 'image/png', bytesToBase64(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])));
    const gotImg = await engine.resolvePortraitImage('r1', aId);
    check('room-engine: setPortrait stores an image and resolvePortraitImage returns it as {mime,base64}',
      okSet === 'ok' && gotImg?.mime === 'image/png' && (gotImg?.data.length ?? 0) > 0);
    check('room-engine: an upload token authorizes only its own seat',
      engine.seatForUpload(aTok, 'r1', aId) === true && engine.seatForUpload(aTok, 'r1', 'web-someone-else') === false && engine.seatForUpload('bogus', 'r1', aId) === false);
    check('room-engine: setPortrait on an unseated user is refused (no session presence)',
      (await engine.setPortrait('r1', 'web-nobody', 'image/png', 'AAAA')) === 'no-player');

    // Fog routing: a private section reaches only its target's connection.
    await sleep(1100); // drain Alice's say rate-limit window
    engine.handleFrame(ca, { type: 'say', text: '/dm fog on' });
    await ca.next((f) => f.type === 'msg' && String(f.text).includes('Fog of war ON'));
    provider.narration = 'The corridor forks. [PRIVATE:Elaria]A pressure plate glints under your boot.[/PRIVATE] Torches gutter.';
    await sleep(1100);
    engine.handleFrame(ca, { type: 'say', text: 'I lead the way' });
    const pubBoth = await cb.next((f) => f.type === 'msg' && String(f.text).includes('corridor forks'));
    const whisper = await cb.next((f) => f.type === 'msg' && f.private === true);
    check('room-engine: fog routes the private section only to its target, flagged private',
      Boolean(pubBoth) && Boolean(whisper?.text) && String(whisper!.text).includes('pressure plate') && !ca.sawText('pressure plate'));
    provider.narration = 'The tavern falls silent as you act. (mock narration)';

    // A dropped connection leaves the roster.
    engine.dropConnection(cb);
    const shrunk = await ca.next((f) => f.type === 'roster' && (f.users as RUser[]).length === 1);
    check('room-engine: dropping a connection leaves the roster', (shrunk!.users as RUser[])[0]?.userName === 'Alice');
  }

  });
  suite.section("In-app engine: createLocalEngine (the LocalTransport's composition root)", async () => {
  // ── In-app engine: createLocalEngine (the LocalTransport's composition root) ──
  // The browser LocalTransport wraps EXACTLY this: createLocalEngine wires a Bot +
  // RoomEngine + SessionStorage + provider in one process. Injecting a mock
  // provider + MemoryStorage lets the whole in-app path run under Node offline —
  // a full solo turn (new → join → action → DM narration) driven through the same
  // protocol frames the browser sends, with the session persisted to storage.
  {
    class Collector implements RoomConnection {
      readonly all: RoomFrame[] = [];
      send(frame: RoomFrame): void { this.all.push(JSON.parse(JSON.stringify(frame)) as RoomFrame); }
      close(): void {}
      last(pred: (f: RoomFrame) => boolean): RoomFrame | undefined { return [...this.all].reverse().find(pred); }
    }
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const localStore = new MemoryStorage();
    const localMock = new MockProvider();
    localMock.narration = 'A hush falls over the in-app table as your blow lands. (mock narration)';
    // No browser globals touched: storage + provider are injected (as in the smoke),
    // exactly the seam the headless "Play on this device" run uses in chromium.
    const engine = createLocalEngine({ provider: localMock, storage: localStore, llm: { model: 'mock/free-model' } });
    check('local-engine: createLocalEngine returns a live RoomEngine + storage without a browser',
      engine.room instanceof RoomEngine && engine.storage === localStore && typeof engine.setPortrait === 'function');

    const conn = new Collector();
    engine.room.handleFrame(conn, { type: 'hello', userName: 'Solo', channelId: 'solo1' });
    await sleep(20);
    const welcome = conn.last((f) => f.type === 'welcome');
    const soloId = welcome?.userId as string;
    check('local-engine: hello mints a seat and welcomes it (in-process, no socket)',
      typeof soloId === 'string' && soloId.startsWith('web-'));

    engine.room.handleFrame(conn, { type: 'say', text: '/dm new' });
    await sleep(20);
    engine.room.handleFrame(conn, { type: 'say', text: '/dm join Kaelen' });
    await sleep(20);
    check('local-engine: a solo player joins the in-app party (roster enriched)',
      Boolean(conn.last((f) => f.type === 'roster' && (f.users as { characterName?: string }[]).some((u) => u.characterName === 'Kaelen'))));

    engine.room.handleFrame(conn, { type: 'say', text: 'I strike the training dummy with my d20+4 blade' });
    await sleep(40);
    const dmFrame = conn.last((f) => f.type === 'msg' && f.speaker === 'Dungeon Master');
    check('local-engine: a full turn runs end-to-end in-app — DM narration frame is produced',
      Boolean(dmFrame) && String(dmFrame!.text).includes('in-app table'));
    const rollFrame = conn.last((f) => f.type === 'roll');
    check('local-engine: the resolved roll rides the turn (d20+4, deterministic — no re-roll)',
      rollFrame?.notation === 'd20+4' && rollFrame?.actor === 'Kaelen');
    check('local-engine: the resolved dice reached the DM prompt (the engine, not the client, resolved them)',
      /RESOLVED ROLLS/.test(localMock.lastPrompt) && /d20\+4/.test(localMock.lastPrompt));

    // The in-app game persisted to the injected (browser-shaped) storage.
    const persisted = await localStore.load('web:solo1');
    check('local-engine: the in-app session persisted through the storage seam',
      persisted?.players?.[soloId]?.characterName === 'Kaelen' && (persisted?.history.length ?? 0) === 1);

    // In-app portrait upload path: bytes stored in-process + a data: URL cached so
    // the roster's image descriptor resolves with no HTTP /portrait endpoint.
    const setRes = await engine.setPortrait('solo1', soloId, 'image/png', bytesToBase64(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9])));
    await sleep(20);
    const imgRoster = conn.last((f) => f.type === 'roster' && (f.users as { userId: string; portrait?: { kind?: string; url?: string } }[]).some((u) => u.userId === soloId && u.portrait?.kind === 'image'));
    const imgSeat = imgRoster && (imgRoster.users as { userId: string; portrait?: { kind?: string; url?: string } }[]).find((u) => u.userId === soloId);
    check('local-engine: an in-app portrait upload resolves to a same-page data: URL (no HTTP endpoint)',
      setRes === 'ok' && imgSeat?.portrait?.kind === 'image' && String(imgSeat?.portrait?.url).startsWith('data:image/png;base64,'));

    // In-app card import is upload-only — a `/dm import <url>` fails clearly.
    engine.room.handleFrame(conn, { type: 'say', text: '/dm import https://example.com/card.png' });
    await sleep(30);
    check('local-engine: in-app `/dm import <url>` is refused (upload-only, no browser SSRF surface)',
      Boolean(conn.last((f) => f.type === 'msg' && /Could not import|unavailable in-app|upload/i.test(String(f.text)))));
  }

  });
  suite.section("Desktop shell: the Tauri v2 scaffold wraps web/ in a native WebView", async () => {
  // ── Desktop shell: the Tauri v2 scaffold wraps web/ in a native WebView ──────
  // No Node sidecar — the engine runs in-WebView (the hybrid model), so this only
  // asserts the scaffold is present and correctly wired: valid config JSON that
  // points frontendDist at the committed web client, a same-origin CSP that keeps
  // script-src 'self' (no XSS opening) while allowing the user-configured LLM
  // endpoint via connect-src, and the Rust/build files a proper toolchain needs.
  {
    const tauriDir = 'src-tauri';
    const confRaw = await fs.readFile(path.join(tauriDir, 'tauri.conf.json'), 'utf8');
    let conf: {
      identifier?: string;
      build?: { frontendDist?: string };
      app?: { security?: { csp?: string }; windows?: { title?: string }[] };
      bundle?: { icon?: string[] };
    } = {};
    let confValid = true;
    try { conf = JSON.parse(confRaw); } catch { confValid = false; }
    staticCheck('tauri: tauri.conf.json is valid JSON', confValid);
    staticCheck('tauri: app identifier is com.omnidm.app', conf.identifier === 'com.omnidm.app');
    staticCheck('tauri: frontendDist points at the committed web client (../web)', conf.build?.frontendDist === '../web');

    // The referenced frontend dir + its entry HTML actually exist.
    const distRel = conf.build?.frontendDist ?? '';
    const webIndex = path.join(tauriDir, distRel, 'index.html');
    staticCheck('tauri: the frontendDist directory resolves to web/index.html on disk',
      await fs.access(webIndex).then(() => true, () => false));

    const csp = conf.app?.security?.csp ?? '';
    staticCheck('tauri: CSP keeps script-src \'self\' (no inline/injected script — XSS stays shut)',
      /script-src\s+'self'/.test(csp) && !/script-src[^;]*'unsafe-inline'/.test(csp));
    staticCheck('tauri: CSP allows the user-configured LLM endpoint via connect-src (https + loopback)',
      /connect-src[^;]*\bhttps:/.test(csp) && /connect-src[^;]*127\.0\.0\.1/.test(csp));
    staticCheck('tauri: CSP bakes in NO external origin (only schemes/loopback are allowed)',
      !/(?:script|default|img|style)-src[^;]*https?:\/\//.test(csp));
    staticCheck('tauri: a native window carries the app title', Boolean(conf.app?.windows?.[0]?.title));

    // The Rust + capability + icon files a real build consumes are all present.
    const need = [
      'Cargo.toml', 'build.rs', 'src/main.rs', 'src/lib.rs',
      'capabilities/default.json',
      'icons/32x32.png', 'icons/128x128.png', 'icons/icon.ico', 'icons/icon.icns',
    ];
    const present = await Promise.all(need.map((f) => fs.access(path.join(tauriDir, f)).then(() => true, () => false)));
    staticCheck('tauri: the Rust/build/capability/icon scaffold files all exist', present.every(Boolean));

    // Every bundle-referenced icon exists on disk (a real build fails otherwise).
    const icons = conf.bundle?.icon ?? [];
    const iconsPresent = await Promise.all(icons.map((f) => fs.access(path.join(tauriDir, f)).then(() => true, () => false)));
    staticCheck('tauri: every icon listed in bundle.icon exists', icons.length > 0 && iconsPresent.every(Boolean));

    // The capability grants only Tauri core defaults — no fs/shell/http reach.
    const capRaw = await fs.readFile(path.join(tauriDir, 'capabilities/default.json'), 'utf8');
    const cap = JSON.parse(capRaw) as { permissions?: string[] };
    staticCheck('tauri: capability grants only core defaults (no fs/shell/http permission)',
      Array.isArray(cap.permissions) && cap.permissions.includes('core:default') &&
      !cap.permissions.some((p) => /^(fs|shell|http):/.test(p)));

    // The npm scripts a developer runs are wired at the repo root.
    const pkg = JSON.parse(await fs.readFile('package.json', 'utf8')) as { scripts?: Record<string, string>; devDependencies?: Record<string, string> };
    staticCheck('tauri: package.json exposes tauri:dev / tauri:build scripts + the CLI devDependency',
      Boolean(pkg.scripts?.['tauri:dev']) && Boolean(pkg.scripts?.['tauri:build']) && Boolean(pkg.devDependencies?.['@tauri-apps/cli']));
  }

  });
  registerRules(suite, ctx);
  registerSpellsInventory(suite, ctx);
  suite.section("Desktop shell: the Electron target bundles Chromium (builds w/o system webkit)", async () => {
  // ── Desktop shell: the Electron target bundles Chromium (builds w/o system webkit) ──
  // The pragmatic desktop path: unlike the Tauri scaffold this ships its own
  // Chromium, so it builds/runs without root or system WebKit. Same hybrid model
  // (no Node sidecar, no preload bridge — the engine runs in the renderer exactly
  // as in a browser tab). These are static assertions over the committed main
  // process + packaging config; Electron itself is never launched here.
  {
    const mainRaw = await fs.readFile('electron/main.cjs', 'utf8');
    // Every window is hardened per the Electron security checklist.
    staticCheck('electron: renderer runs with contextIsolation:true (page JS isolated from Electron internals)',
      /contextIsolation:\s*true/.test(mainRaw) && !/contextIsolation:\s*false/.test(mainRaw));
    staticCheck('electron: nodeIntegration:false (no require/Node globals reachable from the untrusted page)',
      /nodeIntegration:\s*false/.test(mainRaw) && !/nodeIntegration:\s*true/.test(mainRaw));
    staticCheck('electron: sandbox:true (renderer runs in Chromium\'s OS sandbox like a real tab)',
      /sandbox:\s*true/.test(mainRaw) && !/sandbox:\s*false/.test(mainRaw));
    staticCheck('electron: no preload bridge is exposed to the page (nothing on window.* to call into)',
      !/preload:\s*(['"`]|path\.)/.test(mainRaw));
    staticCheck('electron: webSecurity is never disabled + insecure content is refused',
      !/webSecurity:\s*false/.test(mainRaw) && !/allowRunningInsecureContent:\s*true/.test(mainRaw));
    staticCheck('electron: only a local file is loaded — no remote URL ever reaches loadURL/loadFile',
      /loadFile\(/.test(mainRaw) && !/loadURL\(\s*['"`]https?:/.test(mainRaw));
    staticCheck('electron: external links/navigations are handed to shell.openExternal, not loaded in-app',
      /setWindowOpenHandler/.test(mainRaw) && /will-navigate/.test(mainRaw) && /shell\.openExternal/.test(mainRaw) &&
      /action:\s*'deny'/.test(mainRaw));
    staticCheck('electron: untrusted content cannot be granted device permissions',
      /setPermissionRequestHandler/.test(mainRaw) && /callback\(false\)/.test(mainRaw));
    // shell.openExternal is only ever reached through a scheme allowlist — a
    // file:/smb:/custom-protocol external "link" (rendered LLM output, a
    // hostile character card) must never launch a local app or reach a share.
    staticCheck('electron: shell.openExternal is gated by an http(s)/mailto scheme allowlist (file:/smb:/custom schemes refused)',
      /SAFE_EXTERNAL_SCHEMES\s*=\s*new Set\(\[[^\]]*'http:'[^\]]*'https:'[^\]]*'mailto:'[^\]]*\]\)/.test(mainRaw) &&
      /function openExternalIfSafe/.test(mainRaw) &&
      /if\s*\(!SAFE_EXTERNAL_SCHEMES\.has\(scheme\)\)/.test(mainRaw) &&
      // Every call site routes through the allowlisted wrapper, not a bare shell.openExternal.
      (mainRaw.match(/void shell\.openExternal\(url\)/g) || []).length === 1 &&
      /will-navigate'[\s\S]{0,200}openExternalIfSafe\(url\)/.test(mainRaw) &&
      /setWindowOpenHandler[\s\S]{0,200}openExternalIfSafe\(url\)/.test(mainRaw));

    // The packaging config a real `npm run electron:build` consumes is coherent.
    const ePkg = JSON.parse(await fs.readFile('package.json', 'utf8')) as {
      main?: string;
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
      build?: {
        appId?: string; productName?: string; files?: string[];
        linux?: { target?: string[]; icon?: string };
        win?: { target?: string[]; icon?: string };
        mac?: { target?: string[]; icon?: string };
      };
    };
    staticCheck('electron: package.json main + electron/electron:build scripts + the electron/electron-builder devDeps',
      ePkg.main === 'electron/main.cjs' &&
      Boolean(ePkg.scripts?.['electron']) && Boolean(ePkg.scripts?.['electron:build']) &&
      Boolean(ePkg.devDependencies?.['electron']) && Boolean(ePkg.devDependencies?.['electron-builder']));
    staticCheck('electron: builder appId is com.omnidm.app and productName is OmniDM',
      ePkg.build?.appId === 'com.omnidm.app' && ePkg.build?.productName === 'OmniDM');
    staticCheck('electron: builder bundles the web client + engine bundle (files globs cover electron/ + web/)',
      Array.isArray(ePkg.build?.files) &&
      ePkg.build!.files!.some((g) => /^web\//.test(g)) && ePkg.build!.files!.some((g) => /^electron\//.test(g)));
    staticCheck('electron: Linux AppImage + Windows nsis + macOS dmg targets are all configured',
      (ePkg.build?.linux?.target ?? []).includes('AppImage') &&
      (ePkg.build?.win?.target ?? []).includes('nsis') &&
      (ePkg.build?.mac?.target ?? []).includes('dmg'));
    // Every icon the builder references exists on disk (a real build fails otherwise).
    const eIcons = [ePkg.build?.linux?.icon, ePkg.build?.win?.icon, ePkg.build?.mac?.icon].filter(Boolean) as string[];
    const eIconsPresent = await Promise.all(eIcons.map((f) => fs.access(f).then(() => true, () => false)));
    staticCheck('electron: every builder-referenced icon exists on disk', eIcons.length > 0 && eIconsPresent.every(Boolean));
    // The window actually loads the committed web client on disk.
    staticCheck('electron: main.cjs targets web/index.html and it exists on disk',
      /web['"`],\s*['"`]index\.html/.test(mainRaw) &&
      await fs.access(path.join('web', 'index.html')).then(() => true, () => false));
    // will-navigate is registered exactly once (a per-window + a module-level
    // handler would double every external-link openExternal call).
    staticCheck('electron: the will-navigate guard is registered exactly once (no doubled openExternal)',
      (mainRaw.match(/\.on\('will-navigate'/g) || []).length === 1 &&
      !/win\.webContents\.on\('will-navigate'/.test(mainRaw));
    // Running the Electron entry under plain Node fails with a clear message.
    staticCheck('electron: main.cjs guards against `node .` (clear message, not a cryptic TypeError)',
      /typeof app\.setName !== 'function'/.test(mainRaw) && /process\.exit\(1\)/.test(mainRaw));
    // The offline renderer check the README points at actually exists.
    staticCheck('electron: the documented offline renderer check (electron/webview-check.mjs) exists',
      await fs.access(path.join('electron', 'webview-check.mjs')).then(() => true, () => false));
    // README documents the packaging command that now exists (no stale "out of scope" claim).
    const readme = await fs.readFile('README.md', 'utf8');
    staticCheck('electron: README documents `npm run electron:build` and no longer claims packaging is unconfigured',
      /npm run electron:build/.test(readme) && !/add\s+`electron-builder`\s+and configure/.test(readme));
  }

  });
  suite.section("Secret redaction: provider error bodies must never carry a key to players", async () => {
  // ── Secret redaction: provider error bodies must never carry a key to players ──
  // A misconfigured OpenAI-compatible gateway can echo the submitted key in its
  // 401 body, and the turn-failure notice is broadcast to every seat in server
  // mode — so bot.ts scrubs key-shaped values before logging OR sending.
  {
    const leaky = 'Incorrect API key provided: sk-proj-ABCDEF0123456789abcdef0123456789XYZ. You can find your key at platform.example.com.';
    const scrubbed = redactSecrets(leaky);
    check('redact: an OpenAI-style "Incorrect API key: sk-…" body is scrubbed of the key',
      !scrubbed.includes('sk-proj-ABCDEF0123456789abcdef0123456789XYZ') && /…redacted/.test(scrubbed));
    check('redact: a Bearer token is scrubbed', !redactSecrets('Authorization: Bearer abcdef0123456789ABCDEF').includes('abcdef0123456789ABCDEF'));
    check('redact: an x-api-key header value is scrubbed', !redactSecrets('x-api-key: sk-verysecretvalue123456').includes('verysecretvalue'));
    check('redact: a long opaque token is scrubbed', !redactSecrets('token=0123456789abcdef0123456789abcdef0123').includes('0123456789abcdef0123456789abcdef0123'));
    // Ordinary human-readable error text (and model ids) survive unredacted.
    check('redact: a plain human error message is left intact',
      redactSecrets('The model endpoint is unreachable (connection refused).') === 'The model endpoint is unreachable (connection refused).');
    check('redact: a slash/colon model id is not mangled',
      redactSecrets('Unknown model: meta-llama/llama-3.3-70b-instruct:free').includes('meta-llama/llama-3.3-70b-instruct:free'));
  }

  });
  suite.section("Server vs local turn-failure notices: allowlist, not a blocklist", async () => {
  // ── Server vs local turn-failure notices: allowlist, not a blocklist ───────
  // Server mode fans a failure out to EVERY seat, most of whom aren't the
  // operator — it must get the generic, allowlisted notice, never the
  // provider's own error text (redaction is only a backstop for the server
  // log, not a gate on what's broadcast). Local mode's failure never leaves
  // the player's own device, so it keeps the detailed-but-scrubbed message.
  {
    class RejectingProvider implements LLMProvider {
      readonly id = 'reject';
      async listModels(): Promise<ModelInfo[]> { return []; }
      async complete(): Promise<string> {
        throw new Error('Incorrect API key provided: sk-proj-LEAKEDKEYVALUE0123456789ABCDEF. Contact support.');
      }
    }
    const rejProvider = new RejectingProvider();

    const srvBot = new Bot(config, rejProvider, new MemoryStorage()); // 'server' is the default
    const srvOut: OutgoingMessage[] = [];
    const srvMsg = (t: string): IncomingMessage => ({ platform: 'cli', channelId: 'failsrv', userId: 'u1', userName: 'Alice', text: t });
    await srvBot.handle(srvMsg('/dm new'), async (m) => void srvOut.push(m));
    await srvBot.handle(srvMsg('/dm join Thorin'), async (m) => void srvOut.push(m));
    srvOut.length = 0;
    await srvBot.handle(srvMsg('I search the room'), async (m) => void srvOut.push(m));
    check('bot: server-mode (default) turn failure broadcasts the exact generic allowlisted notice, never the provider body',
      srvOut.some((m) => m.text === SERVER_TURN_FAILURE_TEXT) &&
      !srvOut.some((m) => m.text.includes('LEAKEDKEYVALUE') || m.text.includes('Contact support')));

    const localBot = new Bot(config, rejProvider, new MemoryStorage(), undefined, 'local');
    const localOut: OutgoingMessage[] = [];
    const localMsg = (t: string): IncomingMessage => ({ platform: 'cli', channelId: 'faillocal', userId: 'u1', userName: 'Alice', text: t });
    await localBot.handle(localMsg('/dm new'), async (m) => void localOut.push(m));
    await localBot.handle(localMsg('/dm join Thorin'), async (m) => void localOut.push(m));
    localOut.length = 0;
    await localBot.handle(localMsg('I search the room'), async (m) => void localOut.push(m));
    const localNotice = localOut.find((m) => m.text.startsWith('⚠️ The DM stumbled'));
    check('bot: local-mode turn failure keeps a detailed, actionable, SCRUBBED message that never leaves the device (not the generic server notice)',
      Boolean(localNotice) && !localNotice!.text.includes('LEAKEDKEYVALUE') && /…redacted/.test(localNotice!.text) &&
      !localOut.some((m) => m.text === SERVER_TURN_FAILURE_TEXT));
  }

  });
  suite.section("Mobile shell: the Capacitor (iOS + Android) scaffold wraps web/", async () => {
  // ── Mobile shell: the Capacitor (iOS + Android) scaffold wraps web/ ─────────
  // Same hybrid model as Tauri: a native WebView loads the committed web client
  // and runs the engine in-WebView. Two things are asserted here: (1) the
  // capacitor.config.ts is present and points webDir at the real web client with
  // the native-HTTP plugin enabled; (2) the in-app provider's transport selection
  // — on a SIMULATED Capacitor native platform it routes through CapacitorHttp
  // (no CORS), and in a plain browser/Node it falls back to the default fetch.
  {
    // (1) Config points at the committed web client, with CapacitorHttp enabled.
    const capConfRaw = await fs.readFile('capacitor.config.ts', 'utf8');
    staticCheck('capacitor: appId is com.omnidm.app and appName is OmniDM',
      /appId:\s*'com\.omnidm\.app'/.test(capConfRaw) && /appName:\s*'OmniDM'/.test(capConfRaw));
    const webDirMatch = capConfRaw.match(/webDir:\s*'([^']+)'/);
    staticCheck('capacitor: webDir points at the committed web client',
      Boolean(webDirMatch) && webDirMatch![1] === 'web');
    staticCheck('capacitor: the webDir resolves to web/index.html + the engine bundle on disk',
      webDirMatch != null &&
      await fs.access(path.join(webDirMatch[1], 'index.html')).then(() => true, () => false) &&
      await fs.access(path.join(webDirMatch[1], 'engine.bundle.js')).then(() => true, () => false));
    staticCheck('capacitor: CapacitorHttp plugin is enabled (native LLM transport, CORS bypass)',
      /CapacitorHttp:\s*\{[^}]*enabled:\s*true/.test(capConfRaw));
    const capPkg = JSON.parse(await fs.readFile('package.json', 'utf8')) as { scripts?: Record<string, string>; devDependencies?: Record<string, string> };
    staticCheck('capacitor: package.json exposes cap:sync / cap:android / cap:ios + the @capacitor devDeps',
      Boolean(capPkg.scripts?.['cap:sync']) && Boolean(capPkg.scripts?.['cap:android']) && Boolean(capPkg.scripts?.['cap:ios']) &&
      Boolean(capPkg.devDependencies?.['@capacitor/core']) && Boolean(capPkg.devDependencies?.['@capacitor/cli']) &&
      Boolean(capPkg.devDependencies?.['@capacitor/android']) && Boolean(capPkg.devDependencies?.['@capacitor/ios']));

    // (2a) Feature detection — Node is NOT a native platform, so the providers
    // keep their default fetch (selectFetch returns undefined, changing nothing).
    staticCheck('capacitor: plain Node/browser is not detected as native → default fetch kept',
      isCapacitorNative(globalThis) === false && selectFetch(globalThis) === undefined);

    // (2b) A SIMULATED Capacitor native WebView: a fake global with a native-flag
    // and a CapacitorHttp stub that records the request and returns a canned body.
    const nativeCalls: Array<{ url: string; method?: string; data?: unknown; headers?: Record<string, string> }> = [];
    const fakeHttp: CapacitorHttpLike = {
      async request(o) {
        nativeCalls.push(o);
        if (o.url.endsWith('/v1/messages')) {
          return { status: 200, data: JSON.stringify({ content: [{ type: 'text', text: 'native narration' }] }), headers: { 'content-type': 'application/json' } };
        }
        return { status: 404, data: 'nope', headers: {} as Record<string, string> };
      },
    };
    const nativeGlobal = {
      Capacitor: { isNativePlatform: () => true, Plugins: { CapacitorHttp: fakeHttp } },
      Response,
    } as unknown as typeof globalThis;

    staticCheck('capacitor: a native WebView is detected and exposes CapacitorHttp',
      isCapacitorNative(nativeGlobal) === true && getCapacitorHttp(nativeGlobal) === fakeHttp);
    const nativeFetch = selectFetch(nativeGlobal);
    staticCheck('capacitor: selectFetch returns a native-backed fetch on a native platform',
      typeof nativeFetch === 'function');

    // makeNativeFetch maps a request→native call→a real Response the SDK can read.
    const nf = makeNativeFetch(fakeHttp, Response);
    const okRes = await nf('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [] }),
    });
    const okJson = (await okRes.json()) as { content?: { text?: string }[] };
    staticCheck('capacitor: makeNativeFetch returns a Response with the native status + JSON body',
      okRes.ok && okRes.status === 200 && okJson.content?.[0]?.text === 'native narration');
    const lastCall = nativeCalls.at(-1)!;
    staticCheck('capacitor: a JSON body string is reparsed to an object so CapacitorHttp serializes it once',
      typeof lastCall.data === 'object' && (lastCall.data as { model?: string }).model === 'claude-opus-4-8');
    const missRes = await nf('https://api.anthropic.com/nope', { method: 'GET' });
    staticCheck('capacitor: a native error status surfaces as a non-ok Response (no silent success)',
      missRes.ok === false && missRes.status === 404);

    // (2c) End-to-end through the provider: buildProvider hands the native fetch to
    // the AnthropicProvider, whose complete() must go through CapacitorHttp — and
    // the user's secret key rides only in the request headers to the endpoint.
    nativeCalls.length = 0;
    const nativeProvider = buildProvider({
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-native-secret',
      fetchImpl: selectFetch(nativeGlobal),
    });
    const narration = await nativeProvider.complete({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'hi' }] });
    const provCall = nativeCalls.at(-1);
    staticCheck('capacitor: the provider routes its LLM call through the native HTTP path on device',
      narration === 'native narration' && provCall?.url === 'https://api.anthropic.com/v1/messages' && provCall?.method === 'POST');
    staticCheck('capacitor: the user API key is sent only in the request headers to the configured endpoint',
      (provCall?.headers?.['x-api-key']) === 'sk-native-secret');
  }

  });
}
