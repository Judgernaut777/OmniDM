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
| **Memory** | Rolling "living summary" compaction of old turns | NeverEndingQuest / NarrativeEngine-P |
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

## Using whatever model you want

Everything goes through one OpenAI-compatible endpoint, so you change backends by
editing **one line** in `.env`:

| Backend | `LLM_BASE_URL` | Notes |
|--------|----------------|-------|
| OpenRouter (default) | `https://openrouter.ai/api/v1` | One key → hundreds of models, incl. free + Claude |
| OpenAI | `https://api.openai.com/v1` | Your OpenAI key |
| Ollama (local) | `http://localhost:11434/v1` | No key needed, runs offline |
| LM Studio (local) | `http://localhost:1234/v1` | No key needed |

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
/dm import <src>        import a Character Card V2/V3 (JSON or PNG, path or URL)
/dm models [filter]     list usable models (🆓 = free)
/dm model <id>          pick the model for this game
/dm roll <notation>     roll dice (d20+5, 2d6, d20 adv, 4d6kh3)
/dm end                 end the campaign
```

Anything that isn't a command is treated as your character's action.

`/dm import` accepts the Character Card V2/V3 format (raw JSON or a card PNG
with the embedded `chara`/`ccv3` chunk). If you've already joined, the card
becomes **your persona**; otherwise it becomes an **NPC** the DM portrays.

## Architecture

```
adapters/        ← PlatformAdapter implementations (cli, discord, …)  [the moat]
  cli.ts
  discord.ts
core/
  bot.ts         ← platform-agnostic router (commands + turns)
  types.ts       ← canonical Message / Session / Provider contracts
  cards/
    card.ts      ← Character Card V2/V3 import (JSON or PNG-embedded)
  engine/
    dice.ts      ← deterministic roller (seedable)
    turn-pipeline.ts  ← the sandwich: lock → resolve → persist → narrate
  narrator/
    narrator.ts  ← builds the prompt; LLM narrates resolved turns
  session/
    session-manager.ts / store.ts  ← channel → game session, party, JSON persistence
providers/
  openai-compatible.ts  ← OpenRouter/OpenAI/Ollama/LM Studio (one adapter)
rules/
  dnd5e/system.md       ← swappable rules module
```

**Add a chat platform:** implement `PlatformAdapter` (4 methods) in `adapters/`,
add a case in `index.ts`. The engine doesn't change.

**Add a model backend:** implement `LLMProvider` (`listModels` + `complete`) in
`providers/`. For Anthropic-native billing, that's where SillyTavern's Claude
message-converter would live.

**Add a game system:** drop a `rules/<system>/system.md`. Set it per session.

## Roadmap / not done yet

- Initiative-rolled turn order (round-robin by join order is in: `/dm mode round-robin`)
- Lorebook / world-info injection (keyword-triggered context)
- Vector memory (RAG) alongside the living summary
- More adapters: Matrix, Slack, Mattermost, Signal (via signal-cli)
- Native Anthropic provider with the full Claude converter
- Per-player fog-of-war narration (daicer's `player_perspectives`)

## Prior art studied

[daicer](https://github.com/lguibr/daicer) ·
[open-tabletop-gm](https://github.com/Bobby-Gray/open-tabletop-gm) ·
[Agnai](https://github.com/agnaistic/agnai) ·
[SillyTavern](https://github.com/SillyTavern/SillyTavern) ·
[NarrativeEngine-P](https://github.com/Sagesheep/NarrativeEngine-P) ·
[NeverEndingQuest](https://github.com/MoonlightByte/NeverEndingQuest)

## License

MIT.
