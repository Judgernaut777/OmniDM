# Migration Guide

OmniDM is a pre-1.0 project on the `main` release-candidate line (version `0.1.x`).
This guide explains how to upgrade OmniDM, what data persists across versions, and
how to handle breaking changes when they occur.

## Overview

**Session data is forward-compatible within a minor version.** When you load a
campaign from an older release, OmniDM automatically applies defaults to any new
fields introduced in the current version, making the save file immediately usable
without manual migration.

All campaign state (characters, spells, inventory, HP, lorebook, history, fog of
war, and NPC data) is stored as JSON files under `DATA_DIR` (default: `./data`
locally or `/data` in the container). These files are human-readable and can be
inspected or backed up with standard tools.

## Upgrading

### Container

To upgrade the container image to a new version:

```bash
docker compose pull
docker compose up -d
```

Your existing session data in the `omnidm-data` volume persists and is
automatically migrated on the first load.

### Bare Node

To upgrade from source:

```bash
git pull origin main
npm ci
npm run build:web
npm run web   # or restart your systemd unit / process manager
```

Your session files in `DATA_DIR` persist and are automatically migrated on the
first load.

## Session data format

- **Storage:** JSON files under `DATA_DIR`, one file per session/room (e.g.,
  `session_my_room_<hash>.json`).
- **Durability:** writes are atomic (buffered to a temp file, then renamed onto
  the final path); a crash mid-write cannot corrupt the existing save.
- **Backup:** simply copy the `DATA_DIR` directory or Docker volume. No special
  tools or export formats are required.
- **Forward migration:** when you load a save from an older release, missing
  fields (e.g., newly added `npcs`, `lorebook`, `memories`, `fogOfWar`) are
  automatically populated with sensible defaults.

## Breaking changes

As of `0.1.0`, **no breaking changes have been introduced.** New fields and
features are added with backward-compatible defaults, so older saves load without
modification.

If a future release introduces a breaking change (e.g., a removal or incompatible
field rename), it will be documented here before the version is released. Never
upgrade to a version that introduces a breaking change for your active sessions
unless you have read and understood the migration steps below.

### Template for future breaking changes

When a breaking change occurs, it will be documented in this format:

```
### Version X.Y.Z

**Changed:** [Brief description of what changed — a field removed, renamed, or
incompatibly reformatted.]

**Affected saves:** [Which saves are affected, e.g., "all", or "only those with
feature X enabled".]

**How to migrate:** [Step-by-step instructions to update saves, if automatic
migration is not possible. If automatic, state "Automatic: see above." Otherwise,
provide a manual process, tool, or script.]

**Rollback:** [If rollback is possible, describe it. If not, state "Not
supported—back up before upgrading."]
```

## Downgrade / rollback

**Downgrade is supported** within the same minor version (e.g., `0.1.3` → `0.1.2`).
Session data is backward-compatible, so an older release can load and run with
saves from a newer patch.

**Downgrade across minors (e.g., `0.2.0` → `0.1.x`) is not tested and not
recommended.** If you must downgrade, restore from a backup (see
[DEPLOYMENT.md](DEPLOYMENT.md)) before downgrading the application.

## See also

- [RELEASE_GUIDE.md](RELEASE_GUIDE.md) — how releases are versioned and published.
- [DEPLOYMENT.md](DEPLOYMENT.md) — deployment and backup procedures.
- [SUPPORTED_VERSIONS.md](SUPPORTED_VERSIONS.md) — which versions are currently
  supported.
