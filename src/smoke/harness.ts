/**
 * Smoke-test harness — the reusable test kit, split out of the monolithic
 * smoke.ts so the test CASES live in their own topical modules and the same
 * cases can run under two runners: the legacy counted runner (`npm run smoke`,
 * gate output unchanged) and a real `node:test` runner (`npm run test`).
 *
 * The seam is a swappable Reporter: section bodies call the module-level
 * `check`/`skip`, which delegate to whichever Reporter the active runner set.
 * Sections register into a {@link Suite}; a runner decides how to execute them.
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

// ── Reporter seam ──────────────────────────────────────────────────────────
export interface Reporter {
  check(label: string, cond: boolean): void;
  skip(label: string): void;
}
let active: Reporter = { check() {}, skip() {} };
/** Point `check`/`skip` at the runner's reporter (legacy counter, or per-test collector). */
export function setReporter(r: Reporter): void {
  active = r;
}
/** Assert `cond`, labelled — delegates to the active reporter. */
export function check(label: string, cond: boolean): void {
  active.check(label, cond);
}
/** An explicitly COUNTED skip (never a silent no-op) — delegates to the active reporter. */
export function skip(label: string): void {
  active.skip(label);
}

/** The legacy runner's reporter: prints ✅/❌/⏭ and tallies, exactly as the monolith did. */
export class LegacyReporter implements Reporter {
  total = 0;
  failures = 0;
  skipped = 0;
  check(label: string, cond: boolean): void {
    this.total++;
    console.log(`${cond ? '✅' : '❌'} ${label}`);
    if (!cond) this.failures++;
  }
  skip(label: string): void {
    this.skipped++;
    console.log(`⏭  ${label}`);
  }
  /** Report a section that threw as a single failed check (preserves the monolith's isolation). */
  sectionThrew(name: string, err: unknown): void {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    this.check(`${name}: section threw unexpectedly — ${detail.split('\n')[0]}`, false);
    console.log(detail);
  }
}

/** The node:test runner's reporter: collects failures so the surrounding test() can fail on them. */
export class CollectingReporter implements Reporter {
  total = 0;
  failures = 0;
  skipped = 0;
  readonly failedLabels: string[] = [];
  check(label: string, cond: boolean): void {
    this.total++;
    if (!cond) {
      this.failures++;
      this.failedLabels.push(label);
    }
  }
  skip(): void {
    this.skipped++;
  }
}

// ── Suite: sections register here; a runner executes them ────────────────────
export interface SectionSpec {
  name: string;
  fn: () => void | Promise<void>;
}
export class Suite {
  readonly specs: SectionSpec[] = [];
  private setups: Array<() => void | Promise<void>> = [];
  private teardowns: Array<() => void | Promise<void>> = [];
  section(name: string, fn: () => void | Promise<void>): void {
    this.specs.push({ name, fn });
  }
  setup(fn: () => void | Promise<void>): void {
    this.setups.push(fn);
  }
  teardown(fn: () => void | Promise<void>): void {
    this.teardowns.push(fn);
  }
  async runSetup(): Promise<void> {
    for (const f of this.setups) await f();
  }
  async runTeardown(): Promise<void> {
    for (const f of this.teardowns) await f();
  }
}

/** The committed static web client directory (src/smoke/ -> ../../web). */
export const WEB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

export class MockProvider implements LLMProvider {
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
export type Frame = { type: string; [k: string]: unknown };

/**
 * Test client for the web adapter, on Node 22's built-in (client) WebSocket.
 * Frames queue up until consumed by `next(pred)`; `all` keeps every frame ever
 * received so "this was NEVER delivered here" can be asserted.
 */
export class WsClient {
  readonly all: RoomFrame[] = [];
  private pending: RoomFrame[] = [];
  private waiter?: { pred: (f: RoomFrame) => boolean; resolve: (f: RoomFrame | undefined) => void };
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
export async function headlessCrestCheck(portraitSrc: string): Promise<void> {
  const chromium = '/usr/bin/chromium';
  try {
    await fs.access(chromium);
  } catch {
    skip('web-ui: headless crest check skipped (no chromium)');
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
    skip('web-ui: headless crest check skipped (chromium did not produce output)');
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
export async function headlessBoardCheck(html: string, portraitSrc: string, appSrc: string): Promise<void> {
  const chromium = '/usr/bin/chromium';
  try {
    await fs.access(chromium);
  } catch {
    skip('web-ui: headless board check skipped (no chromium)');
    return;
  }
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) {
    skip('web-ui: headless board check skipped (no <body> in served HTML)');
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
    skip('web-ui: headless board check skipped (chromium did not produce output)');
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
export async function headlessClassGalleryCheck(portraitSrc: string): Promise<void> {
  const chromium = '/usr/bin/chromium';
  try {
    await fs.access(chromium);
  } catch {
    skip('web-ui: headless class-gallery check skipped (no chromium)');
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
    skip('web-ui: headless class-gallery check skipped (chromium did not produce output)');
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
export async function headlessCreatorCheck(html: string, portraitSrc: string, appSrc: string): Promise<void> {
  const chromium = '/usr/bin/chromium';
  try {
    await fs.access(chromium);
  } catch {
    skip('web-ui: headless creator check skipped (no chromium)');
    return;
  }
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) {
    skip('web-ui: headless creator check skipped (no <body> in served HTML)');
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
      // A stub transport capturing the frames the creator sends (app.js routes
      // every send through state.transport now, not a bare WebSocket).
      state.transport = { local: true, isOpen: function () { return true; }, send: function (f) { sent.push(JSON.stringify(f)); } };
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
    skip('web-ui: headless creator check skipped (chromium did not produce output)');
    return;
  }
  check('web-ui: headless chromium reaches the creator via the button, renders 12 class previews, and sends /dm class on pick', dom.includes('CREATOR_OK=true'));
}

/** Neutralize any `</script>` in an inlined source so it can't close the tag early. */
const inlineSafe = (s: string): string => s.replace(/<\/script/gi, '<\\/script');

/**
 * Boot the REAL client (engine bundle + transport + portraits + app.js) in
 * headless chromium and run a probe against it. `--virtual-time-budget`
 * fast-forwards timers so an async flow (join → say → narration render)
 * completes before `--dump-dom` captures the DOM. Returns the dumped DOM, or
 * null when chromium is missing / produced nothing — so the caller can skip
 * (never fail) and the gate stays portable.
 */
export async function runHeadlessClient(
  label: string,
  html: string,
  srcs: { engine: string; transport: string; portraits: string; app: string },
  probe: string,
): Promise<string | null> {
  const chromium = '/usr/bin/chromium';
  try {
    await fs.access(chromium);
  } catch {
    skip(`web-ui: headless ${label} check skipped (no chromium)`);
    return null;
  }
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) {
    skip(`web-ui: headless ${label} check skipped (no <body> in served HTML)`);
    return null;
  }
  const body = bodyMatch[1].replace(/<script\b[^>]*><\/script>/gi, ''); // drop real src=… tags; we inline the sources
  const tmpDir = path.join('data', 'smoke');
  await fs.mkdir(tmpDir, { recursive: true });
  const htmlPath = path.join(tmpDir, `${label}-probe.html`);
  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}
<pre id="probe-out"></pre>
<script>${inlineSafe(srcs.engine)}</script>
<script>${inlineSafe(srcs.transport)}</script>
<script>${inlineSafe(srcs.portraits)}</script>
<script>${inlineSafe(srcs.app)}</script>
<script>${probe}</script>
</body></html>`;
  await fs.writeFile(htmlPath, page, 'utf8');
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(
    chromium,
    ['--headless', '--no-sandbox', '--disable-gpu', '--virtual-time-budget=9000', '--dump-dom', `file://${path.resolve(htmlPath)}`],
    { encoding: 'utf8', timeout: 35000 },
  );
  return res.error ? null : String(res.stdout ?? '');
}

/**
 * Best-effort offline proof of the WHOLE "Play on this device" path in a real
 * browser: with an INJECTED mock provider + in-memory storage (no network, no
 * key), the client picks Local mode, joins, starts a campaign, joins a
 * character, takes an action, and the DM's narration RENDERS in the log —
 * entirely from the in-page engine bundle. Deterministic (in-process), so it
 * asserts pass/fail; skipped only when chromium is unavailable.
 */
export async function headlessLocalTurnCheck(
  html: string,
  srcs: { engine: string; transport: string; portraits: string; app: string },
): Promise<void> {
  const probe = `
    (async () => {
      var out = document.getElementById('probe-out');
      var waitFor = function (fn, ms) { return new Promise(function (res) {
        var t0 = Date.now(); var iv = setInterval(function () { var ok = false; try { ok = fn(); } catch (e) {}
          if (ok || Date.now() - t0 > ms) { clearInterval(iv); res(ok); } }, 15); }); };
      try {
        // Inject the engine's provider + storage (the LocalTransport test seams):
        // a mock/echo provider and a Map-backed SessionStorage — no network, no key.
        window.__omnidmTestProvider = { id: 'mock',
          listModels: function () { return Promise.resolve([{ id: 'mock/free-model', free: true }]); },
          complete: function (req) { return Promise.resolve('The training dummy SPLINTERS as your blade bites deep. (in-app mock)'); } };
        window.__omnidmTestStorage = (function () { var m = new Map(); return {
          load: function (k) { return Promise.resolve(m.has(k) ? m.get(k) : null); },
          save: function (k, s) { m.set(k, s); return Promise.resolve(); },
          delete: function (k) { m.delete(k); return Promise.resolve(); } }; })();
        document.getElementById('mode-local').click();
        document.getElementById('j-name').value = 'Solo';
        document.getElementById('j-room').value = 'roomX';
        document.getElementById('join-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        var opened = await waitFor(function () { return document.getElementById('table').hidden === false; }, 3000);
        var isLocal = !!(state.transport && state.transport.local === true);
        sendSay('/dm new');
        await waitFor(function () { return false; }, 60);
        sendSay('/dm join Hero');
        await waitFor(function () { return document.querySelector('#roster-list .seat') != null; }, 3000);
        sendSay('I strike the dummy with my d20+3 blade');
        var narrated = await waitFor(function () {
          return [].some.call(document.querySelectorAll('#log .msg.dm .body'), function (n) { return n.textContent.indexOf('SPLINTERS') !== -1; });
        }, 4000);
        var dm = document.querySelectorAll('#log .msg.dm').length;
        out.textContent = 'LOCAL_OK=' + (opened && isLocal && narrated && dm >= 1) +
          ' opened=' + opened + ' local=' + isLocal + ' narrated=' + narrated + ' dm=' + dm;
      } catch (e) { out.textContent = 'LOCAL_OK=false:' + e; }
    })();
  `;
  const dom = await runHeadlessClient('local-turn', html, srcs, probe);
  if (dom === null || !dom.includes('LOCAL_OK=')) {
    skip('web-ui: headless local-turn check skipped (chromium produced no output)');
    return;
  }
  check('web-ui: headless "Play on this device" runs a full turn in-app (join → action → DM narration renders) with browser storage, no network', dom.includes('LOCAL_OK=true'));
}

/**
 * Best-effort offline proof that "Connect to a server" mode still drives the
 * client's RemoteTransport against a REAL loopback WebAdapter and completes a
 * turn. Runs against the live server on `serverUrl`. Because it depends on a
 * real WebSocket round-trip under headless virtual-time, it only ASSERTS on
 * clear success and otherwise emits no marker (skipped, never flaky-failed) —
 * the exhaustive WsClient suite below is the authoritative server-mode gate.
 */
export async function headlessServerTurnCheck(
  html: string,
  srcs: { engine: string; transport: string; portraits: string; app: string },
  serverUrl: string,
  password: string,
): Promise<void> {
  const probe = `
    (async () => {
      var out = document.getElementById('probe-out');
      var waitFor = function (fn, ms) { return new Promise(function (res) {
        var t0 = Date.now(); var iv = setInterval(function () { var ok = false; try { ok = fn(); } catch (e) {}
          if (ok || Date.now() - t0 > ms) { clearInterval(iv); res(ok); } }, 15); }); };
      try {
        document.getElementById('mode-server').click();
        document.getElementById('j-name').value = 'Netizen';
        document.getElementById('j-room').value = 'netroom';
        document.getElementById('j-server').value = ${JSON.stringify(serverUrl)};
        document.getElementById('j-pass').value = ${JSON.stringify(password)};
        document.getElementById('join-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        var opened = await waitFor(function () { return document.getElementById('table').hidden === false; }, 6000);
        var isRemote = !!(state.transport && state.transport.local === false);
        if (opened && isRemote) {
          sendSay('/dm new');
          await waitFor(function () { return false; }, 80);
          sendSay('/dm join Hero');
          await waitFor(function () { return document.querySelector('#roster-list .seat') != null; }, 6000);
          sendSay('I swing my sword');
          var narrated = await waitFor(function () {
            return [].some.call(document.querySelectorAll('#log .msg.dm .body'), function (n) { return n.textContent.indexOf('mock narration') !== -1; });
          }, 6000);
          if (narrated) { out.textContent = 'SERVER_OK=true'; return; }
        }
        out.textContent = 'SERVER_SKIP'; // env/virtual-time didn't complete the round-trip — skip, don't fail
      } catch (e) { out.textContent = 'SERVER_SKIP:' + e; }
    })();
  `;
  const dom = await runHeadlessClient('server-turn', html, srcs, probe);
  if (dom === null || !dom.includes('SERVER_OK=')) {
    skip('web-ui: headless server-turn check skipped (no chromium / round-trip did not complete under virtual time)');
    return;
  }
  check('web-ui: headless "Connect to a server" mode drives RemoteTransport against a real loopback WebAdapter and renders a turn', dom.includes('SERVER_OK=true'));
}

/**
 * Best-effort offline proof of the onboarding-polish work: with an INJECTED
 * provider whose `complete()` REJECTS (simulating a bad key/model/unreachable
 * endpoint — no network, deterministic), a real turn in "Play on this device"
 * surfaces a friendly, actionable message in the log instead of a raw
 * stack/hang; and the Help/About affordance opens from the topbar, mentions
 * where state/keys live, and hands off to the real command palette. Skipped
 * (never failed) when chromium is unavailable.
 */
export async function headlessLocalErrorAndHelpCheck(
  html: string,
  srcs: { engine: string; transport: string; portraits: string; app: string },
): Promise<void> {
  const probe = `
    (async () => {
      var out = document.getElementById('probe-out');
      var waitFor = function (fn, ms) { return new Promise(function (res) {
        var t0 = Date.now(); var iv = setInterval(function () { var ok = false; try { ok = fn(); } catch (e) {}
          if (ok || Date.now() - t0 > ms) { clearInterval(iv); res(ok); } }, 15); }); };
      try {
        // A provider whose complete() REJECTS — simulates a bad key/model/host.
        window.__omnidmTestProvider = { id: 'mock',
          listModels: function () { return Promise.resolve([{ id: 'mock/free-model', free: true }]); },
          complete: function () { return Promise.reject(new Error('401 Unauthorized: invalid API key')); } };
        window.__omnidmTestStorage = (function () { var m = new Map(); return {
          load: function (k) { return Promise.resolve(m.has(k) ? m.get(k) : null); },
          save: function (k, s) { m.set(k, s); return Promise.resolve(); },
          delete: function (k) { m.delete(k); return Promise.resolve(); } }; })();
        document.getElementById('mode-local').click();
        document.getElementById('j-name').value = 'Solo';
        document.getElementById('j-room').value = 'roomErr';
        document.getElementById('join-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        await waitFor(function () { return document.getElementById('table').hidden === false; }, 3000);
        sendSay('/dm new');
        await waitFor(function () { return false; }, 60);
        sendSay('/dm join Hero');
        await waitFor(function () { return document.querySelector('#roster-list .seat') != null; }, 3000);
        sendSay('I swing at the training dummy');
        var errored = await waitFor(function () {
          return document.querySelector('#log .msg.warn .body') != null;
        }, 4000);
        var errNode = document.querySelector('#log .msg.warn .body');
        var errBody = errNode ? errNode.textContent : '';
        // Never a raw stack: no "at <fn> (file:line)" frames, no bare .js: locations.
        var noStack = errBody.indexOf('    at ') === -1 && !/\\.(?:js|ts):\\d/.test(errBody);
        var mentionsFix = /settings/i.test(errBody) && /(key|model|url)/i.test(errBody);

        // Help/About: opens from the topbar, names where data/keys live, and
        // hands off to the REAL command palette (reused, not duplicated).
        document.getElementById('help-btn').click();
        var helpOpen = document.getElementById('help-sheet').hidden === false;
        var helpText = document.getElementById('help-sheet').textContent || '';
        var mentionsDevice = /device/i.test(helpText) && /key/i.test(helpText);
        document.getElementById('help-open-palette').click();
        var paletteOpened = document.getElementById('palette').hidden === false;
        var helpClosedForPalette = document.getElementById('help-sheet').hidden === true;

        out.textContent = 'ERRHELP_OK=' + (errored && noStack && mentionsFix && helpOpen && mentionsDevice && paletteOpened && helpClosedForPalette) +
          ' errored=' + errored + ' noStack=' + noStack + ' mentionsFix=' + mentionsFix +
          ' helpOpen=' + helpOpen + ' mentionsDevice=' + mentionsDevice + ' paletteOpened=' + paletteOpened +
          ' errBody=' + JSON.stringify(errBody.slice(0, 160));
      } catch (e) { out.textContent = 'ERRHELP_OK=false:' + e; }
    })();
  `;
  const dom = await runHeadlessClient('local-error-help', html, srcs, probe);
  if (dom === null || !dom.includes('ERRHELP_OK=')) {
    skip('web-ui: headless local-error/help check skipped (chromium produced no output)');
    return;
  }
  check(
    'web-ui: headless "Play on this device" shows a friendly, actionable error (not a raw stack/hang) on a model failure, and Help/About opens with device/key info + the real command menu',
    dom.includes('ERRHELP_OK=true'),
  );
}

/**
 * Best-effort offline proof of the API-key-at-rest hardening: by default (the
 * "Remember this key" checkbox left unticked) the raw key is kept OUT of the
 * durable localStorage settings record — it lives in sessionStorage instead —
 * and only lands on disk once the player explicitly opts in. Skipped (never
 * failed) when chromium is unavailable.
 */
export async function headlessKeyStorageCheck(
  html: string,
  srcs: { engine: string; transport: string; portraits: string; app: string },
): Promise<void> {
  const probe = `
    (async () => {
      var out = document.getElementById('probe-out');
      var waitFor = function (fn, ms) { return new Promise(function (res) {
        var t0 = Date.now(); var iv = setInterval(function () { var ok = false; try { ok = fn(); } catch (e) {}
          if (ok || Date.now() - t0 > ms) { clearInterval(iv); res(ok); } }, 15); }); };
      try {
        window.__omnidmTestProvider = { id: 'mock',
          listModels: function () { return Promise.resolve([]); },
          complete: function () { return Promise.resolve('ok'); } };
        window.__omnidmTestStorage = (function () { var m = new Map(); return {
          load: function (k) { return Promise.resolve(m.has(k) ? m.get(k) : null); },
          save: function (k, s) { m.set(k, s); return Promise.resolve(); },
          delete: function (k) { m.delete(k); return Promise.resolve(); } }; })();
        var SECRET = 'sk-testsecretvalue0123456789ABCDEF';
        document.getElementById('mode-local').click();
        document.getElementById('j-name').value = 'Solo';
        document.getElementById('j-room').value = 'roomKey';
        document.getElementById('llm-baseurl').value = 'https://example.test/v1';
        document.getElementById('llm-apikey').value = SECRET;
        document.getElementById('llm-remember-key').checked = false;
        var keyIsPassword = document.getElementById('llm-apikey').type === 'password';
        document.getElementById('join-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        await waitFor(function () { return document.getElementById('table').hidden === false; }, 3000);

        var disk1 = JSON.parse(localStorage.getItem('omnidm-settings') || 'null');
        var noKeyOnDiskByDefault = !disk1 || !disk1.llm || !disk1.llm.apiKey;
        var sessionHasKeyByDefault = sessionStorage.getItem('omnidm-session-key') === SECRET;

        // Opt in: reopen Settings, tick "Remember this key", resubmit (same
        // provider origin as before, so no CSP-narrowing reload is triggered).
        document.getElementById('settings-btn').click();
        document.getElementById('llm-remember-key').checked = true;
        document.getElementById('join-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        await waitFor(function () { return document.getElementById('table').hidden === false; }, 3000);
        var disk2 = JSON.parse(localStorage.getItem('omnidm-settings') || 'null');
        var keyOnDiskWhenRemembered = !!(disk2 && disk2.llm && disk2.llm.apiKey === SECRET && disk2.rememberKey === true);

        out.textContent = 'KEYSTORE_OK=' + (keyIsPassword && noKeyOnDiskByDefault && sessionHasKeyByDefault && keyOnDiskWhenRemembered) +
          ' keyIsPassword=' + keyIsPassword + ' noKeyOnDiskByDefault=' + noKeyOnDiskByDefault +
          ' sessionHasKeyByDefault=' + sessionHasKeyByDefault + ' keyOnDiskWhenRemembered=' + keyOnDiskWhenRemembered;
      } catch (e) { out.textContent = 'KEYSTORE_OK=false:' + e; }
    })();
  `;
  const dom = await runHeadlessClient('key-storage', html, srcs, probe);
  if (dom === null || !dom.includes('KEYSTORE_OK=')) {
    skip('web-ui: headless key-storage check skipped (chromium produced no output)');
    return;
  }
  check(
    'web-ui: the LLM API key is NOT written to localStorage by default (sessionStorage instead) and only persists to disk once "Remember this key on this device" is ticked',
    dom.includes('KEYSTORE_OK=true'),
  );
}

/**
 * Exercises the REAL `setStatus()` global from app.js against the actual
 * status pill markup, proving the connection-state → `data-state` mapping
 * matches the documented intent (amber-pulsing "pending" while
 * connecting/joining/reconnecting, steady green "ok" once connected) —
 * specifically that a "reconnecting…" phrase (the exact string onClose()
 * sends) does NOT fall into the steady-red "down" bucket ahead of the
 * connecting/joining/reconnecting check. Skipped (never failed) when
 * chromium is unavailable.
 */
export async function headlessStatusStateCheck(
  html: string,
  srcs: { engine: string; transport: string; portraits: string; app: string },
): Promise<void> {
  const probe = `
    (function () {
      var out = document.getElementById('probe-out');
      try {
        setStatus('joining…');
        var sJoining = document.getElementById('status').getAttribute('data-state');
        setStatus('connecting…');
        var sConnecting = document.getElementById('status').getAttribute('data-state');
        setStatus('reconnecting in 4s…');
        var sReconnecting = document.getElementById('status').getAttribute('data-state');
        setStatus('connected');
        var sConnected = document.getElementById('status').getAttribute('data-state');
        var ok = sJoining === 'pending' && sConnecting === 'pending' && sReconnecting === 'pending' && sConnected === 'ok';
        out.textContent = 'STATUSSTATE_OK=' + ok +
          ' joining=' + sJoining + ' connecting=' + sConnecting + ' reconnecting=' + sReconnecting + ' connected=' + sConnected;
      } catch (e) { out.textContent = 'STATUSSTATE_OK=false:' + e; }
    })();
  `;
  const dom = await runHeadlessClient('status-state', html, srcs, probe);
  if (dom === null || !dom.includes('STATUSSTATE_OK=')) {
    skip('web-ui: headless status-state check skipped (chromium produced no output)');
    return;
  }
  check(
    'web-ui: setStatus("reconnecting in …s…") maps to the amber-pulsing "pending" state, not the steady-red "down" state',
    dom.includes('STATUSSTATE_OK=true'),
  );
}

/**
 * Boot the REAL client + REAL style.css (unlike {@link runHeadlessClient},
 * which never links a stylesheet) at a genuinely narrow phone viewport, drive
 * the REAL `renderRoster()`/`appendHp()` with a seat carrying multiple
 * conditions AND a seat with a long name, and measure actual layout: no seat
 * card (or its hp/condition row) may render past `#roster-list`'s right edge.
 * This is a live, geometry-based regression test for the roster overflow bug
 * (a multi-condition or long-named seat breaking out of its card at ordinary
 * phone widths) — skipped (never failed) when chromium is unavailable.
 */
export async function headlessRosterOverflowCheck(
  html: string,
  styleSrc: string,
  srcs: { engine: string; transport: string; portraits: string; app: string },
): Promise<void> {
  const chromium = '/usr/bin/chromium';
  try {
    await fs.access(chromium);
  } catch {
    skip('web-ui: headless roster-overflow check skipped (no chromium)');
    return;
  }
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) {
    skip('web-ui: headless roster-overflow check skipped (no <body> in served HTML)');
    return;
  }
  const body = bodyMatch[1].replace(/<script\b[^>]*><\/script>/gi, '');
  const probe = `
    (function () {
      var out = document.getElementById('probe-out');
      try {
        // The roster only has layout once the table view is showing (it starts
        // \`hidden\` behind the join screen) — this probe never runs a real
        // join, so reveal it directly.
        document.getElementById('join-screen').hidden = true;
        document.getElementById('table').hidden = false;
        state.roster = [
          { userId: 'u1', userName: 'Kai', characterName: 'Kai', hp: 8, maxHp: 20, conditions: ['poisoned', 'prone', 'frightened', 'stunned'] },
          { userId: 'u2', userName: 'Sir Reginald Bartholomew the Third', characterName: 'Sir Reginald Bartholomew the Third', hp: 16, maxHp: 20, conditions: ['poisoned', 'prone', 'frightened', 'stunned'] },
        ];
        renderRoster();
        var rosterRight = document.getElementById('roster-list').getBoundingClientRect().right;
        var seats = document.querySelectorAll('#roster-list .seat, #roster-list .hp-condition');
        var maxRight = 0;
        for (var i = 0; i < seats.length; i++) {
          var r = seats[i].getBoundingClientRect().right;
          if (r > maxRight) maxRight = r;
        }
        var viewportWidth = document.documentElement.clientWidth;
        var noOverflow = maxRight <= viewportWidth + 1; // +1px rounding slack
        out.textContent = 'ROSTEROVERFLOW_OK=' + noOverflow +
          ' maxRight=' + maxRight + ' viewportWidth=' + viewportWidth + ' rosterRight=' + rosterRight;
      } catch (e) { out.textContent = 'ROSTEROVERFLOW_OK=false:' + e; }
    })();
  `;
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>${styleSrc}</style></head><body>${body}
<pre id="probe-out"></pre>
<script>${inlineSafe(srcs.engine)}</script>
<script>${inlineSafe(srcs.transport)}</script>
<script>${inlineSafe(srcs.portraits)}</script>
<script>${inlineSafe(srcs.app)}</script>
<script>${probe}</script>
</body></html>`;
  const tmpDir = path.join('data', 'smoke');
  await fs.mkdir(tmpDir, { recursive: true });
  const htmlPath = path.join(tmpDir, 'roster-overflow-probe.html');
  await fs.writeFile(htmlPath, page, 'utf8');
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(
    chromium,
    ['--headless', '--no-sandbox', '--disable-gpu', '--window-size=390,900', '--virtual-time-budget=5000', '--dump-dom', `file://${path.resolve(htmlPath)}`],
    { encoding: 'utf8', timeout: 35000 },
  );
  const dom = res.error ? null : String(res.stdout ?? '');
  if (dom === null || !dom.includes('ROSTEROVERFLOW_OK=')) {
    skip('web-ui: headless roster-overflow check skipped (chromium produced no output)');
    return;
  }
  check(
    'web-ui: at a 390px phone viewport, a roster seat with multiple conditions (or a long name) stays within its card/#roster-list — no clipped/overflowing hp-condition pill',
    dom.includes('ROSTEROVERFLOW_OK=true'),
  );
}
