/**
 * Headless-chromium check simulating the Capacitor NATIVE mobile WebView.
 *
 *   node capacitor/webview-check.mjs
 *
 * On iOS/Android the app is a native WebView (WKWebView / Android System WebView —
 * the same Blink/WebKit engine family) that loads the committed `web/` client and
 * runs the AI-DM engine IN the WebView (the hybrid model). The Capacitor native
 * runtime injects a `window.Capacitor` global; when the CapacitorHttp plugin is
 * enabled it exposes `Capacitor.Plugins.CapacitorHttp`, and the in-app provider
 * routes its LLM HTTP through it to bypass the WebView's CORS check.
 *
 * This reproduces that offline as faithfully as we can: it serves `web/` over
 * loopback (the page's own <meta> CSP governs, exactly as on device), then — via
 * the DevTools Protocol — INJECTS a simulated native `window.Capacitor` with a
 * CapacitorHttp stub BEFORE any page script runs, boots headless chromium, and
 * drives a FULL in-app turn (new → join → action) through the REAL bundled
 * `OmniDMEngine`. It asserts the engine detected the native platform, routed the
 * provider's LLM call through the CapacitorHttp stub (NOT a browser fetch — no
 * network, no CORS), and rendered the stub's narration. One process; chromium is
 * spawned and killed here; no external network, no API key.
 */
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const webDir = path.join(root, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

let failures = 0;
const check = (label, ok) => { console.log(`${ok ? '✅' : '❌'} ${label}`); if (!ok) failures++; };

// ── Static server: serve web/ as the WebView origin (page <meta> CSP governs). ──
const server = createServer(async (req, res) => {
  try {
    const rel = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = rel === '/' ? 'index.html' : rel.replace(/^\/+/, '');
    const abs = path.join(webDir, file);
    if (!abs.startsWith(webDir)) { res.writeHead(403).end(); return; }
    const body = await readFile(abs);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${port}/`;

// The simulated Capacitor native runtime, injected before the page's scripts. The
// CapacitorHttp stub answers the Anthropic endpoint with a canned narration and
// records every call, so we can prove the LLM request went native (no fetch).
const NATIVE_SHIM = `
  window.__capCalls = [];
  window.Capacitor = {
    isNativePlatform: function () { return true; },
    getPlatform: function () { return 'ios'; },
    Plugins: {
      CapacitorHttp: {
        request: async function (o) {
          window.__capCalls.push({ url: o.url, method: o.method, hasKey: !!(o.headers && (o.headers['x-api-key'] || o.headers['X-Api-Key'])) });
          if (String(o.url).indexOf('/v1/messages') !== -1) {
            return { status: 200, headers: { 'content-type': 'application/json' },
                     data: JSON.stringify({ content: [{ type: 'text', text: 'NATIVE-WEBVIEW-NARRATION' }] }) };
          }
          return { status: 404, headers: {}, data: 'no' };
        }
      }
    }
  };
`;

// ── Boot headless chromium with the DevTools Protocol. ──
const userDataDir = path.join('/tmp', `omnidm-cap-webview-${process.pid}`);
const chromium = spawn('/usr/bin/chromium', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
  '--window-size=430,932', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const wsBase = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('chromium did not report a DevTools endpoint')), 15000);
  let buf = '';
  chromium.stderr.on('data', (d) => {
    buf += d.toString();
    const m = buf.match(/ws:\/\/[^\s]+\/devtools\/browser\/[a-f0-9-]+/);
    if (m) { clearTimeout(t); resolve(m[0].replace(/\/devtools\/browser\/.*$/, '')); }
  });
  chromium.on('exit', (c) => { clearTimeout(t); reject(new Error(`chromium exited early (${c})`)); });
});

async function cdp() {
  const httpBase = wsBase.replace('ws://', 'http://');
  const list = await (await fetch(`${httpBase}/json/new`, { method: 'PUT' })).json()
    .catch(async () => (await fetch(`${httpBase}/json/new`)).json());
  const ws = new WebSocket(list.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp ws failed')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id; pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { send, ws };
}

try {
  const { send, ws } = await cdp();
  const cspViolations = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Log.entryAdded' && m.params?.entry?.source === 'security' &&
        /Content Security Policy|Refused to/i.test(m.params.entry.text || '')) {
      cspViolations.push(m.params.entry.text);
    }
  });
  await send('Log.enable');
  await send('Runtime.enable');
  await send('Page.enable');
  // Inject the native Capacitor runtime BEFORE any page script evaluates.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: NATIVE_SHIM });

  const nav = await send('Page.navigate', { url: pageUrl });
  check('WebView: page navigation returned a frameId (no immediate load error)',
    Boolean(nav.result?.frameId) && !nav.result?.errorText);
  await new Promise((r) => setTimeout(r, 1500));

  const evalJs = async (expression, awaitPromise = false) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })).result?.result?.value;

  check('WebView: launch screen renders with the "Play on this device" picker',
    (await evalJs("!!document.querySelector('#join-screen') && !!document.querySelector('#mode-local')")) === true);
  check('WebView: the in-app engine bundle loaded and exposed OmniDMEngine (same-origin, no CDN)',
    (await evalJs("typeof window.OmniDMEngine !== 'undefined' && typeof window.OmniDMEngine.createLocalEngine === 'function'")) === true);
  check('WebView: the simulated Capacitor native runtime is present (isNativePlatform → true)',
    (await evalJs("!!window.Capacitor && window.Capacitor.isNativePlatform() === true")) === true);

  // The core assertion: build the REAL in-app engine with an Anthropic config and
  // drive a full solo turn. The bundle's own selectFetch() must see window.Capacitor
  // and route the provider through CapacitorHttp — so the narration must come from
  // the stub and __capCalls must record the native /v1/messages POST (with the key).
  const driver = `(async () => {
    const frames = [];
    const conn = { send: (f) => frames.push(f), close: () => {} };
    const engine = window.OmniDMEngine.createLocalEngine({
      llm: { provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-webview-secret', model: 'claude-opus-4-8' },
      platform: 'cap-check',
    });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    engine.room.handleFrame(conn, { type: 'hello', userName: 'Solo', channelId: 'capttest' });
    await wait(30);
    engine.room.handleFrame(conn, { type: 'say', text: '/dm new' }); await wait(30);
    engine.room.handleFrame(conn, { type: 'say', text: '/dm join Kaelen' }); await wait(30);
    engine.room.handleFrame(conn, { type: 'say', text: 'I strike the training dummy' }); await wait(80);
    const dm = [...frames].reverse().find((f) => f.type === 'msg' && f.speaker === 'Dungeon Master');
    return { dmText: dm ? String(dm.text) : null, calls: window.__capCalls };
  })()`;
  const result = await evalJs(driver, true);

  check('WebView: a full in-app turn ran end-to-end and produced a DM narration frame',
    Boolean(result && result.dmText));
  check('WebView: the DM narration came from the NATIVE CapacitorHttp stub (not a browser fetch)',
    Boolean(result && result.dmText && result.dmText.includes('NATIVE-WEBVIEW-NARRATION')));
  const call = result?.calls?.find((c) => String(c.url).includes('/v1/messages'));
  check('WebView: the LLM request went through CapacitorHttp to /v1/messages (POST) — CORS bypassed',
    Boolean(call) && call.method === 'POST');
  check('WebView: the user API key rode only in the native request headers (secret to the endpoint)',
    Boolean(call) && call.hasKey === true);
  check('WebView: NO Content-Security-Policy violation fired for the app own assets',
    cspViolations.length === 0);
  if (cspViolations.length) cspViolations.slice(0, 5).forEach((v) => console.log('   ↳ CSP:', v));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) {
    const out = path.join('/tmp', 'omnidm-cap-webview.png');
    await writeFile(out, Buffer.from(shot.result.data, 'base64'));
    check('WebView: captured a screenshot of the rendered mobile launch screen', true);
    console.log('   ↳ screenshot:', out);
  } else {
    check('WebView: captured a screenshot of the rendered mobile launch screen', false);
  }
} finally {
  chromium.kill('SIGKILL');
  server.close();
}

console.log(`\n${failures === 0 ? '🎉 Capacitor WebView check passed' : `💥 ${failures} WebView check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
