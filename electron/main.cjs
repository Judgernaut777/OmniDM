// OmniDM desktop shell — Electron main process.
//
// This is the pragmatic desktop path: it bundles Chromium, so it builds and
// runs without root and without system WebKit libs (unlike the Tauri scaffold
// in src-tauri/, which is kept too but needs webkit2gtk on Linux). Same
// hybrid model as Tauri/Capacitor: there is no Node sidecar and no bridge API
// exposed to the page — the renderer just loads web/index.html and the
// in-app engine (web/engine.bundle.js) runs entirely inside that untrusted
// renderer, exactly as it does in a browser tab. The user's LLM API key
// therefore reaches this process the same way it reaches a browser: never —
// it lives only in the renderer's memory/localStorage and is sent only to
// the configured provider endpoint over network the renderer itself opens.
//
// Hardening (Electron security checklist, applied to every window):
//   - contextIsolation: true   — the page's JS world is isolated from Electron/preload internals.
//   - nodeIntegration: false   — no `require`, no Node globals, reachable from the page.
//   - sandbox: true            — the renderer runs in Chromium's OS sandbox like a real browser tab.
//   - no preload script        — nothing is exposed on window.* for the page to call into.
//   - webSecurity stays on (default) — same-origin/CSP enforcement is not disabled.
//   - only a local file is ever loaded — no remote URL is ever passed to loadURL/loadFile.
//   - window.open / will-navigate are intercepted — any external link (the
//     user's LLM host, a help/README link, etc.) opens in the OS browser via
//     shell.openExternal, never inside this app's Chromium, and only for an
//     http(s)/mailto URL — a file:/smb:/custom-protocol target (which could
//     launch a local app or reach a network share) is refused outright.
'use strict';

const path = require('node:path');
const { app, BrowserWindow, Menu, session, shell } = require('electron');

// This file is package.json "main" (so electron-builder knows the entry point),
// which also makes it the target of `node .`. Under plain Node, require('electron')
// resolves to a path string, not the API — fail with a clear message instead of a
// confusing `Cannot read properties of undefined` deep in app.setName().
if (!app || typeof app.setName !== 'function') {
  console.error(
    'OmniDM: electron/main.cjs is the Electron entry point — run it with Electron, not plain Node.\n' +
    'Use `npm run electron` (dev window) or `npm run electron:build` (package for distribution).',
  );
  process.exit(1);
}

const APP_NAME = 'OmniDM';
app.setName(APP_NAME);

// The exact file this app is ever allowed to load. Anything else — including
// a navigation the page itself tries to trigger — is refused in-app.
const INDEX_FILE = path.join(__dirname, '..', 'web', 'index.html');
const INDEX_URL = `file://${INDEX_FILE.replace(/\\/g, '/')}`;

// Mirrors the STATIC parts of the <meta http-equiv="Content-Security-Policy">
// in web/index.html. The page's own meta CSP is normally what Chromium
// enforces for a file:// document, but we also set the header via webRequest
// as defense-in-depth (and so the policy holds even if the page were ever
// served without the meta tag).
//
// connect-src narrowing: same problem and same fix as web/index.html documents
// for the plain browser case (see that file) — a blanket `https:` is needed so
// ANY user-chosen provider endpoint keeps working, but it also means an XSS
// bug could exfiltrate the key to any https host. Electron has ONE extra tool
// the plain page doesn't: main can read the renderer's OWN persisted settings
// with `webContents.executeJavaScript` (a normal Electron API the main process
// already has power to use — not a bridge, and nothing is added to window.*
// for the page to call into, unlike the preload this app deliberately has
// none of) and use that to learn the actual configured provider origin. It
// can't do this BEFORE the very first navigation (nothing has been saved
// yet), so: the first launch — or any launch before the player has saved
// settings — still gets the safe, broad `https:` fallback below. Once the
// window has loaded, main reads localStorage once, and if a real (non-
// loopback) provider origin is found, reloads the window ONE time so the
// header on that fresh navigation is narrowed to same-origin + loopback +
// that exact origin only. (A CSP header, like a <meta> one, only ever gets
// STRICTER for the life of a document — hence the reload, a fresh navigation,
// rather than trying to mutate an already-delivered policy in place.)
let learnedProviderOrigin = null;
let cspNarrowAttempted = false; // at most one learn from storage / narrowing reload per launch

/** Same-shape origin resolution as web/app.js's computeProviderOrigin, so
 * main and the renderer agree on what "the configured provider" means. */
function computeProviderOrigin(llm) {
  if (!llm || typeof llm !== 'object') return null;
  const baseUrl = typeof llm.baseUrl === 'string' ? llm.baseUrl : '';
  const isAnthropic = llm.provider === 'anthropic' || /anthropic\.com/i.test(baseUrl);
  const raw = isAnthropic
    ? (/anthropic\.com/i.test(baseUrl) ? baseUrl : 'https://api.anthropic.com')
    : (baseUrl || 'https://openrouter.ai/api/v1');
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  // Loopback endpoints (Ollama, LM Studio) are already covered by the
  // unconditional http://localhost:* / http://127.0.0.1:* allowance below.
  if (/^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0)$/i.test(u.hostname)) return null;
  return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
}

function buildCsp() {
  const connectExtra = learnedProviderOrigin || 'https:';
  return (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    `img-src 'self' data: https:; connect-src 'self' ws: wss: ${connectExtra} ` +
    "http://localhost:* http://127.0.0.1:*; object-src 'none'; base-uri 'none'; form-action 'none'"
  );
}

/** Is this a URL we already trust and load ourselves (the local app shell)? */
function isAppUrl(url) {
  return url === INDEX_URL || url.startsWith(`${INDEX_URL}#`) || url.startsWith(`${INDEX_URL}?`);
}

// Every "external" URL (a clicked link, window.open target, etc. — always
// untrusted: rendered LLM output or a hostile character card can contain one)
// is handed to the OS via shell.openExternal, which on some platforms will
// happily hand a file:/smb:/custom-protocol URL to a registered handler —
// launching a local application or reaching a network share instead of just
// opening a browser tab. Restrict to the schemes an "open this link" affordance
// is actually meant for.
const SAFE_EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** Only http(s)/mailto ever reach shell.openExternal — file:/smb:/custom
 * schemes (or anything unparseable) are silently refused. */
function openExternalIfSafe(url) {
  let scheme;
  try {
    scheme = new URL(url).protocol;
  } catch {
    return;
  }
  if (!SAFE_EXTERNAL_SCHEMES.has(scheme)) {
    console.warn(`OmniDM: refused to open external URL with disallowed scheme: ${scheme}`);
    return;
  }
  void shell.openExternal(url);
}

/** Learn the configured provider origin (once) and reload so the CSP header
 * narrows to it. Best-effort in every direction: any failure just leaves the
 * safe broad-`https:` default in place — never breaks the real LLM call. */
function tryNarrowConnectSrc(win) {
  if (cspNarrowAttempted) return;
  cspNarrowAttempted = true;
  win.webContents
    .executeJavaScript(
      "(function () { try { return localStorage.getItem('omnidm-settings'); } catch (e) { return null; } })()",
      true,
    )
    .then((raw) => {
      if (!raw) return;
      let settings;
      try {
        settings = JSON.parse(raw);
      } catch {
        return;
      }
      const origin = computeProviderOrigin(settings && settings.llm);
      if (!origin || win.isDestroyed()) return;
      learnedProviderOrigin = origin;
      win.webContents.reload();
    })
    .catch(() => { /* best effort — keep the safe broad default */ });
}

function hardenSession(ses) {
  // Defense-in-depth CSP header, alongside the page's own meta CSP. Computed
  // fresh each time so a narrowing reload (see tryNarrowConnectSrc) takes effect.
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [buildCsp()],
      },
    });
  });

  // Untrusted page content (rendered LLM output, a hostile character card,
  // etc.) never gets to ask for camera/mic/geolocation/notifications/etc.
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 880,
    minHeight: 600,
    title: `${APP_NAME} — the table awaits`,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      preload: undefined, // no bridge script — nothing is exposed to the page
    },
  });

  win.removeMenu();

  // Navigation / window-open / webview guards are installed ONCE, at module
  // scope, via the single `app.on('web-contents-created', …)` below — it fires
  // for this window's webContents too, so registering them here as well would
  // double every handler (two shell.openExternal calls per external link) and
  // leak a new app-level listener on each window (re)creation.
  win.webContents.once('did-finish-load', () => tryNarrowConnectSrc(win));
  void win.loadFile(INDEX_FILE);
  return win;
}

// A minimal menu (no default Electron menu with dev-only items exposed to a
// shipped build), kept platform-idiomatic on macOS where removing the app
// menu entirely is unusual. Every item that could reach a URL routes through
// shell.openExternal, never an in-app navigation.
function installMinimalMenu() {
  if (process.platform === 'darwin') {
    const template = [
      {
        label: APP_NAME,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } else {
    // Windows/Linux: no menu bar at all.
    Menu.setApplicationMenu(null);
  }
}

app.whenReady().then(() => {
  hardenSession(session.defaultSession);
  installMinimalMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// The single place navigation/window/webview are policed, for EVERY webContents
// this app ever creates (registered once, at module scope — not per window):
//   - will-navigate: any top-level navigation away from the local app shell
//     (a clicked link, a redirect, untrusted content doing location.href=…) is
//     stopped in-app and handed to the OS browser instead.
//   - setWindowOpenHandler: window.open(…) never spawns a second in-app
//     Chromium window; external URLs go to the OS browser, everything is denied.
//   - will-attach-webview: refuse to ever attach a <webview> (defense in depth
//     alongside webviewTag:false).
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternalIfSafe(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url)) openExternalIfSafe(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
});
