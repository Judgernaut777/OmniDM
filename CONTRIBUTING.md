# Contributing to OmniDM

Thanks for your interest in OmniDM — a multi-platform, model-agnostic AI
Dungeon Master. This guide covers how to get set up, the quality bar, and how
changes are reviewed.

## Ground rules

- Be respectful; see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- The engine owns the mechanical numbers (HP, dice, slots, AC, damage). The LLM
  **narrates** already-resolved outcomes — it never decides them. Keep this
  separation: new mechanics go in `src/core/rules`, not in prompts.
- No arbitrary executable code in content packs — packs are declarative JSON.
- Prefer additive, backward-compatible changes; sessions persist as JSON and
  new fields must be absent-safe.

## Prerequisites

- Node.js >= 22
- npm
- (optional) chromium at `/usr/bin/chromium` for the headless web-ui checks
- (optional) Docker for the container image

## Setup

```bash
npm install
cp .env.example .env   # add an LLM key if you want live model calls
npm run cli            # fastest way to exercise the engine
```

## Quality gates (run before every PR)

```bash
npm run typecheck      # tsc --noEmit, must be clean
npm run build:web      # rebuild web/engine.bundle.js (commit the result if changed)
npm run smoke          # counted smoke gate
npm test               # in-process node:test runner over the same sections
```

If you change `src/rules/dnd5e/system.md`, regenerate the bundled string:

```bash
node scripts/bundle-rules.mjs   # keeps src/core/rules/dnd5e.system.ts byte-identical
```

CI runs all of the above on Linux, including the headless browser checks under
xvfb; **browser checks must run, not skip.** See `.github/workflows/ci.yml`.

### A note on the smoke suite and headless browser checks

The browser (`web-ui: headless …`) checks shell out to chromium. They render
reliably on a headless CI runner. On a **Wayland desktop** they may not render;
the harness now runs chromium detached and kills the whole process group on
timeout, so the suite **completes with clean skips instead of hanging**. If you
develop on Wayland and want a fast full run, that's expected behaviour — CI is
the source of truth for the browser layer.

## Tests are required

Every behavioural change needs test coverage. Smoke sections live in
`src/smoke/sections/` and should be **self-contained** (build their own
Bot/provider/storage/channel) so they never pollute the shared MockProvider
state other sections rely on. Add pure-function tests for new rules modules and
bot-driven tests for new commands.

## Commit & PR conventions

- Conventional-commit-style subjects (`feat(rules): …`, `fix(web): …`,
  `docs: …`, `chore(ci): …`).
- One logical change per PR where practical; every PR must leave the repo in a
  releasable state (all gates green, no regressions).
- Fill out the pull-request template. Link related issues.
- Update docs and the [CHANGELOG](CHANGELOG.md) (Unreleased section) in the same
  PR as the change.

## Reporting bugs / requesting features

Use the issue templates. For security issues, follow
[SECURITY.md](SECURITY.md) — do **not** open a public issue.

## Product scope

OmniDM's supported surface is deliberately focused: **Discord** is the supported
chat integration; **Slack / Matrix / Mattermost are experimental/archived**;
**Electron (Linux)** is the supported desktop target; **Tauri and Capacitor are
frozen**. See [docs/SUPPORT_MATRIX.md](docs/SUPPORT_MATRIX.md). New work should
target the supported surface unless it is explicitly reviving an archived one.
