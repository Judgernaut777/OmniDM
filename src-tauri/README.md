# OmniDM Desktop (Tauri v2)

A thin native desktop shell around the existing OmniDM web client (`../web`).
Per the **hybrid model**, the AI Dungeon Master engine runs **inside the
WebView** (the same `engine.bundle.js` the browser build uses), so there is **no
Node sidecar** and Tauri stays light — a WebView + a few MB of Rust.

- **Play on this device**: the engine runs in-app with *your* model and API key,
  stored only on this device (WebView localStorage) and sent only to the LLM
  endpoint you configure.
- **Connect to a server**: point at an OmniDM server (`npm run web` elsewhere)
  for multiplayer over the unchanged WebSocket protocol.

Nothing here changes the Node path — `npm run typecheck` / `npm run smoke` and
every chat adapter keep working exactly as before.

## Layout

```
src-tauri/
  tauri.conf.json     app identity (com.omnidm.app), window, CSP, bundle;
                      frontendDist → ../web (the committed web client)
  Cargo.toml          Rust crate (tauri v2); thin, no extra plugins
  build.rs            tauri-build codegen
  src/main.rs         binary entry (calls omnidm_lib::run)
  src/lib.rs          the Tauri Builder (mobile_entry_point-ready)
  capabilities/
    default.json      permission set — core defaults ONLY (no fs/shell/http)
  icons/              app icons (PNG/ICO/ICNS) + generate-icons.mjs
  webview-check.mjs   offline headless-chromium check of web/ under this CSP
```

## Prerequisites (to actually build)

Tauri compiles a native binary, so a real toolchain is required. This repo's CI
box does **not** have it; a developer machine needs:

| Requirement | All platforms |
|---|---|
| **Rust** (stable, ≥ 1.77.2) | install via <https://rustup.rs> |
| **Node ≥ 22** + this repo's `npm install` | provides `@tauri-apps/cli` |

Plus the per-OS WebView/native deps:

- **Linux** (what this box is missing): `webkit2gtk-4.1`, `librsvg2`, and the
  usual build tooling. On Debian/Ubuntu:
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```
- **macOS**: Xcode Command Line Tools (`xcode-select --install`). Produces
  `.app` / `.dmg`. WebView is the system WKWebView (no extra install).
- **Windows**: Microsoft C++ Build Tools + **WebView2** runtime (present on
  Windows 11; on older Windows install the Evergreen runtime). Produces
  `.msi` / `.exe`.

Verify your toolchain with:
```bash
npm run tauri -- info
```

## Build & run

From the **repo root** (the scripts are wired in the root `package.json`):

```bash
npm install            # once — installs @tauri-apps/cli
npm run build:web      # ensure web/engine.bundle.js is current (committed, but
                       # rerun after changing src/core or src/providers)
npm run tauri:dev      # launch the desktop app with devtools (hot-ish reload)
npm run tauri:build    # produce a release bundle for the current OS
```

`tauri:build` output lands in `src-tauri/target/release/bundle/` (`.deb`/
`.rpm`/`.AppImage` on Linux, `.dmg`/`.app` on macOS, `.msi`/`.exe` on Windows).

No dev server is needed: `frontendDist` points straight at the static `web/`
directory, so `tauri:dev` serves it directly (there is intentionally no
`beforeDevCommand`/`devUrl`). Run `npm run web` separately only if you want to
test the **Connect to a server** path against a local server.

### Icons

The committed `icons/` set is generated, dependency-free, by
`npm run tauri:icons`. On an equipped machine you can regenerate a richer set
from any square source PNG with `npm run tauri -- icon path/to/source.png`.

### Offline WebView sanity check (no Rust needed)

`node src-tauri/webview-check.mjs` serves `web/` with the **exact CSP** from
`tauri.conf.json` as a real HTTP header and loads it in headless chromium (the
Blink family WebKitGTK also renders), asserting the launch screen paints, the
in-app engine bundle + transport load under `script-src 'self'`, and **no CSP
violation** fires. It's the closest offline proxy for "does the WebView render
this" without the Rust/webkit toolchain.

## Security: CSP & capabilities (the trade-off)

The app is deliberately a WebView over **same-origin static assets** with a
strict CSP, mirroring the web client's defense-in-depth (players *and* the LLM
are untrusted):

```
script-src 'self'      →  no inline/injected script executes (XSS stays shut)
img-src 'self' data:   →  same-origin + in-app data: portraits only
connect-src 'self' ipc: http://ipc.localhost ws: wss: https:
            http://localhost:* http://127.0.0.1:*
object-src 'none'; base-uri 'none'; form-action 'none'
```

- **Why `connect-src` is broad but safe.** The in-app engine must `fetch()` the
  **user-configured** LLM endpoint (any `https:` host, or a loopback Ollama/LM
  Studio). That's a *scheme* allowance, not a baked-in external origin, and
  because `script-src` stays `'self'` it grants network reach **without opening
  XSS** — untrusted content still can't run code to abuse it. `ipc:` /
  `http://ipc.localhost` are Tauri's own IPC channel (added so the WebView can
  reach the Rust core); the app defines no custom commands, so that channel only
  exposes Tauri core defaults.
- **No external origins are baked into `web/*.html`** — the repo smoke asserts
  this and it stays true; the LLM host is reached at runtime via
  `fetch`/`connect-src`, never hard-coded.
- **Capabilities are minimal.** `capabilities/default.json` grants only
  `core:default` (window/webview lifecycle + event IPC). No filesystem, shell,
  or HTTP-plugin permission is enabled, so a WebView compromise gains no OS
  reach. Add a permission only when a feature genuinely needs it.
- **The API key stays a secret.** It lives in WebView localStorage (per the web
  client), is sent only to the configured LLM endpoint, and is never logged,
  persisted to a session file, or sent anywhere else — identical to the browser
  build.

### If the LLM provider blocks browser-origin fetch (CORS)

Because the engine runs in the WebView, its `fetch()` to the LLM is a
**browser-style cross-origin request**, so it's subject to the provider's CORS
policy — exactly like the "Play on this device" web build:

- **OpenRouter / Ollama / LM Studio**: generally send permissive CORS headers
  (or are same-loopback), so direct `fetch` works.
- **OpenAI**: does **not** send CORS headers for browser origins → a direct
  `fetch` from the WebView is blocked.
- **Anthropic (native)**: allows it only when the request opts in with the
  `anthropic-dangerous-direct-browser-access: true` header (the native provider
  can set this).

**Routing around CORS on desktop.** Unlike a plain browser, Tauri can make the
request from the **Rust side**, which is not subject to CORS. Two options,
neither wired in by default (kept out to preserve the light, plugin-free shell):

1. **`@tauri-apps/plugin-http`** — add the plugin, grant a *scoped*
   `http:default` permission in `capabilities/` allowlisting **only** the LLM
   host(s) the user configured, and have the in-app provider use the plugin's
   `fetch` (which proxies through Rust, bypassing CORS). Scope the allowlist
   tightly so a WebView compromise can't turn the HTTP client into an open
   proxy.
2. **A small custom `#[tauri::command]`** that performs the LLM call in Rust and
   returns the response — most control, but you own the streaming/error surface.

Both are desktop-only escape hatches; the browser build still relies on the
provider's CORS support. Document whichever you enable, and keep the
`connect-src`/capability allowlist as narrow as the chosen providers require.

## Status on this machine

Scaffold + config verified by: `tauri info` (parses the config, echoes the CSP
and `frontendDist`), the headless-chromium WebView check above, and the repo's
`npm run typecheck` / `npm run smoke`. The **native build was not run here** —
this box has no Rust/Cargo and no `webkit2gtk-4.1`/`librsvg2`. Install the
prerequisites above and run `npm run tauri:build` on an equipped machine to
produce installers.
