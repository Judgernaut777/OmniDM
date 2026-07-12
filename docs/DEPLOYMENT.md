# Deployment Guide

OmniDM's supported deployment targets are the **container image** and **bare
Node (>= 22)**, running the multiplayer **web adapter** (and optionally the
**Discord** bot). This guide covers a secure self-hosted deployment on Linux.

## 1. Container (recommended)

### Quick start

```bash
cp .env.example .env      # set LLM_BASE_URL / LLM_API_KEY (and WEB_PASSWORD)
docker compose up -d
docker compose logs -f
```

The web table UI is served on `http://<host>:8787/`. Session data persists in
the `omnidm-data` named volume.

### What the image does

- Multi-stage build; runtime carries **production dependencies only**
  (`npm ci --omit=dev --omit=optional`). The archived Slack/Matrix adapter
  packages are omitted — they are loaded dynamically only if you select those
  adapters, so the supported surface boots without them.
- Runs as a **non-root** user (`uid 10001`).
- `HEALTHCHECK` probes the web port; Compose adds `no-new-privileges`, a
  read-only root filesystem (writable `/data` volume + `/tmp` tmpfs), and drops
  all Linux capabilities.
- Session data at `/data` (`DATA_DIR=/data`).

### Configuration (environment variables)

| Variable        | Default                          | Purpose                                   |
| --------------- | -------------------------------- | ----------------------------------------- |
| `WEB_HOST`      | `0.0.0.0` (image) / `127.0.0.1`  | Bind address.                             |
| `WEB_PORT`      | `8787`                           | Listen port.                              |
| `WEB_PASSWORD`  | (empty)                          | Optional room password.                   |
| `DATA_DIR`      | `/data` (image) / `./data`       | Session/persistence directory.            |
| `LLM_BASE_URL`  | OpenRouter                       | OpenAI-compatible endpoint.               |
| `LLM_API_KEY`   | (empty)                          | Provider key (omit for local backends).   |
| `LLM_MODEL`     | provider default                 | Model id.                                 |

Billing (`STRIPE_*`) is off unless explicitly enabled; self-host gates nothing.

## 2. Bare Node

```bash
npm ci
npm run build:web
WEB_HOST=0.0.0.0 WEB_PORT=8787 DATA_DIR=/var/lib/omnidm npm run web
```

Run under a process supervisor (systemd, pm2). A minimal systemd unit:

```ini
[Unit]
Description=OmniDM web server
After=network.target

[Service]
User=omnidm
Environment=WEB_HOST=0.0.0.0 WEB_PORT=8787 DATA_DIR=/var/lib/omnidm
WorkingDirectory=/opt/omnidm
ExecStart=/usr/bin/npx tsx src/index.ts --adapter web
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/omnidm

[Install]
WantedBy=multi-user.target
```

## 3. TLS / reverse proxy

OmniDM speaks plain HTTP/WebSocket. **Terminate TLS at a reverse proxy**
(Caddy, nginx, Traefik) in front of it; do not expose it directly to the
internet without TLS. The proxy must forward WebSocket upgrades. Example (Caddy):

```
dm.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Obtaining a certificate and owning `dm.example.com` are **operator
responsibilities** (external infrastructure — see the blocked list in
[SUPPORT_MATRIX.md](SUPPORT_MATRIX.md)).

## 4. Discord

Set `DISCORD_TOKEN` and run `--adapter discord` (or a second container/service).
Creating a Discord application and bot token is an operator step requiring a
Discord account (external credential). See [DISCORD_GUIDE.md](DISCORD_GUIDE.md).

## 5. Backups & restore

Session state is JSON files under `DATA_DIR`. Back up that directory (or the
Docker volume). See [BACKUP.md](BACKUP.md) and [MIGRATION.md](MIGRATION.md) for
the archive format, integrity verification, and cross-version upgrades.

## 6. Security

Read [SECURITY_GUIDE.md](SECURITY_GUIDE.md) and [THREAT_MODEL.md](THREAT_MODEL.md)
before exposing a public instance. Key points: bind behind TLS, set a
`WEB_PASSWORD`, keep provider keys in the server environment (never in the
client), and run the container as provided (non-root, dropped caps).
