# OmniDM

A **multi-platform, multi-player, model-agnostic AI Dungeon Master.** Run a
tabletop RPG with an AI game master in any chat channel, with any LLM, for any
number of players. Test for free; bring your own model when you're ready.

> Working name — rename freely. This is an early scaffold, not a finished product.

## Why this exists

The open-source landscape has lots of AI DMs, but each one is locked to **one
platform** (Discord *or* web) **or one model** (one vendor). None is all three of:
multi-platform, multi-player, and model-agnostic. OmniDM is built around that gap.

The design borrows deliberately from prior art (see [`docs` credits](#prior-art-studied)):

| Layer | Pattern | Borrowed from |
|------|---------|---------------|
| **Turn engine** | "Sandwich": lock → resolve dice (pure) → persist → LLM narrates the *resolved* outcome | daicer |
| **Dice/rules** | Standalone deterministic resolver; rules as swappable markdown modules | open-tabletop-gm |
| **Providers** | One canonical message format → per-backend converter | SillyTavern |
| **Memory** | Rolling "living summary" compaction + per-turn RAG recall (embedding or lexical) | NeverEndingQuest / NarrativeEngine-P |
| **Multiplayer** | Per-channel lock; shared session; targeted broadcast | Agnai / daicer |
| **Platform layer** | One `PlatformAdapter` interface; add a platform = add one file | *new — the moat* |

## Quick start (free, ~2 minutes)

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
  hotseat on one device. **Your key is stored only on this device** (localStorage)
  and is sent only to the LLM endpoint you configured; it is never logged, never
  written into a saved game, and never sent anywhere else. Games persist in the
  browser (IndexedDB / localStorage). Open `web/index.html` however you serve
  static files — e.g. `npm run web` and choose "Play on this device" — and no
  tokens or server round-trip are needed (the only network call is to your model).

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
/dm models [filter]     list usable models (🆓 = free)
/dm model <id>          pick the model for this game
/dm roll <notation>     roll dice (d20+5, 2d6, d20 adv, 4d6kh3)
/dm end                 end the campaign
```

Anything that isn't a command is treated as your character's action.

`/dm import` accepts the Character Card V2/V3 format (raw JSON or a card PNG
with the embedded `chara`/`ccv3` chunk). If you've already joined, the card
becomes **your persona**; otherwise it becomes an **NPC** the DM portrays.
A card's `character_book` is imported into the session lorebook automatically.
Because anyone in the channel can run it, sources are restricted: local paths
must live under `DATA_DIR`, URLs must be public http(s) (no loopback/private
addresses, no redirects), and downloads are size-capped.

`/dm lore` entries are keyword-triggered world info (SillyTavern's World Info
pattern): when an entry's keyword appears in the current action or recent
turns, its content is injected into the DM prompt as a bounded `WORLD INFO`
block. Entries with no keywords are always injected.

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
  session/
    session-manager.ts  ← channel → game session, party, seat re-claim after reconnect
    storage.ts   ← SessionStorage interface + MemoryStorage (the browser/mobile seam)
    store.ts     ← NodeFileStorage: JSON files under DATA_DIR
providers/
  openai-compatible.ts  ← OpenRouter/OpenAI/Ollama/LM Studio (one adapter)
  anthropic.ts          ← native Anthropic Messages API (system param + role converter)
rules/
  dnd5e/system.md       ← swappable rules module
browser/
  local-engine.ts  ← in-app composition root: wires Bot + RoomEngine + browser storage + provider (the LocalTransport's engine)
  engine-entry.ts  ← the one module esbuild bundles → web/engine.bundle.js (global OmniDMEngine)
scripts/
  build-web.mjs    ← esbuild bundle step for web/engine.bundle.js (npm run build:web); stubs the Node-only card loader
web/               ← browser client served by the web adapter
  index.html / app.js / style.css   ← table UI: launch/settings, log, roster, battle map, dice tray, character creator + card sheet
  transport.js     ← hybrid transport: RemoteTransport (WebSocket → server) | LocalTransport (in-page engine)
  engine.bundle.js ← the shared engine bundled for the browser (GENERATED by npm run build:web; committed)
  portraits.js     ← procedural heraldic crest portraits, shared by roster + token board
```

**Add a chat platform:** implement `PlatformAdapter` (4 methods) in `adapters/`,
add a case in `index.ts`. The engine doesn't change.

**Add a model backend:** implement `LLMProvider` (`listModels` + `complete`) in
`providers/`. `anthropic.ts` is the worked example: SillyTavern's Claude
message-converter pattern as a pure function plus a thin fetch wrapper.

**Add a game system:** drop a `rules/<system>/system.md`. Set it per session.

## Done

Shipped since the initial scaffold (newest first):

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

## Roadmap / not done yet

- Initiative-rolled turn order (round-robin by join order is in)
- More adapters: Signal (via signal-cli)
- More native providers beyond Anthropic

## Prior art studied

[daicer](https://github.com/lguibr/daicer) ·
[open-tabletop-gm](https://github.com/Bobby-Gray/open-tabletop-gm) ·
[Agnai](https://github.com/agnaistic/agnai) ·
[SillyTavern](https://github.com/SillyTavern/SillyTavern) ·
[NarrativeEngine-P](https://github.com/Sagesheep/NarrativeEngine-P) ·
[NeverEndingQuest](https://github.com/MoonlightByte/NeverEndingQuest)

## License

MIT.
