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
//     shell.openExternal, never inside this app's Chromium.
'use strict';

const path = require('node:path');
const { app, BrowserWindow, Menu, session, shell } = require('electron');

const APP_NAME = 'OmniDM';
app.setName(APP_NAME);

// The exact file this app is ever allowed to load. Anything else — including
// a navigation the page itself tries to trigger — is refused in-app.
const INDEX_FILE = path.join(__dirname, '..', 'web', 'index.html');
const INDEX_URL = `file://${INDEX_FILE.replace(/\\/g, '/')}`;

// Mirrors the <meta http-equiv="Content-Security-Policy"> in web/index.html.
// The page's own meta CSP is normally what Chromium enforces for a file://
// document, but we also set the header via webRequest as defense-in-depth
// (and so the policy holds even if the page were ever served without the
// meta tag). Keep this string in sync with web/index.html's CSP.
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; connect-src 'self' ws: wss: https: " +
  'http://localhost:* http://127.0.0.1:*; object-src \'none\'; base-uri \'none\'; form-action \'none\'';

/** Is this a URL we already trust and load ourselves (the local app shell)? */
function isAppUrl(url) {
  return url === INDEX_URL || url.startsWith(`${INDEX_URL}#`) || url.startsWith(`${INDEX_URL}?`);
}

function hardenSession(ses) {
  // Defense-in-depth CSP header, alongside the page's own meta CSP.
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
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

  // window.open(...) from the page (e.g. a help link, or the user's LLM
  // provider's site) — never open a second in-app Chromium window; hand it
  // to the OS browser instead, and never grant a new BrowserWindow.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Any top-level navigation away from the local app shell — a clicked
  // link, a redirect, a compromised-content attempt — is stopped in-app and
  // redirected to the OS browser instead of letting this window navigate.
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  // Belt-and-suspenders: refuse to ever attach a new webContents/window that
  // isn't this app's own renderer (covers <webview>, devtools popouts, etc.).
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

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

// Extra guardrail beyond webPreferences: reject any attempt, from any
// webContents this app ever creates, to enable Node integration or disable
// the sandbox/context isolation, and refuse any non-file navigation target
// that isn't the app shell itself.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
});
