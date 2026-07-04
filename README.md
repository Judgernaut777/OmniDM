# OmniDM

A **production-ready, multi-platform, multi-player, model-agnostic AI Dungeon Master** with real mechanical rules, content extensibility, and a polished table UI. Run a tabletop RPG with an AI game master in any chat channel, with any LLM, for any number of players — solo/hotseat on your device, or multiplayer on a shared server.

Play for free on any platform; bring your own model or use free APIs. Self-host forever, or use a future hosted tier (content packs available free and premium).

## Get the app

Pick your preferred platform and play mode:

| **Platform** | **Solo/Hotseat (on this device)** | **Multiplayer (server)** |
|---|---|---|
| **Browser** | `npm run web` → <http://127.0.0.1:8787> <br/> Web table UI in your browser. | Point the same UI at a server instance (`npm run web` elsewhere) |
| **Desktop - Electron** | `npm run electron` <br/> Standalone app with Chromium bundled (no WebKit deps); cross-platform Windows/Mac/Linux. | Point the app at a server |
| **Desktop - Tauri** (lightweight) | `npm run tauri:dev` <br/> Smaller bundle (~100MB vs ~300MB); needs `webkit2gtk` on Linux, system WKWebView on macOS, WebView2 on Windows. | Same hybrid model |
| **Mobile - Capacitor** (iOS/Android) | Android: `npm run cap:sync && npm run cap:android` <br/> iOS: `npm run cap:sync && npm run cap:ios` (macOS + Xcode only) <br/> Native app; on-device play with your key. | Same hybrid model; point at a server |
| **Chat bots** (Discord/Slack/Matrix/Mattermost) | N/A — bots don't host single-player play. | `npm run discord` / `npm run slack` / `npm run matrix` / `npm run mattermost` <br/> Multiplayer only, everyone in the channel shares the session. |
| **CLI** (terminal) | `npm run cli` <br/> Text-mode REPL; cheapest way to test the engine. No UI, just turns + rolls. | N/A — single-player only |

**Key feature: both play modes use the same engine, same rules, same UI.** Your API key and model are your choice; everything is open, free to self-host, and runs offline (except the LLM call to your configured endpoint).

## Free, open, and extensible

**Self-hosting is free forever.** Run `npm run web` (or `npm run electron`, `npm run discord`, etc.) on any machine. No fees, no server bill, no paywall. Everything ships unlocked.

**Bring your own model.** Every platform supports OpenAI-compatible (Claude, GPT, Ollama, LM Studio, OpenRouter, etc.) and native Anthropic APIs. Free tier? Use a free OpenRouter model. Your own key? Pay per token. Local LLM on your machine? Zero cost.

**Extend with content packs.** Custom rules systems, lorebook entries, NPCs, and campaign starters are bundled as JSON files that validate and load into any session. Free packs are free. The scaffold exists for premium packs and a future hosted tier, but nothing is locked today.

**Production-ready, transparent roadmap.** Real mechanical rules (HP, damage, conditions), polished UIs, CI gates (typecheck + 450+ smoke tests), and open-source code. See [MONETIZATION.md](MONETIZATION.md) for details on how packs and a future hosted tier would work (the seam is there, but not wired up yet).

## Quick start — CLI (free, ~2 minutes)

For a quick test before running a full app:

```bash
npm install
cp .env.example .env
# Get a free key at https://openrouter.ai/keys and paste it into .env as LLM_API_KEY
npm run cli
```

Then:

```
/dm new
/dm join Thorin the Bold
I push open the tavern door and look for trouble.
```

The default model is a free OpenRouter model, so this costs nothing. Type
`/dm models` to see what else you can use, and `/dm model <id>` to switch — the
same dropdown includes Claude, GPT, Gemini, and local models.

## Why this exists

The open-source landscape has many AI DMs, but none ships all three of:
**multi-platform** (web, desktop, mobile, chat bots, terminal), **multi-player** (shared sessions, real multiplayer, fog-of-war), **and model-agnostic** (Claude, GPT, local LLMs, free APIs). OmniDM fills that gap. Beyond breadth, it also ships **real mechanical rules** (HP, conditions, checks — the engine owns these, not the narration), **extensible content packs** (game systems, NPCs, lorebooks, campaign starters), and a **polished, cross-platform table UI** that's the same everywhere.

The architecture borrows deliberately from prior art (see [`docs` credits](#prior-art-studied)):

| Layer | Pattern | Borrowed from |
|------|---------|---------------|
| **Turn engine** | "Sandwich": lock → resolve dice (pure) → persist → LLM narrates the *resolved* outcome | daicer |
| **Dice/rules** | Standalone deterministic resolver; rules as swappable markdown modules | open-tabletop-gm |
| **Providers** | One canonical message format → per-backend converter | SillyTavern |
| **Memory** | Rolling "living summary" compaction + per-turn RAG recall (embedding or lexical) | NeverEndingQuest / NarrativeEngine-P |
| **Multiplayer** | Per-channel lock; shared session; targeted broadcast | Agnai / daicer |
| **Platform layer** | One `PlatformAdapter` interface; add a platform = add one file | *new — the moat* |

## Running with other platforms

Beyond the web client, you can run OmniDM as a bot in any chat channel:

### Run on Discord

1. Create an app at <https://discord.com/developers/applications>, add a **Bot**,
   and enable the **Message Content Intent**.
2. Put the token in `.env` as `DISCORD_TOKEN`, invite the bot to your server.
3. `npm run discord`, then in any channel: `/dm new`.

### Run on Slack

1. Create an app at <https://api.slack.com/apps> and enable **Socket Mode**
   (this mints an app-level token with `connections:write` — that's
   `SLACK_APP_TOKEN`, it starts with `xapp-`).
2. Give the bot the `chat:write`, `channels:history`, `groups:history` and
   `users:read` scopes, subscribe to the `message.channels` event, and install
   it to your workspace (`SLACK_BOT_TOKEN`, starts with `xoxb-`).
3. Put both tokens in `.env`, invite the bot to a channel, then
   `npm run slack` and in that channel: `/dm new`. Fog-of-war whispers arrive
   as ephemeral messages only the target player can see.

### Run on Matrix

1. Create a bot account on any homeserver and grab an access token (Element →
   Settings → Help & About → Advanced, or the `/login` API).
2. Put `MATRIX_HOMESERVER_URL` and `MATRIX_ACCESS_TOKEN` in `.env`.
3. `npm run matrix`, invite the bot to a room (it auto-joins), then in that
   room: `/dm new`. Fog-of-war whispers arrive as direct messages.

### Run on Mattermost

1. Create a bot account (System Console → **Integrations → Bot Accounts**) or
   a personal access token.
2. Put the server URL in `.env` as `MATTERMOST_URL` (e.g.
   `https://chat.example.com`) and the token as `MATTERMOST_TOKEN`.
3. `npm run mattermost`, add the bot to a channel, then in that channel:
   `/dm new`. Fog-of-war whispers arrive as direct messages. No SDK needed —
   the adapter speaks REST API v4 and the events WebSocket directly.

### Run in the browser

The browser client is **hybrid**: it can run the whole game **in the page**
("Play on this device") or **connect to a server** for multiplayer — you pick on
the launch screen, and the choice + settings are remembered.

- **Play on this device** (self-contained, no server): the AI DM engine runs
  inside the app. Enter your model settings — provider (OpenAI-compatible or
  native Anthropic), base URL, model, and your own **API key** — and play solo or
  hotseat on one device. **Your key never leaves this device** and is sent only
  to the LLM endpoint you configured; it is never logged, never written into a
  saved game, and never sent anywhere else. By default the key itself is kept in
  `sessionStorage` (gone once you close the tab/browser) — tick **"Remember this
  key on this device"** on the launch screen to persist it to `localStorage`
  across restarts instead. Games (party, log, characters — never the key) persist
  in the browser (IndexedDB / localStorage). Open `web/index.html` however you
  serve static files — e.g. `npm run web` and choose "Play on this device" — and
  no tokens or server round-trip are needed (the only network call is to your model).

- **Connect to a server** (multiplayer across devices):
  1. `npm run web`, then open <http://127.0.0.1:8787>. No tokens needed.
  2. Choose **Connect to a server**, pick a name and a **room code** — everyone
     who enters the same room code shares one party, so multiple groups can play
     on one server — and (optionally) a server URL + room password.
  3. `/dm new`, as usual. Fog-of-war whispers appear only on the target player's
     screen, marked as private.

Both modes drive the **same** UI (campaign, party, character creator, dice,
battle map, fog) through one **Transport** abstraction (`web/transport.js`):
`RemoteTransport` speaks the unchanged JSON-over-WebSocket protocol to a server,
while `LocalTransport` runs the shared `RoomEngine` + `Bot` + a browser
`SessionStorage` + a provider **in-process** and routes the identical frames with
no network but the model call. The in-app engine is bundled same-origin (no CDN,
no external origins) by **`npm run build:web`** into `web/engine.bundle.js`
(committed, so `npm run web` needs no build step); rerun it after changing the
shared engine under `src/core` / `src/providers`.

The server binds to loopback **on purpose**: there is no TLS and, unless you
set `WEB_PASSWORD`, no auth. To let remote players in, put a reverse proxy
with HTTPS and auth in front of it and set `WEB_HOST=0.0.0.0` deliberately.
`WEB_HOST`, `WEB_PORT` (default `8787`) and `WEB_PASSWORD` all live in `.env`.

The bundled client (`web/`) is a dark-fantasy table UI in four plain files
(`index.html`, `app.js`, `style.css`, `portraits.js`) — no build step, no
external origins. It has a scrolling log with distinct DM / player / whisper
styling; a **shared battle map** where every party member and imported NPC is
a draggable token (moves are server-authoritative, so every screen stays in
sync — collapse it with the "Hide map" toggle); a party roster with a
round-robin whose-turn indicator; a **felt dice tray** whose faces tumble and
settle on the engine's *real* roll (never re-rolled; skipped under
`prefers-reduced-motion`), with the total popping over the roller's token on
the map; and a command palette covering every `/dm` command.

**Classes, portraits & character cards.** Set your character's D&D 5e class
with `/dm class <name>` — one of the twelve official classes (`barbarian`,
`bard`, `cleric`, `druid`, `fighter`, `monk`, `paladin`, `ranger`, `rogue`,
`sorcerer`, `warlock`, `wizard`) — which also picks a matching portrait crest
unless you've uploaded your own. Add a short persona with `/dm bio <text>`; the
class and bio are woven into the DM's prompt so it plays you accordingly. Each
seat and each map token is drawn as a portrait: the class preset crest (or set
one directly with `/dm portrait <preset>`), rendered as procedural heraldic
avatars entirely client-side. In the browser this all lives behind one obvious
door: a **⚔ Your character** button in the topbar (and an auto-prompt the first
time you join without a character) opens a **character creator** that sets it all
in one place — your name, your class from a visual gallery of all twelve classes
each drawn with its own live procedural portrait, your bio, an uploaded picture
(png/jpeg/gif/webp, served same-origin with `nosniff`) or an imported Character
Card, with a large live preview of the result. An upload or card art overrides
the class crest. Clicking *another* player's seat opens a read-only character
sheet (portrait, name, class, bio, card summary). On the map, PCs get a gold rim,
NPCs a dashed steel rim, and whoever's turn it is glows with the candle motif; an
imported card's embedded PNG becomes its portrait automatically.

The adapter itself speaks a small JSON-over-WebSocket protocol (`msg`, `roll`,
`scene`, `move`, and roster frames) that desktop/mobile UIs can reuse; portrait
image bytes travel over HTTP (`GET`/`POST /portrait/<channel>/<user>`), never
inside a socket frame.

## Desktop & mobile apps

The same `web/` client is wrapped as native desktop and mobile apps with **no
rewrite**. All use the same **hybrid model**: a native WebView loads the
committed client and runs the whole AI-DM engine (`web/engine.bundle.js`)
**inside the WebView**. There is **no Node sidecar and no bundled server**.

**Both play modes work on all platforms:**
- **Play on this device** — the engine runs in-app with *your* provider, base URL,
  model and **API key**, which never leaves that device and is sent only to the
  LLM endpoint you configured (sessionStorage by default; opt into WebView
  localStorage via "Remember this key" to persist it across restarts). Solo /
  hotseat, no server needed.
- **Connect to a server** — point the app at an OmniDM server (`npm run web`
  running elsewhere) for multiplayer over the unchanged WebSocket protocol.

All shells use the same `com.omnidm.app` identifier and point at the committed
`web/` directory; no separate build/copy is needed. Rerun `npm run build:web`
only after changing the shared engine under `src/core` or `src/providers`.

The native project outputs are **not committed** and **not built on this Linux
box**:
- Electron bundles Chromium, so it builds without system WebKit deps.
- Tauri uses system WebKit (none available here; needs `webkit2gtk` on Linux,
  system WKWebView on macOS, WebView2 on Windows).
- Capacitor's `android/` and `ios/` need an Android SDK / macOS+Xcode respectively.

What **is** committed: complete scaffolds (configs, scripts, app icons, per-platform
READMEs). Each also ships an **offline headless-chromium verification**
(`node electron/webview-check.mjs`, `node src-tauri/webview-check.mjs`, `node
capacitor/webview-check.mjs`) that runs without native toolchains — they serve
`web/` under the exact app CSP / simulated WebView and drive a real in-app turn
through the actual bundle.

### Desktop — Electron (easiest, cross-platform)

Electron bundles Chromium, so it builds on **any OS** without system WebKit
dependencies. Start with this if you're new to native desktop apps.

**Prerequisites:**
- **Node ≥ 22** + `npm install` (installs `electron`)
- That's it — Chromium is bundled. Builds on PC/Mac/Linux with zero extra system packages.

**Build & run:**

```bash
npm install                 # installs electron + electron-builder
npm run build:web           # refresh web/engine.bundle.js if the engine changed
npm run electron            # launch for development (live window)
npm run electron -- <args>  # pass Electron flags if needed (e.g., --help)
npm run electron:build      # package a distributable for THIS OS (into release/)
```

**Details:** The Electron shell is a thin `electron/main.cjs` that loads
`web/index.html` and applies strict CSP (`script-src 'self'`; `connect-src` is
narrowed at runtime to the configured provider origin once main can learn it —
see the comments in that file). The user's LLM API key is sent only to the
configured endpoint and never reaches the Node process; by default it lives in
WebView sessionStorage (opt into localStorage via "Remember this key"). See
[electron/main.cjs](electron/main.cjs) for the security model (context
isolation, no preload, no nodeIntegration, sandboxing enabled, an http(s)/mailto
scheme allowlist on every external-link open).

**To bundle for distribution:** `electron-builder` is already configured (see the
`build` block in `package.json`: appId `com.omnidm.app`, targets **AppImage**
(Linux), **nsis** `.exe` (Windows), and **dmg** (macOS)). Run:

```bash
npm run electron:build      # → release/  (unpacked app + installer for this OS)
```

Important: electron-builder produces a bundle for the **host OS only** — it does
not cross-compile. Build the Windows target on Windows, the macOS `.dmg` on macOS
(it shells out to macOS-only tools like `hdiutil`, so `--mac` from Linux fails),
and the Linux `.AppImage` on Linux. The `release/` output directory is
git-ignored. Code signing/notarization (needed for a smooth install on macOS and
to avoid SmartScreen on Windows) requires your own certificates and is left to
whoever cuts the release.

### Desktop — Tauri v2 (lightweight alternative, `src-tauri/`)

Tauri builds a smaller binary than Electron by using the system WebKit instead of
bundling Chromium. **If Electron works, use it.** Choose Tauri if you need a
lighter bundle and your OS already has the WebKit libraries (it does on macOS and
Windows 11; on Linux you install them once).

**Prerequisites (per-OS):**

| Requirement | Detail |
|---|---|
| **Rust** stable ≥ 1.77.2 | install via <https://rustup.rs> |
| **Node ≥ 22** + `npm install` | provides `@tauri-apps/cli` |
| **Linux** only | `webkit2gtk-4.1`, `librsvg2`, build tooling — on Debian/Ubuntu: `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev` |
| **macOS** | Xcode Command Line Tools (`xcode-select --install`); system WKWebView is built-in |
| **Windows** | MSVC C++ Build Tools + **WebView2** runtime (bundled on Win11, free download on Win10) |

**Build & run:**

```bash
npm install            # installs @tauri-apps/cli
npm run build:web      # refresh web/engine.bundle.js if the engine changed
npm run tauri:dev      # launch for development (devtools available)
npm run tauri:build    # release bundle → src-tauri/target/release/bundle/
npm run tauri -- info  # verify your toolchain
```

The frontend is served from the committed `web/` directory (no build step, no
dev server). The window enforces strict CSP and **core-default permissions only**
(no filesystem/shell/http access). Full details in [`src-tauri/README.md`](src-tauri/README.md).

### Mobile — Capacitor iOS + Android (`capacitor.config.ts`, `capacitor/`)

**Prerequisites:**

| Target | Requirements |
|---|---|
| **Android** | Android SDK (set `ANDROID_HOME` with platform-tools, `platforms;android-34`, `build-tools;34.0.0`) + JDK 21. All install user-space (no root). Gradle wrapper generated. Emulator (needs `/dev/kvm`) or USB debug device. |
| **iOS** | **macOS only** + **Xcode** + CocoaPods (`sudo gem install cocoapods`). Simulator or a device + an Apple signing profile. iOS **cannot** be built off a Mac. |
| **Common** | Node ≥ 22 + this repo's `npm install` (provides `@capacitor/cli`). |

**ARM64 Linux caveat:** Google's `aapt2` is x86-64 only. Workaround: `sudo apt install qemu-user-static` (transparent binfmt registration) or configure box64 (already set in `android/gradle.properties` for ARM64). On x86-64 / macOS / Windows, no caveat.

**Build:**

```bash
npm install            # brings in @capacitor/{core,cli,android,ios}
npm run build:web      # refresh web/engine.bundle.js if the engine changed

# Android
npm run cap:add:android   # one-time: generate android/ (not committed)
npm run cap:sync          # sync web/ into the native project
npm run cap:android       # build & launch
#   or open android/ in Android Studio for a signed APK/AAB

# iOS (macOS only)
npm run cap:add:ios       # one-time: generate ios/ (macOS only)
npm run cap:sync
npm run cap:ios           # build & launch
#   or open ios/ in Xcode to pick a signing team
```

**LLM CORS on device.** A mobile WebView is still a browser, so a plain `fetch`
to your LLM endpoint is subject to CORS (and the page CSP's `connect-src`). On a
Capacitor **native** platform the in-app provider instead routes through the
native **`CapacitorHttp`** stack (URLSession on iOS, OkHttp on Android) — not a
browser context, so **no CORS and no CSP gate**; any LLM host is reachable. The
selection is **feature-detected** in `src/browser/native-http.ts`: `selectFetch()`
returns a `CapacitorHttp`-backed fetch only when `window.Capacitor.isNativePlatform()`
is true and the plugin is registered, otherwise `undefined` so a plain browser and
the Node server keep the default fetch. That fetch is threaded into both providers
via `buildProvider({ …, fetchImpl })`. Your API key stays on the device (WebView
sessionStorage by default, opt into localStorage via "Remember this key") and is
sent only to the endpoint you configured. Full steps + the offline WebView check
are in [`capacitor/README.md`](capacitor/README.md).

## Using whatever model you want

Everything goes through one OpenAI-compatible endpoint, so you change backends by
editing **one line** in `.env`:

| Backend | `LLM_BASE_URL` | Notes |
|--------|----------------|-------|
| OpenRouter (default) | `https://openrouter.ai/api/v1` | One key → hundreds of models, incl. free + Claude |
| OpenAI | `https://api.openai.com/v1` | Your OpenAI key |
| Ollama (local) | `http://localhost:11434/v1` | No key needed, runs offline |
| LM Studio (local) | `http://localhost:1234/v1` | No key needed |
| Anthropic (native) | — set `LLM_PROVIDER=anthropic` | Native Messages API; key via `LLM_API_KEY` or `ANTHROPIC_API_KEY` |

**Who pays?** Only whoever runs the bot, and only for the model *they* point it at.
Free OpenRouter models = $0. A user supplying their own Claude/OpenAI key pays only
for their own usage. Local models are free.

## Commands

```
/dm new                 start a campaign in this channel
/dm join <name>         join with a character name
/dm who                 show the party
/dm hp                  show every party member's current HP
/dm mode <m>            turn mode: immediate (default) or round-robin
/dm turn                show whose turn it is (round-robin)
/dm pass                skip your turn (round-robin)
/dm fog <on|off>        per-player fog of war: the DM can whisper private
                        details to one character (default off)
/dm class [<name>]      set your D&D 5e class (no arg lists all 12); also picks
                        a matching portrait crest
/dm bio [<text>]        set a short character bio/persona (no arg shows yours)
/dm portrait [<preset>] set your portrait to a class preset (no arg lists
                        them); upload your own picture in the browser
/dm import <src>        import a Character Card V2/V3 (JSON or PNG, path or URL)
/dm lore add <name> | <keywords> | <content>
                        add world info, injected when a keyword comes up
/dm lore list           show the lorebook (ids, names, trigger keywords)
/dm lore remove <id>    remove a lore entry (by id or name)
/dm pack list           list bundled content packs (rules + lorebook + NPCs +
                        campaign starters); free or premium
/dm pack load <id>      import a content pack into this session
/dm damage <name> <n>   deal n damage to a character (real mechanic: hp clamped
                        at 0, unconscious condition set)
/dm heal <name> <n>     restore n hp to a character (clamped at maxHp)
/dm check <name> <result>  record an ability check as PASS or FAIL — the
                        narration treats it as a resolved fact (no LLM
                        reroll)
/dm models [filter]     list usable models (🆓 = free)
/dm model <id>          pick the model for this game
/dm roll <notation>     roll dice (d20+5, 2d6, d20 adv, 4d6kh3)
/dm end                 end the campaign
```

Anything that isn't a command is treated as your character's action.

**Mechanical rules.** HP, damage, healing, and conditions are **real**: `/dm damage` and `/dm heal` apply deterministic state changes (clamped, synced to the roster). The DM can also embed mechanics into narration: end a turn with `<<hp Name -7>>` (damage), `<<condition Name prone>>` (add condition), or `<<heal Name 5>>` (heal); the engine parses, applies, and strips these before broadcasting the text. Pre-resolved ability checks (`/dm check`) are treated as facts in the narration — the LLM never re-rolls them.

`/dm import` accepts the Character Card V2/V3 format (raw JSON or a card PNG with the embedded `chara`/`ccv3` chunk). If you've already joined, the card becomes **your persona**; otherwise it becomes an **NPC** the DM portrays. A card's `character_book` is imported into the session lorebook automatically. Because anyone in the channel can run it, sources are restricted: local paths must live under `DATA_DIR`, URLs must be public http(s) (no loopback/private addresses, no redirects), and downloads are size-capped.

`/dm lore` entries are keyword-triggered world info (SillyTavern's World Info pattern): when an entry's keyword appears in the current action or recent turns, its content is injected into the DM prompt as a bounded `WORLD INFO` block. Entries with no keywords are always injected.

`/dm pack` loads a **content pack**: a versioned JSON bundle of a rules/system module, lorebook entries, NPCs, and an optional campaign starter — see [MONETIZATION.md](MONETIZATION.md) for the format and how packs relate to extensibility. Self-hosting unlocks every pack today; nothing is gated unless you enable the hosted entitlements stub.

`/dm fog on` (daicer's `player_perspectives`) lets the DM append
`[PRIVATE:<CharacterName>] … [/PRIVATE]` sections to its narration. The public
remainder is broadcast to the channel; each private section is delivered only
to that character's player (the CLI prints a whisper; Discord sends a DM — if
the player's DMs are closed it posts a content-free notice in the channel,
never the secret; Slack posts an ephemeral message; Matrix and Mattermost use
a direct-message channel with that player).

## Architecture

```
adapters/        ← PlatformAdapter implementations (cli, discord, slack, matrix, …)  [the moat]
  cli.ts
  discord.ts
  slack.ts
  matrix.ts
  mattermost.ts
  web.ts         ← browser seam: HTTP + WebSocket server (static client in web/)
core/
  bot.ts         ← platform-agnostic router (commands + turns)
  types.ts       ← canonical Message / Session / Provider contracts
  cards/
    card.ts      ← Character Card V2/V3 import (JSON or PNG-embedded); Portrait type
  portraits.ts   ← the 12 D&D 5e class presets (`/dm class`/`/dm portrait`); id normalizer + fallback
  lore/
    lorebook.ts  ← keyword-triggered world info (/dm lore, card character_books)
  engine/
    dice.ts      ← deterministic roller (seedable)
    turn-pipeline.ts  ← the sandwich: lock → resolve → persist → narrate
  memory/
    retrieval.ts ← vector memory / RAG: per-turn records, embedding or lexical recall
  narrator/
    narrator.ts  ← builds the prompt; LLM narrates resolved turns
    fog.ts       ← splits [PRIVATE:<Name>]…[/PRIVATE] whispers out of narration
  room/
    room-engine.ts ← transport-agnostic RoomEngine: seat/roster/scene/roll/fog/portrait semantics, no node:http/ws/fs (shared by the web adapter AND the in-app engine)
  session/
    session-manager.ts  ← channel → game session, party, seat re-claim after reconnect
    storage.ts   ← SessionStorage interface + MemoryStorage (the browser/mobile seam)
    store.ts     ← NodeFileStorage: JSON files under DATA_DIR
    browser-storage.ts  ← BrowserSessionStorage: IndexedDB (localStorage fallback) for the in-app engine
providers/
  openai-compatible.ts  ← OpenRouter/OpenAI/Ollama/LM Studio (one adapter)
  anthropic.ts          ← native Anthropic Messages API (system param + role converter)
rules/
  dnd5e/system.md       ← swappable rules module
browser/               ← in-app (WebView) engine seam, no node: on the engine path
  local-engine.ts  ← in-app composition root: wires Bot + RoomEngine + browser storage + provider (the LocalTransport's engine)
  engine-entry.ts  ← the one module esbuild bundles → web/engine.bundle.js (global OmniDMEngine)
  native-http.ts   ← selectFetch(): CapacitorHttp-backed fetch on a native mobile platform (CORS bypass), else default fetch (feature-detected)
scripts/
  build-web.mjs    ← esbuild bundle step for web/engine.bundle.js (npm run build:web); stubs the Node-only card loader
web/               ← browser client served by the web adapter AND wrapped by the Tauri/Capacitor shells
  index.html / app.js / style.css   ← table UI: launch/settings, log, roster, battle map, dice tray, character creator + card sheet
  transport.js     ← hybrid transport: RemoteTransport (WebSocket → server) | LocalTransport (in-page engine)
  engine.bundle.js ← the shared engine bundled for the browser (GENERATED by npm run build:web; committed)
  portraits.js     ← procedural heraldic crest portraits, shared by roster + token board
src-tauri/         ← Tauri v2 DESKTOP shell (WebView over web/, thin Rust crate)
  tauri.conf.json  ← app id/window/CSP/bundle; frontendDist → ../web
  Cargo.toml / build.rs / src/{main,lib}.rs   ← Rust crate (no Node sidecar, no custom commands)
  capabilities/default.json   ← permission set: Tauri core defaults ONLY (no fs/shell/http)
  icons/           ← generated app icons + generate-icons.mjs (npm run tauri:icons)
  webview-check.mjs ← offline headless-chromium check of web/ under the exact Tauri CSP
capacitor.config.ts  ← Capacitor MOBILE (iOS + Android) shell config: appId com.omnidm.app, webDir → web/, CapacitorHttp enabled
capacitor/
  README.md        ← per-platform build steps + toolchain + the CORS/native-HTTP story
  webview-check.mjs ← offline check simulating the native WebView (injects window.Capacitor + CapacitorHttp stub)
```

**Add a chat platform:** implement `PlatformAdapter` (4 methods) in `adapters/`,
add a case in `index.ts`. The engine doesn't change.

**Add a model backend:** implement `LLMProvider` (`listModels` + `complete`) in
`providers/`. `anthropic.ts` is the worked example: SillyTavern's Claude
message-converter pattern as a pure function plus a thin fetch wrapper.

**Add a game system:** drop a `rules/<system>/system.md`. Set it per session.

## Done

Shipped since the initial scaffold (newest first):

- **Content packs & extensible rules** — `/dm pack list|load <id>` imports bundled or custom game content: rules modules, lorebook entries, NPCs, and campaign starters. Packs are a real JSON format (schema in [MONETIZATION.md](MONETIZATION.md)) that can be free or premium. One real example pack (`frontier-outpost.pack.json`) ships out-of-the-box. Today, everything is unlocked for self-hosters; the entitlements seam (`src/core/entitlements/`) is there for a future hosted tier, but nothing blocks you.
- **Real mechanical rules** — HP, damage, healing, conditions, and ability checks are owned by the engine, not the LLM. The DM's narration can emit `<<hp Name -7>>` / `<<condition Name prone>>` markers which are parsed, applied deterministically, clamped, and stripped from the final text; players never see the marker syntax. `/dm damage`, `/dm heal`, `/dm check` apply mechanics explicitly. The rules engine is **deterministic and pure** — tests cover all clamps, condition transitions, unconscious state automation.
- **Landing page** — a self-contained marketing page is committed at `web/landing.html`; serves as the project's home and link target.
- **CI gates** — GitHub Actions workflow (`.github/workflows/ci.yml`) runs typecheck, builds the web engine bundle, verifies it's up-to-date, and runs smoke tests (450+ checks covering every layer). Smoke tests gracefully skip headless web-UI checks if chromium is unavailable (e.g., on ARM CI builders), but report every skip so you know what's covered.
- **Desktop & mobile apps (hybrid)** — the `web/` client is wrapped, with **no rewrite**, as a **Tauri v2** desktop app (`src-tauri/`) and a **Capacitor** iOS + Android app (`capacitor.config.ts`, `capacitor/`). Both are thin native WebViews that run the whole AI-DM engine in-WebView (no Node sidecar, no bundled server); "Play on this device" uses your own key, "Connect to a server" uses the unchanged WebSocket protocol. The Tauri window keeps the web client's strict CSP (`script-src 'self'`) and Tauri **core-default** capabilities only; on a native mobile platform the in-app LLM call routes through **`CapacitorHttp`** to bypass WebView CORS (feature-detected in `src/browser/native-http.ts`). Scaffold + configs + scripts + icons + per-platform READMEs are committed and verified by the Node gates plus offline headless-chromium WebView checks; **the native builds are not run here** (this box has no Rust/webkit2gtk, no Android SDK, no macOS/Xcode) — and **iOS can only be built on a Mac**
- **In-app engine + hybrid browser client** — the core was made browser-runnable
  without breaking Node: the web adapter's room/protocol logic was extracted into
  a transport-agnostic **`RoomEngine`** (`src/core/room`), the Node-only
  touchpoints (rules loader, card PNG/zlib loader, session storage, provider
  browser-mode) put behind interfaces, and a **`BrowserSessionStorage`**
  (IndexedDB / localStorage) added. The browser client now talks to a **Transport**
  (`web/transport.js`): `RemoteTransport` (WebSocket → server) or `LocalTransport`,
  which runs `RoomEngine` + `Bot` + browser storage + your provider **in-page**.
  The shared engine is bundled same-origin by **`npm run build:web`** into the
  committed `web/engine.bundle.js`. The launch screen lets you pick "Play on this
  device" (BYO provider/key, stored locally, sent only to your model) vs "Connect
  to a server", and remembers the choice
- **D&D 5e classes, bios & a character creator** — the portrait catalog is now
  the twelve official D&D 5e classes (`barbarian`, `bard`, `cleric`, `druid`,
  `fighter`, `monk`, `paladin`, `ranger`, `rogue`, `sorcerer`, `warlock`,
  `wizard`), each drawn as its own procedural class portrait. `/dm class <name>`
  sets your class (and defaults your portrait to the matching crest unless you've
  uploaded a picture or imported card art); `/dm bio <text>` sets a short,
  bounded persona. Class and bio ride along on the `Player`, survive a reconnect
  seat re-claim, and are woven into the DM prompt as a one-line character sheet so
  it plays each PC true to their class and bio. In the browser a prominent
  **⚔ Your character** topbar button (plus an auto-prompt the first time you join
  without a character) opens a **character creator** that sets name, class (a
  visual gallery of all twelve classes each rendered with its live procedural
  portrait), bio, an uploaded portrait and a Character Card import in one place,
  with a large live preview; clicking another player's seat opens a read-only
  sheet. XSS-safe (`createElementNS` / `textContent`), reduced-motion aware
- **Shared token board (VTT-lite)** — the browser table has a battle map where
  every party member and imported NPC is a draggable token drawn as its own
  portrait (the same uploaded image or procedural crest as the roster), with a
  name label, gold rims for PCs and dashed steel rims for NPCs, and a candle
  glow on whoever's turn it is; it's a *shared* table (anyone may move any
  token). Dragging sends a throttled `{type:'move'}` (plus a final frame on
  drop) and the server clamps to 0..1 and rebroadcasts the authoritative scene,
  so every screen stays in sync; a resolved roll pops over the roller's token
  and fades. Collapse it with the topbar-adjacent "Map" toggle; it stacks above
  the log on mobile. XSS-safe (SVG built with `createElementNS`, labels via
  `textContent`), no external origins, reduced-motion aware
- **Character portraits, cards & animated dice** — every seat and battle-map
  token is a portrait: one of eight preset archetype crests (`/dm portrait
  <preset>`) rendered as procedural heraldic avatars entirely client-side
  (`web/portraits.js`, `createElementNS` / `textContent` only — never
  `innerHTML`), or your own uploaded picture (png/jpeg/gif/webp, POSTed to
  `/portrait/<channel>/<user>` behind the room password, stored on the seat and
  served same-origin with `nosniff` + a clamped content-type). Clicking a seat
  opens a character-card panel with the large portrait, name and card summary;
  your own seat also gets a crest gallery and the upload control. An imported
  card's embedded PNG becomes its portrait automatically. The felt dice tray
  tumbles each die through random faces before settling on the engine's
  *authoritative* value — never re-rolled — skipped under
  `prefers-reduced-motion`
- **Browser table UI** — `web/` is four plain files (`index.html`, `app.js`,
  `style.css`, `portraits.js`): no build step, no external origins; join screen (name + room
  code + optional password), scrolling log with distinct DM / player / whisper
  styling, party roster with a round-robin whose-turn indicator, dice
  quick-buttons plus custom notation, and a command palette covering every
  `/dm` command; all socket/model text enters the DOM via `textContent`
  (XSS-safe), and dropped sockets reconnect with exponential backoff
- **Web adapter** — `npm run web`; serves a zero-build browser client plus a
  JSON-over-WebSocket protocol (the seam for desktop/mobile UIs); room codes
  so multiple parties share one server, optional `WEB_PASSWORD`, loopback-only
  by default; abuse limits that hold against raw sockets (per-connection rate
  limit, frame/field size caps, connection cap, hello deadline); fog-of-war
  whispers go only to the target player's socket, and after a reconnect
  `/dm join <name>` re-claims the old seat (HP, persona and turn slot intact)
- **SessionStorage seam** — the core persists sessions only through a
  `SessionStorage` interface (`load`/`save`/`delete`), injected at the
  composition root (`index.ts`); `NodeFileStorage` keeps the JSON-files-under-
  `DATA_DIR` behaviour, `MemoryStorage` is the portable in-memory one — the
  seam for running the engine in a browser or mobile WebView later
- **Mattermost adapter** — `npm run mattermost`; dependency-free (REST API v4 +
  events WebSocket); fog-of-war whispers via direct-message channels
- **Matrix adapter** — `npm run matrix` (matrix-bot-sdk); fog-of-war whispers
  via DM rooms
- **Slack adapter** — `npm run slack` (Socket Mode via @slack/bolt);
  fog-of-war whispers as ephemeral messages
- **Vector memory / RAG recall** — every resolved turn is stored as a memory
  record and relevant older turns are recalled into the prompt as
  `RELEVANT PAST EVENTS`; lexical matching by default (offline, zero config),
  embeddings + cosine similarity when `EMBEDDINGS_MODEL` is set
- **Native Anthropic provider** — `LLM_PROVIDER=anthropic`; Messages API via
  fetch, no SDK
- **Per-player fog of war** — `/dm fog on|off`; `[PRIVATE:<Name>]` narration
  sections delivered only to that character's player
- **Lorebook / world info** — `/dm lore add|list|remove`; keyword-triggered
  injection; card `character_book`s import automatically
- **Character Card V2/V3 import** — `/dm import` (JSON or PNG, path or URL);
  becomes your persona if you've joined, an NPC otherwise; SSRF- and
  size-guarded
- **Round-robin turn mode** — `/dm mode round-robin`, `/dm turn`, `/dm pass`

## What's next

- **Signed native builds & CI distribution** — the desktop/mobile scaffolds are code-complete and tested; shipping needs signed Tauri bundles per OS and generated Capacitor projects in CI, plus code signing/notarization (macOS/Windows).
- **Hosted tier + real billing** — `src/core/entitlements/` is the seam a real billing integration replaces; an operator can drop in their own `isUnlocked(key, scope)` logic keyed by tenant (guild/room) and flip `OMNIDM_HOSTED_TIER=1` to gate premium packs.
- **More platforms** — Signal (via signal-cli), Twilio, Teams, etc. Adding one is a single `PlatformAdapter` implementation (~200 LOC) in `adapters/`.
- **More native providers** — more cloud APIs beyond Claude (Anthropic native), plus deeper integrations for local models.
- **Secure key storage** — move from WebView sessionStorage/localStorage into the platform's secure store (iOS Keychain, Android Keystore, OS Keychain on desktop).
- **Initiative & combat** — 5e-style initiative rolls; automated round-robin turns within combat vs narrative mode.
- **More content packs** — the format and loader are production-ready; shipping curated packs (homebrew systems, one-shots, settings) is a matter of authoring and testing them.

## Prior art studied

[daicer](https://github.com/lguibr/daicer) ·
[open-tabletop-gm](https://github.com/Bobby-Gray/open-tabletop-gm) ·
[Agnai](https://github.com/agnaistic/agnai) ·
[SillyTavern](https://github.com/SillyTavern/SillyTavern) ·
[NarrativeEngine-P](https://github.com/Sagesheep/NarrativeEngine-P) ·
[NeverEndingQuest](https://github.com/MoonlightByte/NeverEndingQuest)

## License

MIT.
