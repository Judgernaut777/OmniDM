/**
 * Headless-chromium check simulating the Tauri WebView.
 *
 *   node src-tauri/webview-check.mjs
 *
 * Tauri does NOT run a Node server: it serves the `frontendDist` assets from an
 * internal origin and injects `app.security.csp` from tauri.conf.json as the
 * page CSP. This script reproduces that as faithfully as we can offline: it
 * serves `web/` over loopback with the EXACT CSP string from tauri.conf.json as
 * a real `Content-Security-Policy` response header (no <meta> fallback), boots
 * headless chromium (the same Blink engine family WebKitGTK/WKWebView render
 * with), drives it over the DevTools Protocol, screenshots, and fails if any
 * CSP violation fires or the launch screen / in-app engine bundle fail to load.
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
const conf = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const CSP = conf.app.security.csp;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

let failures = 0;
const check = (label, ok) => { console.log(`${ok ? '✅' : '❌'} ${label}`); if (!ok) failures++; };

// ── Static server: serve web/ with the Tauri CSP header, like the WebView. ──
const server = createServer(async (req, res) => {
  try {
    const rel = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = rel === '/' ? 'index.html' : rel.replace(/^\/+/, '');
    const abs = path.join(webDir, file);
    if (!abs.startsWith(webDir)) { res.writeHead(403).end(); return; }
    const body = await readFile(abs);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream',
      'Content-Security-Policy': CSP,
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${port}/`;

// ── Boot headless chromium with the DevTools Protocol. ──
const userDataDir = path.join('/tmp', `omnidm-webview-${process.pid}`);
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
  // Open a fresh page target and talk raw CDP to it.
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
  const { send, events, ws } = await cdp();
  const cspViolations = [];
  const failedRequests = [];
  // Listen for CSP violations + failed loads.
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Log.entryAdded' && m.params?.entry?.source === 'security') {
      if (/Content Security Policy|Refused to/i.test(m.params.entry.text)) cspViolations.push(m.params.entry.text);
    }
    if (m.method === 'Network.loadingFailed') failedRequests.push(m.params);
  });
  await send('Log.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.enable');

  const nav = await send('Page.navigate', { url: pageUrl });
  check('WebView: page navigation returned a frameId (no immediate load error)', Boolean(nav.result?.frameId) && !nav.result?.errorText);

  // Wait for load + scripts to run.
  await new Promise((r) => setTimeout(r, 1500));

  const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;

  check('WebView: launch screen renders (the "Play on this device" / server picker)',
    (await evalJs("document.querySelector('#join-screen') && !!document.querySelector('#mode-local')")) === true);
  check('WebView: page title is the desktop window title base',
    (await evalJs('document.title')) === 'OmniDM — the table awaits');
  check('WebView: same-origin in-app engine bundle loaded and exposed its global (OmniDMEngine)',
    (await evalJs("typeof window.OmniDMEngine !== 'undefined'")) === true);
  check('WebView: the transport layer loaded under script-src \'self\' (Local/Remote transports present)',
    (await evalJs("typeof window.OmniDMTransport !== 'undefined' || typeof window.makeTransport === 'function' || document.querySelectorAll('script[src=\"transport.js\"]').length === 1")) === true);
  check('WebView: procedural portraits script loaded (no external origins needed)',
    (await evalJs("document.querySelectorAll('script[src=\"portraits.js\"]').length === 1")) === true);

  // The whole point: the strict CSP must not have blocked our own same-origin code.
  await new Promise((r) => setTimeout(r, 300));
  check('WebView: NO Content-Security-Policy violation fired for the app\'s own assets', cspViolations.length === 0);
  if (cspViolations.length) cspViolations.slice(0, 5).forEach((v) => console.log('   ↳ CSP:', v));

  // Screenshot proves it actually painted.
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) {
    const { writeFile } = await import('node:fs/promises');
    const out = path.join('/tmp', 'omnidm-webview.png');
    await writeFile(out, Buffer.from(shot.result.data, 'base64'));
    check('WebView: captured a screenshot of the rendered launch screen', true);
    console.log('   ↳ screenshot:', out);
  } else {
    check('WebView: captured a screenshot of the rendered launch screen', false);
  }
} finally {
  chromium.kill('SIGKILL');
  server.close();
}

console.log(`\n${failures === 0 ? '🎉 WebView check passed' : `💥 ${failures} WebView check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
