# Support Matrix

This is the authoritative statement of what OmniDM **supports**. "Supported"
means: maintained, tested in CI where possible, documented, and eligible for bug
and security fixes. Anything marked *experimental* or *frozen* is present in the
tree but not part of the supported product.

Last reviewed: 2026-07 (release-candidate hardening).

## Chat integrations

| Integration | Status           | Notes                                                                 |
| ----------- | ---------------- | --------------------------------------------------------------------- |
| Discord     | **Supported**    | The one supported chat integration. Tested and documented.            |
| Slack       | *Experimental*   | Archived. Adapter present but unmaintained; not in default install/CI/docs. |
| Matrix      | *Experimental*   | Archived. Adapter present but unmaintained.                           |
| Mattermost  | *Experimental*   | Archived. Adapter present but unmaintained.                           |

Rationale: maintaining four chat platforms diluted quality. OmniDM focuses on
Discord — "an AI DM inside the Discord your group already uses." The other
adapters remain in the source tree for anyone who wants them but carry no support
promise, are excluded from the required CI gates, and are documented as
experimental. See [ARCHIVED_INTEGRATIONS.md](ARCHIVED_INTEGRATIONS.md).

## Play surfaces

| Surface                        | Status         | Notes                                              |
| ------------------------------ | -------------- | -------------------------------------------------- |
| CLI (terminal)                 | **Supported**  | Fastest way to exercise the engine.                |
| Web / server (multiplayer)     | **Supported**  | Shared sessions over WebSocket.                    |
| Play on this device (in-app)   | **Supported**  | In-page engine bundle; BYO model, no server.       |
| Electron desktop (Linux)       | **Supported**  | AppImage; the supported desktop target.            |
| Electron desktop (Windows/macOS)| *Blocked*     | Builds, but signing/notarization needs those OSes. |
| Tauri desktop                  | *Frozen*       | Scaffold only; not built or shipped.               |
| Capacitor (iOS/Android)        | *Frozen*       | Scaffold only; store release out of scope.         |

## Deployment

| Target              | Status        | Notes                                            |
| ------------------- | ------------- | ------------------------------------------------ |
| Container image     | **Supported** | OCI image + compose; non-root; health/readiness. |
| Bare Node (>=22)    | **Supported** | `npm run web` / `npm run discord`.               |

## Providers

Model-agnostic by design. Any OpenAI-compatible endpoint (OpenRouter, Ollama,
LM Studio, vLLM, …) and the native Anthropic API are supported. Provider
*accounts and credentials* are yours; OmniDM does not ship keys.

## Platform-specific work that is explicitly blocked

These require an OS or credentials not available in a Linux CI environment and
are documented rather than attempted:

- **Windows:** code signing, installer verification, SmartScreen, native install
  testing.
- **macOS:** Apple code signing, notarization, Gatekeeper, DMG verification,
  native install testing.
- **Mobile:** App Store / Play Store release, physical-device testing.
- **External credentials / infra:** Discord production app credentials, provider
  production keys, hosted infrastructure, TLS certificates, domain ownership,
  commercial signing certificates.

See [docs/RELEASE_GUIDE.md](RELEASE_GUIDE.md) for the signing/notarization
procedures to run on the appropriate OS when those credentials are available.
