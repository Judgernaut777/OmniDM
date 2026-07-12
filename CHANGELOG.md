# Changelog

All notable changes to OmniDM are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and from 1.0 onward this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Engine-owned spells** (`src/core/rules/spells.ts`): deterministic cast
  resolution for spell attack rolls (d20 + attack vs AC, nat-20 crit doubles the
  damage dice), saving throws (target saves vs the caster's DC, half-on-save),
  automatic damage (Magic Missile), healing, and condition spells (Hold Person).
  Engine-owned spell slots per level, learned spells, spell save DC / attack
  bonus, and long-rest restore. Bundled `SPELLBOOK` spanning cantrips–level 3.
- **Engine-owned inventory & equipment** (`src/core/rules/inventory.ts`):
  bundled `ARMORY`; equipping a weapon becomes the character's attack profile and
  worn armor + shield recompute AC, so `/dm attack` and incoming hits resolve
  against real gear. Potions heal through the shared HP path. Give / equip /
  unequip / use / drop with stacking.
- 19 new `/dm` commands (`cast`, `learn`, `slots`, `castdc`, `spellbook`, `rest`,
  `give`, `equip`, `unequip`, `use`, `drop`, `spells`, `items`, `inventory`, …).
- Narrator surfaces each character's spell slots, known spells, and equipped gear
  as read-only prompt context.
- Governance files: `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SUPPORTED_VERSIONS.md`, `SUPPORT.md`, issue/PR templates.
- Documentation set: `docs/SUPPORT_MATRIX.md`, `docs/ARCHIVED_INTEGRATIONS.md`,
  `docs/DEPLOYMENT.md`, `docs/THREAT_MODEL.md`, `docs/BROWSER_TESTING.md`,
  `docs/RELEASE_GUIDE.md`.
- **Containerization**: multi-stage `Dockerfile` (non-root, healthcheck,
  production-only deps), `docker-compose.yml` (persistent volume, read-only root
  FS, dropped capabilities, `no-new-privileges`), and `.dockerignore`.

### Product scope

- **Focused supported surface** (see `docs/SUPPORT_MATRIX.md`): Discord is the
  supported chat integration; Slack/Matrix/Mattermost are archived/experimental;
  Electron (Linux) and the container image are the supported deployment targets;
  Tauri/Capacitor are frozen.
- The archived Slack/Matrix adapter packages (`@slack/bolt`, `matrix-bot-sdk`)
  moved to `optionalDependencies`; `index.ts` now loads those adapters
  **dynamically** (only when selected), so the supported CLI/Discord/web surface
  boots without them and the production container image omits them entirely.

### Changed

- **Browser smoke harness hardened** (`src/smoke/harness.ts`): the headless
  chromium checks now run through a single `chromiumDumpDom` helper that launches
  chromium detached and SIGKILLs the whole process group on timeout, using the
  modern `--headless=new --ozone-platform=headless` path with the display env
  stripped. This replaces the fragile per-call `spawnSync(…, { timeout })` that
  could hang the whole suite forever (and leak chromium children) on a
  Wayland/desktop host. The suite now always completes in bounded time and reaps
  orphaned processes.
- **CI** (`.github/workflows/ci.yml`): browser checks are now required — chromium
  install is mandatory, smoke runs under `xvfb`, an explicit step asserts zero
  skipped checks, `npm test` runs, and browser diagnostics upload on failure. A
  non-blocking Electron-Linux AppImage packaging job was added.

### Documentation

- Rules markdown gains a "Spells and gear" section (bundle regenerated
  byte-identical).

## [0.1.0] — pre-release

Initial pre-release: multi-platform, multi-player, model-agnostic AI Dungeon
Master with a real rules engine (HP, checks, conditions, initiative, monsters,
attacks), character cards, lorebook, fog-of-war, vector memory, a web/desktop
table UI, content packs, and a Stripe billing scaffold. See the project history
for details.

[Unreleased]: https://github.com/Judgernaut777/OmniDM/compare/main...HEAD
