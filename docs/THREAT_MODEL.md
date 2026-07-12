# Threat Model

Scope: the supported OmniDM surface — the engine, the web/server multiplayer
adapter, the in-app ("Play on this device") engine, the Discord bot, content
packs, and provider handling. Archived adapters (Slack/Matrix/Mattermost) and
frozen targets (Tauri/Capacitor) are **out of scope**.

This document uses a lightweight STRIDE-style pass over the assets and trust
boundaries. It records what is mitigated and what residual risk an operator
accepts.

## Assets

1. **Model API keys.** In server mode, the operator's key in the server
   environment. In "Play on this device" mode, the player's key in their browser.
2. **Session / campaign state.** Characters, spells, inventory, HP, lorebook,
   history — JSON under `DATA_DIR`.
3. **Private (fog-of-war) narration.** DM whispers meant for a single player.
4. **Character seats.** The binding of a player to a character.
5. **Host integrity.** The server process and the machine it runs on.

## Actors & trust boundaries

- **Operator** (trusted): runs the server / bot, holds the server key.
- **Player** (semi-trusted): connects over WebSocket or Discord; may be hostile
  toward other players (seat/whisper theft) but not the host.
- **Model provider** (semi-trusted): receives prompts; may misbehave (echo keys
  in errors, return junk).
- **Content-pack author** (semi-trusted): supplies declarative pack data.
- **Network attacker** (untrusted): between clients and server.

## Threats & mitigations

### Spoofing / seat hijack
- **Threat:** a fresh connection claims another player's character (and its fog
  whispers) via `/dm join <name>`.
- **Mitigation:** character seats are bound to a **client-owned resume token**;
  reclaim-by-name is authorized only on a matching token. Stable-id adapters
  (Discord) reconnect by user id and are not reclaimable by name at all.

### Tampering (mechanics via narration)
- **Threat:** the model narrates outcomes it shouldn't decide (fudged damage,
  invented saves, phantom spell slots).
- **Mitigation:** the **engine owns all mechanical numbers** (HP, dice, slots,
  AC, damage, conditions). The model only narrates already-resolved results;
  `<<…>>` markers it emits are parsed, applied, and stripped by the engine and
  are ignored for non-combatants.

### Information disclosure (secrets)
- **Threat 1:** a misconfigured OpenAI-compatible gateway echoes the submitted
  key in an error body, which server mode would fan out to every seat.
  **Mitigation:** provider errors are scrubbed of API-key-shaped strings before
  logging/broadcast, and server mode shows every seat only a **generic** failure
  notice — never the raw provider error.
- **Threat 2:** XSS exfiltrates a browser-stored key.
  **Mitigation:** all player/DM text is rendered with `textContent` (never
  `innerHTML`); CSP restricts script sources; the key is sent only to the
  configured provider origin. **Residual risk:** a single XSS in a page a key is
  loaded into can still exfiltrate it — a documented BYO-key trade-off.

### Information disclosure (fog)
- **Threat:** a player reads another's private narration.
- **Mitigation:** whispers are delivered per-user (targetUserId); a whisper for
  a character only goes to the live seat owner (verified by resume token). If a
  private DM channel is refused (Discord), a content-free notice is sent, never
  the secret.

### Denial of service / resource abuse
- **Threat:** oversized payloads, message floods, malicious imports.
- **Mitigation:** the web adapter rate-limits messages and frames, caps text /
  name / portrait / frame sizes, and limits unjoined-connection traffic.
  `/dm import` guards against **SSRF**, **local file reads outside the data
  dir**, and **zip bombs**, with a byte cap on cards.

### Elevation via content packs
- **Threat:** a pack executes arbitrary code.
- **Mitigation:** packs are **declarative JSON only** — no executable code. They
  are size-limited, schema-validated, and scoped to the loading session (no
  process-global mutation).

### Host / shell (desktop)
- **Threat:** the Electron shell exposes Node to remote content.
- **Mitigation:** context isolation on, sandbox on, no preload bridge, a CSP
  header, `will-navigate` restricted, and `openExternal` scheme-allowlisted.

## Operator responsibilities (residual risk)

- **Terminate TLS** at a reverse proxy; OmniDM speaks plain HTTP/WS.
- **Set `WEB_PASSWORD`** for a non-public room.
- **Keep the server key in the server environment**, never in client config.
- **Run the container as shipped** (non-root, dropped caps, read-only FS).
- Trust in the configured **model provider** is the operator's to grant.

## Out of scope

- Vulnerabilities requiring an already-compromised host or operator.
- The archived Slack/Matrix/Mattermost adapters.
- Third-party provider infrastructure security.
- Windows/macOS packaging and signing (documented separately).
