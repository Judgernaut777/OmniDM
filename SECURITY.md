# Security Policy

OmniDM is a self-hostable AI Dungeon Master. Most deployments run on a
player's own machine or a small shared server, so the security model is built
around **self-hosting operators** and **the players who connect to them**.

## Supported versions

See [SUPPORTED_VERSIONS.md](SUPPORTED_VERSIONS.md). Security fixes land on the
latest released minor and on `main`.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Report privately through GitHub's **Security Advisories**
("Report a vulnerability" on the repository's *Security* tab). If that is
unavailable, open a minimal public issue that says only "security report — please
provide a private contact" without technical detail.

Please include:

- affected version / commit,
- a description of the issue and its impact,
- reproduction steps or a proof of concept,
- any suggested remediation.

**Target response times** (best-effort for a community project):

- acknowledgement: within 5 business days,
- triage + severity assessment: within 10 business days,
- fix or mitigation plan for confirmed high/critical issues: within 30 days.

We will credit reporters in the release notes unless you ask us not to.

## Scope

In scope:

- the engine and turn pipeline (`src/core`),
- the multiplayer server / web adapter and its WebSocket protocol,
- the Discord integration,
- the Electron desktop shell,
- content-pack loading and validation,
- provider (LLM) request handling and secret handling.

Explicitly **out of scope**:

- the archived/experimental Slack, Matrix, and Mattermost adapters
  (see [docs/SUPPORT_MATRIX.md](docs/SUPPORT_MATRIX.md)) — they are not part of the
  supported product and are not security-maintained;
- third-party model providers you configure (their API security is theirs);
- vulnerabilities that require an already-compromised host or operator.

## Security model & known trade-offs

These are documented so operators can make informed choices, not hidden:

- **Bring-your-own-key.** In "Play on this device" mode the model API key is
  stored in the browser (localStorage/sessionStorage) and sent only to the
  provider endpoint you configure. One cross-site-scripting bug in a page you
  load a key into is enough to exfiltrate that key — the client renders all
  player/DM text with `textContent` (never `innerHTML`) to mitigate this.
- **Server mode secrets.** A misconfigured OpenAI-compatible gateway can echo
  the submitted key in an error body; the server scrubs API-key-shaped strings
  from provider errors before logging or broadcasting them, and server mode
  shows every seat only a generic failure notice, never the raw provider error.
- **Seat ownership.** A character seat is bound to a client-owned resume token;
  a fresh connection cannot reclaim another player's character (and its private
  fog-of-war whispers) by name without that token.
- **Content packs are declarative data (JSON) only** — no arbitrary executable
  code. Imports are size-limited and validated; `/dm import` guards against
  SSRF, local file reads outside the data dir, and zip bombs.

For hardening a public deployment, see the security and deployment guides under
[`docs/`](docs/) (`SECURITY_GUIDE.md`, `DEPLOYMENT.md`, `THREAT_MODEL.md`).
