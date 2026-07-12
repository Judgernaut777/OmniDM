# Release Guide

OmniDM has not yet cut 1.0. This guide describes how a release is produced, what
is automated on Linux, and the platform-specific steps that are **blocked** on
this environment and must run on the appropriate OS with the appropriate
credentials.

## Versioning

- [Semantic Versioning](https://semver.org) from 1.0 onward.
- `feat:` → minor, `fix:` → patch, breaking changes → major (and a documented
  migration — see [MIGRATION.md](MIGRATION.md)).
- Update `CHANGELOG.md` (move `Unreleased` to the new version) and
  `package.json` `version` in the release PR.

## Release checklist (Linux-completable)

1. All CI gates green on `main` (typecheck, build:web + bundle freshness, smoke
   with **0 skipped** browser checks, `npm test`).
2. `CHANGELOG.md` updated; version bumped in `package.json`.
3. Tag the release: `git tag vX.Y.Z && git push --tags`
   *(tag only for a real release milestone — never speculatively)*.
4. Build artifacts (below), generate checksums and an SBOM, attach to the GitHub
   Release.
5. Verify artifacts install/boot (container boot + health, Electron Linux
   AppImage launch).

## Artifacts (Linux)

### Container image

```bash
docker build -t ghcr.io/<owner>/omnidm:vX.Y.Z .
docker run --rm -p 8787:8787 -e LLM_API_KEY=... ghcr.io/<owner>/omnidm:vX.Y.Z
```

Publishing to a registry requires registry credentials (external — deferred to
the operator/CI secret).

### Electron — Linux AppImage

```bash
npm ci
npm run build:web
npx electron-builder --linux AppImage --publish never
# → release/OmniDM-X.Y.Z-<arch>.AppImage
```

### Checksums

```bash
cd release && sha256sum *.AppImage > SHA256SUMS
```

### SBOM

Generate a CycloneDX SBOM from the production dependency tree:

```bash
npx @cyclonedx/cyclonedx-npm --omit dev --output-file sbom.json
```

(Include `--omit optional` to match the shipped server image, which omits the
archived-adapter packages.)

## Blocked: platform-specific signing & validation

These require an OS and/or commercial credentials that are **not available in a
Linux environment**. They are documented here so they can be executed on the
right host when those are available — do **not** fabricate or skip them.

### Windows (requires Windows + code-signing certificate)

- Build the NSIS installer: `npx electron-builder --win nsis`.
- Sign the `.exe`/installer with a code-signing certificate
  (`signtool sign /fd sha256 /tr <timestamp-url> ...`, or electron-builder's
  `win.certificateFile`/`certificatePassword`).
- Verify the signature and that SmartScreen reputation is acceptable.
- Test install/uninstall on a clean Windows machine.
- **Blocked reason:** no Windows host; no Authenticode certificate.

### macOS (requires macOS + Apple Developer credentials)

- Build the DMG: `npx electron-builder --mac dmg`.
- Sign with an Apple Developer ID Application certificate (hardened runtime).
- **Notarize** with `notarytool` and staple the ticket.
- Verify Gatekeeper acceptance (`spctl -a -vvv`) and DMG integrity.
- Test native install on a clean macOS machine.
- **Blocked reason:** no macOS host; no Apple Developer ID / notarization
  credentials.

### Mobile (requires store accounts + devices)

- App Store / Play Store submission and physical-device testing.
- **Blocked reason:** store credentials and devices unavailable; the Capacitor
  target is frozen.

## Rollback

- Container: redeploy the previous image tag; session data persists in the
  volume and is forward/backward compatible within a minor (see MIGRATION.md).
- Electron: users reinstall the previous AppImage; session data is unaffected.
- Never ship a release that fails the migration-compatibility tests.

## External infrastructure (deferred, documented, not fabricated)

Registry credentials, TLS certificates, domain ownership, Discord production app
credentials, provider production keys, and commercial signing certificates are
operator/owner-provided. Verification procedures for each live in the relevant
guide; none are invented here.
