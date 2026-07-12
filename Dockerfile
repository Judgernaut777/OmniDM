# syntax=docker/dockerfile:1

# OmniDM server image — runs the multiplayer web adapter.
#
# Design:
#   - Multi-stage: a build stage produces the browser engine bundle; the runtime
#     stage carries only PRODUCTION dependencies (no dev, no optional).
#   - The archived Slack/Matrix adapters' packages are OPTIONAL and omitted here
#     (`--omit=optional`); index.ts loads those adapters dynamically, so the
#     supported CLI/Discord/web surface boots without them.
#   - Runs as a non-root user; a HEALTHCHECK probes the web port; session data
#     lives on a mounted volume at /data.
#   - The app runs via `tsx` (the same path as `npm run web`), installed globally
#     in the runtime stage so no TypeScript build artifact needs shipping.

# ---- build: produce web/engine.bundle.js -------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:web

# ---- deps: production-only node_modules --------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --omit=dev: no build tooling; --omit=optional: no archived-adapter packages.
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

# ---- runtime -----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    WEB_HOST=0.0.0.0 \
    WEB_PORT=8787 \
    DATA_DIR=/data
WORKDIR /app

# tsx runs the TypeScript entrypoint directly (matches `npm run web`).
RUN npm install -g tsx@4.19.1 && npm cache clean --force

# Production dependencies and application sources.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/web ./web
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# Non-root user; session data directory owned by it.
RUN useradd --system --uid 10001 --create-home omnidm \
    && mkdir -p /data \
    && chown -R omnidm:omnidm /app /data
USER omnidm

VOLUME ["/data"]
EXPOSE 8787

# Liveness: the web adapter serves the client at / — a 200 means it is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_PORT||8787)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["tsx", "src/index.ts", "--adapter", "web"]
