/**
 * Smoke test — drives the full bot pipeline with a mock provider (no network,
 * no API key). Proves: command routing, multiplayer join, deterministic dice,
 * turn pipeline, narration wiring, character-card import (plus its hardening
 * against hostile sources), lorebook injection, fog-of-war private narration
 * (including malformed markers), round-robin turn integrity under concurrent
 * sends and mid-wrap joins, reconnect seat re-claims (a fresh userId re-joining
 * as an existing character migrates the seat instead of ghosting the party),
 * vector-memory recall (mixed backends, cap, compact persistence),
 * session-model migration across providers, campaign end, disk persistence,
 * the SessionStorage seam (a full scenario on MemoryStorage), the Slack,
 * Matrix and Mattermost adapters' offline surface (module load + config
 * guard), and the web adapter end-to-end over loopback sockets on an
 * ephemeral port (static client with sane content-types and no external
 * origins, hello/roster protocol, broadcast, fog whispers, password,
 * malformed frames and request-targets, rate limit, frame/field size caps,
 * connection cap, pre-hello flood drop, hello deadline).
 *
 * Run:  npx tsx src/smoke.ts
 */
import { promises as fs } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import type { Config } from './config.js';
import type { CompletionRequest, GameSession, IncomingMessage, LLMProvider, ModelInfo, OutgoingMessage, TurnRecord } from './core/types.js';
import { Bot } from './core/bot.js';
import { roll, extractRolls } from './core/engine/dice.js';
import { SessionManager } from './core/session/session-manager.js';
import { NodeFileStorage } from './core/session/store.js';
import { MemoryStorage } from './core/session/storage.js';
import { loadCard, MAX_CARD_BYTES, renderCard } from './core/cards/card.js';
import { buildWorldInfo, makeEntry } from './core/lore/lorebook.js';
import { splitFog } from './core/narrator/fog.js';
import { cosine, MAX_MEMORIES, MemoryRetriever } from './core/memory/retrieval.js';
import { AnthropicProvider, convertToAnthropic } from './providers/anthropic.js';
import { OpenAICompatibleProvider } from './providers/openai-compatible.js';
import { SlackAdapter } from './adapters/slack.js';
import { MatrixAdapter } from './adapters/matrix.js';
import { MattermostAdapter } from './adapters/mattermost.js';
import { MAX_FRAME_BYTES, MAX_NAME_CHARS, MAX_PORTRAIT_BYTES, MAX_TEXT_CHARS, RATE_LIMIT_PER_SEC, UNJOINED_FRAMES_PER_SEC, WebAdapter } from './adapters/web.js';
import { MAX_BIO_CHARS, PORTRAIT_PRESETS, resolvePresetId } from './core/portraits.js';

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
  narration = 'The tavern falls silent as you act. (mock narration)';
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: 'mock/free-model', free: true }];
  }
  async complete(req: CompletionRequest): Promise<string> {
    this.lastPrompt = req.messages.map((m) => m.content).join('\n');
    return this.narration;
  }
}

/** A JSON frame from the web adapter, loosely typed for assertions. */
type Frame = { type: string; [k: string]: unknown };

/**
 * Test client for the web adapter, on Node 22's built-in (client) WebSocket.
 * Frames queue up until consumed by `next(pred)`; `all` keeps every frame ever
 * received so "this was NEVER delivered here" can be asserted.
 */
class WsClient {
  readonly all: Frame[] = [];
  private pending: Frame[] = [];
  private waiter?: { pred: (f: Frame) => boolean; resolve: (f: Frame | undefined) => void };
  private isClosed = false;
  private ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener('close', () => { this.isClosed = true; });
    this.ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as Frame;
      this.all.push(frame);
      if (this.waiter?.pred(frame)) {
        const w = this.waiter;
        this.waiter = undefined;
        w.resolve(frame);
      } else {
        this.pending.push(frame);
      }
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('ws connect failed')));
    });
  }

  send(frame: unknown): void {
    this.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  /** The next frame matching `pred` (buffered or future); undefined on timeout. */
  next(pred: (f: Frame) => boolean, timeoutMs = 3000): Promise<Frame | undefined> {
    const i = this.pending.findIndex(pred);
    if (i !== -1) return Promise.resolve(this.pending.splice(i, 1)[0]);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiter = undefined; resolve(undefined); }, timeoutMs);
      this.waiter = { pred, resolve: (f) => { clearTimeout(timer); resolve(f); } };
    });
  }

  /** True if any frame ever received here contains `text`. */
  sawText(text: string): boolean {
    return this.all.some((f) => typeof f.text === 'string' && f.text.includes(text));
  }

  /** Resolves when the socket closes — immediately if it already has. */
  closed(): Promise<void> {
    if (this.isClosed) return Promise.resolve();
    return new Promise((resolve) => this.ws.addEventListener('close', () => resolve()));
  }

  /** True if the socket closed within `timeoutMs` (for "the server dropped me" checks). */
  closedWithin(timeoutMs = 3000): Promise<boolean> {
    return Promise.race([
      this.closed().then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs)),
    ]);
  }

  close(): void {
    this.ws.close();
  }
}

/**
 * Best-effort offline sanity check: render a procedural crest inside headless
 * chromium to prove portraitSVG actually builds an SVG via createElementNS (not
 * just that the source parses) and is deterministic per seed. Skipped — never
 * failed — when chromium is missing or won't run, so the gate stays portable.
 */
async function headlessCrestCheck(portraitSrc: string): Promise<void> {
  const chromium = '/usr/bin/chromium';
  try {
    await fs.access(chromium);
  } catch {
    console.log('⏭  web-ui: headless crest check skipped (no chromium)');
    return;
  }
  const tmpDir = path.join('data', 'smoke');
  await fs.mkdir(tmpDir, { recursive: true });
  const htmlPath = path.join(tmpDir, 'crest-probe.html');
  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body><pre id="out"></pre>
<script>${portraitSrc}
try {
  var svg = portraitSVG('fighter', { preset: 'fighter' });
  var stops = svg.getElementsByTagName('stop');
  var ok = svg.tagName.toLowerCase() === 'svg'
    && svg.getAttribute('class') === 'crest'
    && svg.querySelector('.crest-emblem') != null
    && svg.querySelectorAll('path').length >= 2
    && stops.length >= 2;
  var a = portraitSVG('Thorin', {}).getElementsByTagName('stop')[0].getAttribute('stop-color');
  var b = portraitSVG('Thorin', {}).getElementsByTagName('stop')[0].getAttribute('stop-color');
  document.getElementById('out').textContent = 'CREST_OK=' + (ok && a === b);
} catch (e) {
  document.getElementById('out').textContent = 'CREST_OK=false:' + e;
}
</script></body></html>`;
  await fs.writeFile(htmlPath, page, 'utf8');
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(
    chromium,
    ['--headless', '--no-sandbox', '--disable-gpu', '--dump-dom', `file://${path.resolve(htmlPath)}`],
    { encoding: 'utf8', timeout: 25000 },
  );
  const dom = String(res.stdout ?? '');
  if (res.error || !dom.includes('CREST_OK=')) {
    console.log('⏭  web-ui: headless crest check skipped (chromium did not produce output)');
    return;
  }
  check('web-ui: headless chromium renders a deterministic procedural crest (createElementNS)', dom.includes('CREST_OK=true'));
}

/**
 * Best-effort offline check that a 'scene' frame RENDERS on the token board:
 * loads the real client (portraits.js + app.js) against the served page's DOM
 * inside headless chromium, dispatches a scene of pc + npc tokens, and asserts
 * the board drew one portrait-crest token per entry, with the actor + npc
 * classes and name labels. Skipped — never failed — when chromium is missing,
 * so the gate stays portable.
 */
async function headlessBoardCheck(html: string, portraitSrc: string, appSrc: string): Promise<void> {
  const chromium = '/usr/bin/chromium';
  try {
    await fs.access(chromium);
  } catch {
    console.log('⏭  web-ui: headless board check skipped (no chromium)');
    return;
  }
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) {
    console.log('⏭  web-ui: headless board check skipped (no <body> in served HTML)');
    return;
  }
  const body = bodyMatch[1].replace(/<script\b[^>]*><\/script>/gi, ''); // drop the real src=… tags; we inline the sources
  const tmpDir = path.join('data', 'smoke');
  await fs.mkdir(tmpDir, { recursive: true });
  const htmlPath = path.join(tmpDir, 'board-probe.html');
  const probe = `
    try {
      state.roster = [
        { userId: 'u1', userName: 'Alice', characterName: 'Thorin', portrait: { kind: 'preset', id: 'fighter' } },
        { userId: 'u2', userName: 'Bob', characterName: 'Elaria', portrait: null },
      ];
      onScene({ type: 'scene', actor: 'Thorin', tokens: [
        { id: 'pc:u1', who: 'Thorin', kind: 'pc', x: 0.3, y: 0.7 },
        { id: 'pc:u2', who: 'Elaria', kind: 'pc', x: 0.5, y: 0.6 },
        { id: 'npc:Vex', who: 'Vex', kind: 'npc', x: 0.7, y: 0.3 }
      ] });
      var svg = document.getElementById('board-svg');
      var tokens = svg.querySelectorAll('g.token');
      var crests = svg.querySelectorAll('.crest');
      var labels = [].map.call(svg.querySelectorAll('.token-label'), function (n) { return n.textContent; });
      var ok = tokens.length === 3 && crests.length === 3
        && svg.querySelector('g.token.actor') != null
        && svg.querySelector('g.token.npc') != null
        && svg.getElementsByTagName('image').length === 0
        && labels.indexOf('Thorin') !== -1 && labels.indexOf('Vex') !== -1;
      document.getElementById('board-probe-out').textContent = 'BOARD_OK=' + ok;
    } catch (e) {
      document.getElementById('board-probe-out').textContent = 'BOARD_OK=false:' + e;
    }
  `;
  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}
<pre id="board-probe-out"></pre>
<script>${portraitSrc}</script>
<script>${appSrc}</script>
<script>${probe}</script>
</body></html>`;
  await fs.writeFile(htmlPath, page, 'utf8');
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(
    chromium,
    ['--headless', '--no-sandbox', '--disable-gpu', '--dump-dom', `file://${path.resolve(htmlPath)}`],
    { encoding: 'utf8', timeout: 25000 },
  );
  const dom = String(res.stdout ?? '');
  if (res.error || !dom.includes('BOARD_OK=')) {
    console.log('⏭  web-ui: headless board check skipped (chromium did not produce output)');
    return;
  }
  check('web-ui: headless chromium renders scene tokens as portrait crests on the board', dom.includes('BOARD_OK=true'));
}

/**
 * Best-effort offline check that every one of the 12 class portraits renders as
 * a rich, distinct character bust (not a blank/blobby placeholder) at BOTH token
 * (36px) and card (120px) size. Inside headless chromium it builds each class's
 * SVG, asserts a non-trivial node/path count and a `.crest-emblem`, and that the
 * 12 classes yield distinct dominant (background) colours. Skipped — never
 * failed — when chromium is missing, so the gate stays portable.
 */
async function headlessClassGalleryCheck(portraitSrc: string): Promise<void> {
  const chromium = '/usr/bin/chromium';
  try {
    await fs.access(chromium);
  } catch {
    console.log('⏭  web-ui: headless class-gallery check skipped (no chromium)');
    return;
  }
  const tmpDir = path.join('data', 'smoke');
  await fs.mkdir(tmpDir, { recursive: true });
  const htmlPath = path.join(tmpDir, 'gallery-probe.html');
  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body><pre id="out"></pre>
<script>${portraitSrc}
try {
  var ids = ${JSON.stringify(PORTRAIT_PRESETS)};
  var minNodes = 999, minPaths = 999, allEmblem = true, bg = {};
  ids.forEach(function (id) {
    ['36', '120'].forEach(function (px) {
      var box = document.createElement('div');
      box.style.width = px + 'px'; box.style.height = px + 'px';
      var svg = portraitSVG(id + '-Kael', { class: id });
      box.appendChild(svg); document.body.appendChild(box);
      var nodes = svg.querySelectorAll('*').length;
      if (nodes < minNodes) minNodes = nodes;
      var paths = svg.querySelectorAll('path').length;
      if (paths < minPaths) minPaths = paths;
      if (!svg.querySelector('.crest-emblem')) allEmblem = false;
    });
    bg[portraitSVG(id, { class: id }).getElementsByTagName('stop')[0].getAttribute('stop-color')] = 1;
  });
  var ok = minNodes >= 20 && minPaths >= 6 && allEmblem && Object.keys(bg).length >= 11;
  document.getElementById('out').textContent = 'GALLERY_OK=' + ok + ' nodes=' + minNodes + ' paths=' + minPaths + ' bg=' + Object.keys(bg).length;
} catch (e) {
  document.getElementById('out').textContent = 'GALLERY_OK=false:' + e;
}
</script></body></html>`;
  await fs.writeFile(htmlPath, page, 'utf8');
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(
    chromium,
    ['--headless', '--no-sandbox', '--disable-gpu', '--dump-dom', `file://${path.resolve(htmlPath)}`],
    { encoding: 'utf8', timeout: 25000 },
  );
  const dom = String(res.stdout ?? '');
  if (res.error || !dom.includes('GALLERY_OK=')) {
    console.log('⏭  web-ui: headless class-gallery check skipped (chromium did not produce output)');
    return;
  }
  check('web-ui: headless chromium renders all 12 class busts as rich, distinct portraits', dom.includes('GALLERY_OK=true'));
}

/**
 * Best-effort offline check that the character-creator flow is REACHABLE and
 * WIRED: loads the real client (portraits.js + app.js) against the served page's
 * DOM inside headless chromium, simulates a joined seat with a stubbed socket,
 * opens the creator via the persistent "⚔ Your character" topbar button, and
 * asserts the class gallery renders 12 live portrait previews and that picking a
 * class both lights it up and sends the expected `/dm class <id>` frame. Skipped
 * — never failed — when chromium is missing, so the gate stays portable.
 */
async function headlessCreatorCheck(html: string, portraitSrc: string, appSrc: string): Promise<void> {
  const chromium = '/usr/bin/chromium';
  try {
    await fs.access(chromium);
  } catch {
    console.log('⏭  web-ui: headless creator check skipped (no chromium)');
    return;
  }
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) {
    console.log('⏭  web-ui: headless creator check skipped (no <body> in served HTML)');
    return;
  }
  const body = bodyMatch[1].replace(/<script\b[^>]*><\/script>/gi, ''); // drop the real src=… tags; we inline the sources
  const tmpDir = path.join('data', 'smoke');
  await fs.mkdir(tmpDir, { recursive: true });
  const htmlPath = path.join(tmpDir, 'creator-probe.html');
  const probe = `
    try {
      var sent = [];
      state.join = { userName: 'Alice', channelId: 'room1' };
      state.userId = 'u1';
      state.welcomed = true;
      state.ws = { readyState: 1, send: function (s) { sent.push(String(s)); } }; // WebSocket.OPEN === 1
      state.roster = [{ userId: 'u1', userName: 'Alice' }]; // my seat, no character yet
      // Reach the creator the way a first-time user would — the persistent button.
      document.getElementById('creator-btn').click();
      var creatorOpen = document.getElementById('creator').hidden === false;
      var choices = document.querySelectorAll('#card-gallery .crest-choice');
      var previews = document.querySelectorAll('#card-gallery .crest-choice .crest');
      // Pick the wizard class: it must send "/dm class wizard" and light up.
      var wiz = document.querySelector('#card-gallery .crest-choice[data-cls="wizard"]');
      wiz.click();
      var sentClass = sent.some(function (s) { return s.indexOf('/dm class wizard') !== -1; });
      var lit = wiz.classList.contains('selected');
      var ok = creatorOpen && choices.length === 12 && previews.length === 12 && sentClass && lit;
      document.getElementById('creator-probe-out').textContent =
        'CREATOR_OK=' + ok + ' choices=' + choices.length + ' previews=' + previews.length + ' sent=' + sentClass + ' lit=' + lit;
    } catch (e) {
      document.getElementById('creator-probe-out').textContent = 'CREATOR_OK=false:' + e;
    }
  `;
  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}
<pre id="creator-probe-out"></pre>
<script>${portraitSrc}</script>
<script>${appSrc}</script>
<script>${probe}</script>
</body></html>`;
  await fs.writeFile(htmlPath, page, 'utf8');
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(
    chromium,
    ['--headless', '--no-sandbox', '--disable-gpu', '--dump-dom', `file://${path.resolve(htmlPath)}`],
    { encoding: 'utf8', timeout: 25000 },
  );
  const dom = String(res.stdout ?? '');
  if (res.error || !dom.includes('CREATOR_OK=')) {
    console.log('⏭  web-ui: headless creator check skipped (chromium did not produce output)');
    return;
  }
  check('web-ui: headless chromium reaches the creator via the button, renders 12 class previews, and sends /dm class on pick', dom.includes('CREATOR_OK=true'));
}

async function main() {
  const dataDir = path.join('data', 'smoke');
  await fs.rm(dataDir, { recursive: true, force: true });

  const config: Config = {
    llm: { provider: '', baseUrl: 'http://mock', apiKey: 'x', model: 'mock/free-model', embeddingsModel: '' },
    discord: { token: '' },
    slack: { botToken: '', appToken: '' },
    matrix: { homeserverUrl: '', accessToken: '' },
    mattermost: { url: '', token: '' },
    web: { host: '127.0.0.1', port: 0, password: '' },
    dataDir,
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

  // ── Dice (pure / deterministic) ──
  check('dice: d20+5 in range 6..25', (() => { const r = roll('d20+5'); return r.total >= 6 && r.total <= 25; })());
  check('dice: seeded rolls are reproducible', roll('2d6+1', 'x', 99).total === roll('2d6+1', 'x', 99).total);
  check('dice: extractRolls finds notation in prose', extractRolls('I cast 8d6 fireball and swing d20+7').length === 2);

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
  }

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

  // ── Seat re-claim: a fresh userId re-joining as an existing character migrates the seat ──
  // (The web adapter mints a new userId per connection; without this, a
  // reconnect + `/dm join <name>` ghosts the party: round-robin deadlocks on
  // the dead entry and fog whispers target a userId with no socket.)
  {
    const mgr = new SessionManager(new MemoryStorage(), 'mock/free-model');
    const rm = (userId: string, userName: string): IncomingMessage => ({ platform: 'web', channelId: 'reclaim', userId, userName, text: '' });
    const s = await mgr.create(rm('w1', 'Alice'));
    await mgr.join(s, rm('w1', 'Alice'), 'Thorin');
    await mgr.join(s, rm('w2', 'Bob'), 'Elaria');
    s.players.w1.hp = 3;
    s.players.w1.portrait = { kind: 'preset', id: 'mage' }; // set a portrait BEFORE the reconnect
    await mgr.join(s, rm('w9', 'Alice'), 'thorin'); // reconnected: new userId, same character (case-insensitive)
    check('reclaim: migrated seat keeps hp and its join-order slot, dead userId is gone',
      !s.players.w1 && s.players.w9?.hp === 3 && Object.keys(s.players).join(',') === 'w9,w2');
    check('reclaim: the portrait survives the seat re-claim (not reverted to the default crest)',
      s.players.w9?.portrait?.kind === 'preset' && (s.players.w9!.portrait as { id: string }).id === 'mage');
    await mgr.join(s, rm('w2', 'Bob'), 'Thorin'); // a member renaming to a taken name is NOT a takeover
    check('reclaim: an existing member renaming keeps their own seat',
      Boolean(s.players.w9) && s.players.w2?.characterName === 'Thorin' && Object.keys(s.players).length === 2);
  }
  {
    const rcBot = new Bot(config, provider, new MemoryStorage());
    const rcOut: OutgoingMessage[] = [];
    const rcSend = async (m: OutgoingMessage) => void rcOut.push(m);
    const rc = (userId: string, userName: string, text: string): IncomingMessage =>
      ({ platform: 'web', channelId: 'rc', userId, userName, text });
    await rcBot.handle(rc('web-a1', 'Alice', '/dm new'), rcSend);
    await rcBot.handle(rc('web-a1', 'Alice', '/dm join Thorin'), rcSend);
    await rcBot.handle(rc('web-b1', 'Bob', '/dm join Elaria'), rcSend);
    await rcBot.handle(rc('web-a1', 'Alice', '/dm mode round-robin'), rcSend);
    // Bob's browser reconnects: new userId, and he re-claims as the client instructs.
    await rcBot.handle(rc('web-b2', 'Bob', '/dm join Elaria'), rcSend);
    rcOut.length = 0;
    await rcBot.handle(rc('web-b2', 'Bob', '/dm who'), rcSend);
    check('reclaim: re-joining after a reconnect does not duplicate the character',
      (rcOut.at(-1)!.text.match(/Elaria/g) ?? []).length === 1);
    rcOut.length = 0;
    await rcBot.handle(rc('web-a1', 'Alice', 'I advance'), rcSend);
    check('reclaim: after Thorin acts the turn reaches the re-claimed seat', rcOut.at(-1)!.text.includes('Elaria'));
    rcOut.length = 0;
    await rcBot.handle(rc('web-b2', 'Bob', 'I loose an arrow'), rcSend);
    check('reclaim: the reconnected userId can act on its turn — no ghost deadlock',
      rcOut.some((m) => m.speaker === 'Dungeon Master'));
    await rcBot.handle(rc('web-a1', 'Alice', '/dm fog on'), rcSend);
    provider.narration = 'Shadows shift. [PRIVATE:Elaria]You spot a tripwire.[/PRIVATE]';
    rcOut.length = 0;
    await rcBot.handle(rc('web-a1', 'Alice', 'I press on'), rcSend);
    check('reclaim: fog whisper targets the live reconnected userId, not the dead one',
      rcOut.find((m) => m.targetUserId)?.targetUserId === 'web-b2');
    provider.narration = 'The tavern falls silent as you act. (mock narration)';
  }

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
  const store = new NodeFileStorage(dataDir);
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
  check('portrait: PNG card import keeps the embedded image bytes as the card portrait',
    savedSession.npcs?.some((n: { name: string; portrait?: { kind: string; mime: string; data: string } }) =>
      n.name === 'Vex' && n.portrait?.kind === 'image' && n.portrait?.mime === 'image/png' && typeof n.portrait?.data === 'string' && n.portrait.data.length > 0));

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
  const bomb = deflateSync(Buffer.alloc(8 * 1024 * 1024)); // a few KB compressed → 8 MB inflated
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
    check('web-ui: HTML wires up app.js, portraits.js and style.css',
      html.includes('src="app.js"') && html.includes('src="portraits.js"') && html.includes('href="style.css"'));
    const srcHrefs = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);
    check('web-ui: every asset reference is same-origin (relative), never an external origin',
      srcHrefs.length >= 4 && srcHrefs.every((v) => !/^(?:https?:)?\/\//i.test(v)));
    // The client is DOM code smoke can't execute, so pin its two reconnect-UX
    // fixes statically: Leave must not depend on a close event (a CLOSED socket
    // fires none), and a trailing close must not wipe a shown join error.
    const appSrc = await jsRes.text();
    check('web-ui: Leave cancels the retry timer and shows the join screen directly',
      /'leave-btn'\)[^]*?clearTimeout\(state\.retryTimer\)[^]*?showJoin\(''\)/.test(appSrc));
    check('web-ui: a close event after a refused hello cannot wipe the join-screen error',
      /if \(\$\('join-screen'\)\.hidden\) showJoin\(''\)/.test(appSrc));
    // The portrait helper must be procedural + XSS-safe: crests are built with
    // createElementNS (never innerHTML) and cover all eight preset archetypes.
    const portraitSrc = await portraitJsRes.text();
    check('web-ui: portraits.js exposes portraitSVG and the full preset catalog',
      /function portraitSVG\(/.test(portraitSrc) &&
      PORTRAIT_PRESETS.every((id) => portraitSrc.includes(`${id}:`)));
    check('web-ui: crests are built with createElementNS, with no innerHTML assignment',
      portraitSrc.includes('createElementNS') && !/\.innerHTML\s*=/.test(portraitSrc));
    check('web-ui: the roster token and card sheet render portraits, not a bare hue dot',
      appSrc.includes('makePortrait') && appSrc.includes("el('span', 'seat-portrait')") &&
      /function openCard\(/.test(appSrc) && appSrc.includes('/portrait/'));
    check('web-ui: index.html includes the character-card sheet with a crest gallery + upload',
      html.includes('id="card-sheet"') && html.includes('id="card-gallery"') && html.includes('id="card-file"'));

    // Character-setup flow: a prominent, discoverable creator with a persistent
    // topbar entry, name/class/bio/import controls, and a live portrait preview.
    check('web-ui: index.html has a persistent "Your character" button and the creator panel',
      html.includes('id="creator-btn"') && html.includes('id="creator"') &&
      html.includes('id="creator-name"') && html.includes('id="creator-bio"') &&
      html.includes('id="creator-portrait"') && html.includes('id="creator-import"'));
    check('web-ui: the creator opens from the button/own seat, auto-prompts first-timers, and wires class/name/bio/import',
      appSrc.includes('function openCreator(') && appSrc.includes('maybePromptCreator') &&
      /openCard[\s\S]*openCreator\(\)/.test(appSrc) &&
      appSrc.includes('/dm join ') && appSrc.includes('/dm class ') &&
      appSrc.includes('/dm bio ') && appSrc.includes('/dm import '));
    check('web-ui: the creator class gallery previews all 12 classes with the procedural bust',
      appSrc.includes('buildCreatorGallery') && appSrc.includes('CLASS_INFO') &&
      PORTRAIT_PRESETS.every((id) => appSrc.includes(`'${id}'`)) && appSrc.includes('portraitSVG(seed'));

    // The token board draws each scene token as a PORTRAIT (reusing the roster's
    // descriptor + portraitSVG), with a name label and distinct pc/npc + actor
    // styling; drags are throttled and send a final position on drop.
    const styleSrc = await cssRes.text();
    check('web-ui: the board draws portrait tokens (crest/image) with a name label, not bare hue dots',
      appSrc.includes('renderBoard') && appSrc.includes('tokenPortrait') && appSrc.includes('portraitForToken') &&
      appSrc.includes('crestNode') && appSrc.includes('token-label'));
    check('web-ui: board CSS distinguishes pc/npc tokens, glows the actor, and fades the dice pop',
      /\.token\.pc/.test(styleSrc) && /\.token\.npc/.test(styleSrc) &&
      /\.token\.actor/.test(styleSrc) && /@keyframes tokenglow/.test(styleSrc) && /\.board-pop/.test(styleSrc));
    check('web-ui: index.html carries the token board with a Map toggle',
      html.includes('id="board-svg"') && html.includes('id="board-toggle"'));
    check('web-ui: token drags are throttled and send a final move on drop',
      appSrc.includes('lastMoveSent') && appSrc.includes("type: 'move'") && /pointerup/.test(appSrc));
    // Client fixes smoke can't execute, pinned statically: the portrait upload
    // authorizes with the per-seat token (never the room password), and the board
    // dice-pop dedupes on the monotonic rollSeq with a first-frame baseline (so
    // repeat rolls still pop and a late joiner never pops a roll that predates it).
    check('web-ui: portrait upload authorizes with the per-seat upload token (not the password)',
      appSrc.includes("'x-upload-token'") && appSrc.includes('state.uploadToken') && !/password=\$\{/.test(appSrc));
    check('web-ui: the board dice-pop dedupes on rollSeq with a first-frame baseline',
      appSrc.includes('rollSeq') && appSrc.includes('lastRollSeen') && !appSrc.includes('lastRollSig'));

    // Optional, offline: render a crest in headless chromium to prove the
    // procedural SVG actually builds (createElementNS path) and is deterministic,
    // then render a full scene onto the real board. Both are best-effort —
    // skipped (never failed) when chromium is unavailable.
    await headlessCrestCheck(portraitSrc);
    await headlessBoardCheck(html, portraitSrc, appSrc);
    await headlessClassGalleryCheck(portraitSrc);
    await headlessCreatorCheck(html, portraitSrc, appSrc);

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
      const p1 = new WsClient(url);
      await p1.open();
      p1.send({ type: 'hello', userName: 'Pat', channelId: 'posroom', password: 'hunter2' });
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
      p2.send({ type: 'hello', userName: 'Pat', channelId: 'posroom', password: 'hunter2' });
      const p2id = (await p2.next((f) => f.type === 'welcome'))!.userId as string;
      await new Promise((r) => setTimeout(r, 1100));
      p2.send({ type: 'say', text: '/dm join Ranger' }); // re-claim the seat under a fresh userId
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

  // ── /dm end must evict the live session cache, not just delete the file ──
  out.length = 0;
  await bot.handle(from('u1', 'Alice', '/dm end'), send);
  check('end: campaign ends', out.at(-1)!.text.includes('Campaign ended'));
  out.length = 0;
  await bot.handle(from('u1', 'Alice', 'I knock on the tavern door'), send);
  check('end: ended campaign does not resurrect from the live session cache',
    out.at(-1)!.text.includes('No game in this channel'));
  check('end: session file stays deleted', !(await fs.readdir(dataDir)).includes(sessionFile!));

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

  await fs.rm(dataDir, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? '🎉 all checks passed' : `💥 ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
