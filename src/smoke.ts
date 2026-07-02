/**
 * Smoke test — drives the full bot pipeline with a mock provider (no network,
 * no API key). Proves: command routing, multiplayer join, deterministic dice,
 * turn pipeline, narration wiring, character-card import, and disk persistence.
 *
 * Run:  npx tsx src/smoke.ts
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import type { CompletionRequest, IncomingMessage, LLMProvider, ModelInfo, OutgoingMessage } from './core/types.js';
import { Bot } from './core/bot.js';
import { roll, extractRolls } from './core/engine/dice.js';
import { SessionStore } from './core/session/store.js';
import { renderCard } from './core/cards/card.js';

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
}

// A provider that needs no network. Echoes what it was asked to narrate so we
// can assert the resolved rolls reached the prompt.
class MockProvider implements LLMProvider {
  readonly id = 'mock';
  lastPrompt = '';
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: 'mock/free-model', free: true }];
  }
  async complete(req: CompletionRequest): Promise<string> {
    this.lastPrompt = req.messages.map((m) => m.content).join('\n');
    return 'The tavern falls silent as you act. (mock narration)';
  }
}

async function main() {
  const dataDir = path.join('data', 'smoke');
  await fs.rm(dataDir, { recursive: true, force: true });

  const config: Config = {
    llm: { baseUrl: 'http://mock', apiKey: 'x', model: 'mock/free-model' },
    discord: { token: '' },
    dataDir,
  };
  const provider = new MockProvider();
  const bot = new Bot(config, provider);

  const out: OutgoingMessage[] = [];
  const send = async (m: OutgoingMessage) => void out.push(m);
  const from = (userId: string, userName: string, text: string): IncomingMessage => ({
    platform: 'cli',
    channelId: 'chan1',
    userId,
    userName,
    text,
  });

  // ── Dice (pure / deterministic) ──
  check('dice: d20+5 in range 6..25', (() => { const r = roll('d20+5'); return r.total >= 6 && r.total <= 25; })());
  check('dice: seeded rolls are reproducible', roll('2d6+1', 'x', 99).total === roll('2d6+1', 'x', 99).total);
  check('dice: extractRolls finds notation in prose', extractRolls('I cast 8d6 fireball and swing d20+7').length === 2);

  // ── Command routing + multiplayer ──
  await bot.handle(from('u1', 'Alice', '/dm new'), send);
  check('new: campaign created reply', out.at(-1)!.text.includes('new campaign'));

  await bot.handle(from('u1', 'Alice', '/dm join Thorin'), send);
  await bot.handle(from('u2', 'Bob', '/dm join Elaria'), send);
  out.length = 0;
  await bot.handle(from('u1', 'Alice', '/dm who'), send);
  check('multiplayer: both characters in party', out.at(-1)!.text.includes('Thorin') && out.at(-1)!.text.includes('Elaria'));

  // ── Spectator guard ──
  out.length = 0;
  await bot.handle(from('u3', 'Carol', 'I sneak in'), send);
  check('spectator: non-player is gated', out.at(-1)!.text.includes('spectating'));

  // ── Full turn: resolve dice BEFORE narration ──
  out.length = 0;
  await bot.handle(from('u1', 'Alice', 'I attack the goblin with my d20+5 sword'), send);
  check('turn: DM narration returned', out.at(-1)!.speaker === 'Dungeon Master');
  check('turn: resolved roll was injected into the prompt', /RESOLVED ROLLS/.test(provider.lastPrompt) && /d20\+5/.test(provider.lastPrompt));

  // ── Model dropdown ──
  out.length = 0;
  await bot.handle(from('u1', 'Alice', '/dm models'), send);
  check('models: lists the free mock model', out.at(-1)!.text.includes('mock/free-model'));

  // ── Persistence to disk ──
  const files = await fs.readdir(dataDir);
  const sessionFile = files.find((f) => f.startsWith('session_'));
  check('persistence: session file written to disk', Boolean(sessionFile));
  if (sessionFile) {
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, sessionFile), 'utf8'));
    check('persistence: history has the played turn', saved.history.length === 1);
    check('persistence: roll persisted with the turn', saved.history[0].rolls[0]?.notation === 'd20+5');
  }

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
  const store = new SessionStore(dataDir);
  check('import: re-joining keeps the imported persona', (await store.load('cli:chan1'))?.players.u1?.card?.name === 'Zara');

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

  // ── Character Card import (PNG with embedded tEXt 'chara' chunk) ──
  const pngChunk = (type: string, data: Buffer) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, 'latin1');
    data.copy(b, 8);
    return b; // CRC left zeroed — the extractor doesn't verify it
  };
  const embedded = Buffer.from(JSON.stringify({ spec_version: '2.0', data: { name: 'Vex', description: 'A PNG-borne spectre.' } })).toString('base64');
  const pngPath = path.join(dataDir, 'vex.card.png');
  await fs.writeFile(pngPath, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.alloc(13)),
    pngChunk('tEXt', Buffer.from(`chara\0${embedded}`, 'latin1')),
    pngChunk('IEND', Buffer.alloc(0)),
  ]));
  out.length = 0;
  await bot.handle(from('u4', 'Dave', `/dm import ${pngPath}`), send);
  check('import: PNG-embedded card extracted as NPC', out.at(-1)!.text.includes('Vex'));

  // ── Card injection stays bounded ──
  check('import: very long card fields are clipped in the prompt',
    renderCard({ specVersion: '2.0', name: 'Blob', description: 'x'.repeat(5000) }, 'NPC').length < 1000);

  // ── Cards persist in the session JSON ──
  const savedSession = JSON.parse(await fs.readFile(path.join(dataDir, sessionFile!), 'utf8'));
  check('persistence: persona card saved on the player', savedSession.players.u1?.card?.name === 'Zara');
  check('persistence: NPC cards saved on the session', savedSession.npcs?.length === 2 && savedSession.npcs[0].name === 'Grimble');

  // ── Backward compatibility: session saved before turnMode/npcs existed ──
  await fs.writeFile(
    path.join(dataDir, 'session_cli_legacy.json'),
    JSON.stringify({ id: 'old1', platform: 'cli', channelId: 'legacy', systemId: 'dnd5e', model: 'mock/free-model', players: {}, history: [], summary: '', createdAt: 1 }),
    'utf8',
  );
  const legacy = await store.load('cli:legacy');
  check('legacy: pre-feature session loads with mode immediate', legacy?.turnMode === 'immediate' && legacy?.turnIndex === 0);
  check('legacy: pre-card session defaults to no NPCs', Array.isArray(legacy?.npcs) && legacy!.npcs.length === 0);

  await fs.rm(dataDir, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? '🎉 all checks passed' : `💥 ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
