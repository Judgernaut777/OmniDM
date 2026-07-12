# Supported Versions

OmniDM has not yet cut a 1.0 release. Until then, the supported version is:

| Version            | Supported          | Notes                                  |
| ------------------ | ------------------ | -------------------------------------- |
| `main` (unreleased)| :white_check_mark: | Active development; release-candidate. |
| `0.1.x`            | :white_check_mark: | Current pre-release line.              |
| `< 0.1`            | :x:                | Unsupported.                           |

## Policy (from 1.0 onward)

Once 1.0 ships, OmniDM will follow [Semantic Versioning](https://semver.org):

- **Latest minor** of the current major receives features and fixes.
- **Previous minor** receives security fixes only, for 90 days after a new minor.
- Session save format and content-pack schema changes are versioned and
  migrated (see [docs/MIGRATION.md](docs/MIGRATION.md)); a documented migration
  path is provided across any breaking storage change.

## Supported platforms & integrations

Platform/integration support is tracked separately in
[docs/SUPPORT_MATRIX.md](docs/SUPPORT_MATRIX.md). In short: Discord is the
supported chat integration; Electron (Linux) and the container image are the
supported deployment targets; Slack/Matrix/Mattermost are experimental and
Tauri/Capacitor are frozen.

Security reporting: see [SECURITY.md](SECURITY.md).
