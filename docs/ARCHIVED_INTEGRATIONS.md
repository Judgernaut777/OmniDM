# Archived / Experimental Integrations

To keep the supported surface focused and high-quality, three chat integrations
are **archived (experimental)** and two desktop/mobile packaging targets are
**frozen**. They remain in the source tree for anyone who wants them, but they
are not part of the supported product.

See [SUPPORT_MATRIX.md](SUPPORT_MATRIX.md) for the authoritative status table.

## Archived chat integrations: Slack, Matrix, Mattermost

Adapters: `src/adapters/slack.ts`, `src/adapters/matrix.ts`,
`src/adapters/mattermost.ts`.

**What "archived / experimental" means here:**

- Not covered by the supported product or its support/security promises.
- Excluded from the required CI gates and from release documentation.
- Their npm dependencies (`@slack/bolt`, `matrix-bot-sdk`) are **optional** — a
  default/production install does not need them, and the container image and
  release artifacts do not bundle them. Install them yourself if you run one.
- The adapters are still wired into the launcher (`npm run slack` / `matrix` /
  `mattermost`) and still exercised by the existing engine tests, so they should
  keep working — but changes to them are best-effort and unsupported.

**Why:** OmniDM's competitive wedge is "an AI DM inside the Discord your group
already uses." Maintaining four chat platforms diluted focus. Discord is the one
supported integration; the rest are experimental.

**If you depend on one of these:** you are welcome to run it, and to open PRs,
but treat it as community-maintained. If there is sustained demand and a
maintainer, an integration can be promoted back to supported.

## Frozen packaging targets: Tauri, Capacitor

- **Tauri** (`src-tauri/`): scaffold only. It requires `webkit2gtk` on Linux and
  is not built or shipped. Electron is the supported desktop target because it
  bundles its own Chromium and builds without system WebKit.
- **Capacitor** (`capacitor.config.ts`, `android/`, `ios/`): scaffold only. iOS
  requires macOS + Xcode; Android requires the SDK; store release is out of
  scope. Mobile is frozen.

"Frozen" means: present, buildable in principle on the right host, but not
maintained, tested, or shipped as part of a release.

## Removing them entirely

A future change may physically extract the archived adapters into a separate
`contrib/` area or optional package. Until then they stay in place, clearly
labelled, with their dependencies optional. This document is the record of that
decision.
