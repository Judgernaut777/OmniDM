/**
 * Smoke test — drives the full bot pipeline with a mock provider (no network,
 * no API key). Proves: command routing, multiplayer join, deterministic dice,
 * turn pipeline, narration wiring, and disk persistence.
 *
 * Run:  npx tsx src/smoke.ts
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import type { CompletionRequest, IncomingMessage, LLMProvider, ModelInfo, OutgoingMessage } from './core/types.js';
import { Bot } from './core/bot.js';
import { roll, extractRolls } from './core/engine/dice.js';

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

  await fs.rm(dataDir, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? '🎉 all checks passed' : `💥 ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
