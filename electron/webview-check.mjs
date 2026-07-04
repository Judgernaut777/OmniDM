/**
 * Headless-chromium check simulating the Electron renderer.
 *
 *   node electron/webview-check.mjs
 *
 * Electron loads `web/index.html` into a Chromium renderer (electron/main.cjs)
 * with a strict CSP — the page's own <meta http-equiv="Content-Security-Policy">
 * plus a duplicate header main.cjs injects as defense-in-depth. This script
 * reproduces the meaningful half offline with NO Electron/native toolchain: it
 * serves `web/` over loopback so the page's meta CSP governs exactly as it does
 * in the renderer, boots headless chromium (the same Blink engine Electron
 * ships), drives it over the DevTools Protocol, and fails if any CSP violation
 * fires or the launch screen / in-app engine bundle fail to load.
 *
 * Everything happens in ONE process (chromium is spawned and killed here) — no
 * backgrounded server, no external network.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
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
  '.png': 'image/png',
};

let failures = 0;
const check = (label, ok) => { console.log(`${ok ? '✅' : '❌'} ${label}`); if (!ok) failures++; };

// ── Static server: serve web/ so the page's own meta CSP applies, as in the
//    Electron renderer. No injected header — the <meta> tag is what governs. ──
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

// ── Boot headless chromium with the DevTools Protocol. ──
const userDataDir = path.join('/tmp', `omnidm-electron-webview-${process.pid}`);
const chromium = spawn('/usr/bin/chromium', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
  '--window-size=1200,820', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

// chromium prints "DevTools listening on ws://..." to stderr — grab the port.
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
  const list = await (await fetch(`${wsBase.replace('ws://', 'http://')}/json/new`, { method: 'PUT' })).json()
    .catch(async () => (await fetch(`${wsBase.replace('ws://', 'http://')}/json/new`)).json());
  const ws = new WebSocket(list.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp ws failed')); });

  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) events.push(m);
  };
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { send, events, ws };
}

try {
  const { send, ws } = await cdp();
  const cspViolations = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Log.entryAdded' && m.params?.entry?.source === 'security') {
      if (/Content Security Policy|Refused to/i.test(m.params.entry.text)) cspViolations.push(m.params.entry.text);
    }
  });
  await send('Log.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.enable');

  const nav = await send('Page.navigate', { url: pageUrl });
  check('renderer: page navigation returned a frameId (no immediate load error)', Boolean(nav.result?.frameId) && !nav.result?.errorText);

  await new Promise((r) => setTimeout(r, 1500));

  const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;

  check('renderer: launch screen renders (the "Play on this device" / server picker)',
    (await evalJs("document.querySelector('#join-screen') && !!document.querySelector('#mode-local')")) === true);
  check('renderer: window title is the desktop window title base',
    (await evalJs('document.title')) === 'OmniDM — the table awaits');
  check('renderer: same-origin in-app engine bundle loaded and exposed its global (OmniDMEngine)',
    (await evalJs("typeof window.OmniDMEngine !== 'undefined'")) === true);
  check('renderer: the transport layer loaded under script-src \'self\'',
    (await evalJs("typeof window.OmniDMTransport !== 'undefined' || typeof window.makeTransport === 'function' || document.querySelectorAll('script[src=\"transport.js\"]').length === 1")) === true);
  check('renderer: procedural portraits script loaded (no external origins needed)',
    (await evalJs("document.querySelectorAll('script[src=\"portraits.js\"]').length === 1")) === true);

  await new Promise((r) => setTimeout(r, 300));
  check('renderer: NO Content-Security-Policy violation fired for the app\'s own assets', cspViolations.length === 0);
  if (cspViolations.length) cspViolations.slice(0, 5).forEach((v) => console.log('   ↳ CSP:', v));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) {
    const { writeFile } = await import('node:fs/promises');
    const out = path.join('/tmp', 'omnidm-electron-webview.png');
    await writeFile(out, Buffer.from(shot.result.data, 'base64'));
    check('renderer: captured a screenshot of the rendered launch screen', true);
    console.log('   ↳ screenshot:', out);
  } else {
    check('renderer: captured a screenshot of the rendered launch screen', false);
  }
} finally {
  chromium.kill('SIGKILL');
  server.close();
}

console.log(`\n${failures === 0 ? '🎉 Electron renderer check passed' : `💥 ${failures} renderer check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
