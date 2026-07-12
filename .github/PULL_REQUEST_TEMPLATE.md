<!-- Thanks for contributing to OmniDM! Please fill this out. -->

## Summary

<!-- What does this PR change, and why? -->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change (session format / content-pack schema / public behavior)
- [ ] Documentation
- [ ] CI / tooling / chore

## Checklist

- [ ] `npm run typecheck` is clean
- [ ] `npm run build:web` produced no uncommitted change to `web/engine.bundle.js`
- [ ] `npm run smoke` passes with **0 failed** (note any skips and why)
- [ ] `npm test` (node:test) passes
- [ ] If I changed `src/rules/dnd5e/system.md`, I ran `node scripts/bundle-rules.mjs`
- [ ] Added/updated tests for the behavior changed
- [ ] Updated documentation and `CHANGELOG.md` (Unreleased)
- [ ] Change is additive / backward-compatible, or a migration is included
- [ ] Considered security implications (secrets, input validation, authz)

## Scope

- [ ] Targets the supported surface (engine / web-server / Discord / Electron-Linux /
      container / content packs). If it touches an archived integration
      (Slack/Matrix/Mattermost) or a frozen target (Tauri/Capacitor), I explain why below.

## Testing / verification

<!-- How did you verify this works end-to-end? Commands, output, screenshots. -->

## Related issues

<!-- Closes #… -->
