/**
 * Browser bundle entry — the ONE module esbuild bundles into
 * `web/engine.bundle.js`, exposing the in-app engine to the plain-script client
 * (web/transport.js) as a single global, `window.OmniDMEngine`.
 *
 * Why a bundle: the shared engine is many ES modules with `.js`-suffixed
 * relative imports (Node ESM shape). Rather than ship a module graph the page
 * would fetch piecemeal, esbuild inlines it into one same-origin script — no
 * external origins, no CDN, loadable under the CSP's `script-src 'self'`.
 * Rebuild with `npm run build:web` (see scripts/build-web.mjs). The Node card
 * loader (URL/file, node: builtins) is stubbed out at build time — in-app card
 * import is upload-only via `loadCardFromBytes`.
 */
import { createLocalEngine } from './local-engine.js';
import { loadCardFromBytes } from '../core/cards/card-browser.js';

const api = { createLocalEngine, loadCardFromBytes };

// Expose to the plain-script client. `globalThis` so the bundle format is
// environment-agnostic (window in the page; the smoke reads it the same way).
(globalThis as unknown as { OmniDMEngine: typeof api }).OmniDMEngine = api;

export { createLocalEngine, loadCardFromBytes };
