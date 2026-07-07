/**
 * Entrypoint. Wires a platform adapter to the bot core and starts it.
 *
 *   npm run cli       → terminal adapter (zero setup, great for testing)
 *   npm run discord   → Discord adapter (needs DISCORD_TOKEN)
 *   npm run slack     → Slack adapter (needs SLACK_BOT_TOKEN + SLACK_APP_TOKEN)
 *   npm run matrix    → Matrix adapter (needs MATRIX_HOMESERVER_URL + MATRIX_ACCESS_TOKEN)
 *   npm run mattermost → Mattermost adapter (needs MATTERMOST_URL + MATTERMOST_TOKEN)
 *   npm run web       → browser adapter (loopback HTTP + WebSocket, zero tokens)
 *
 * Adding a platform = writing one PlatformAdapter and adding a case below.
 */
import path from 'node:path';
import { loadConfig } from './config.js';
import { createProvider } from './providers/index.js';
import { Bot } from './core/bot.js';
import { NodeFileStorage } from './core/session/store.js';
import { FilePurchaseStore } from './core/billing/store-node.js';
import { createBillingHandler, type BillingHttpRequest, type BillingHttpResponse } from './core/billing/handler.js';
import { CliAdapter } from './adapters/cli.js';
import { DiscordAdapter } from './adapters/discord.js';
import { SlackAdapter } from './adapters/slack.js';
import { MatrixAdapter } from './adapters/matrix.js';
import { MattermostAdapter } from './adapters/mattermost.js';
import { WebAdapter } from './adapters/web.js';
import type { PlatformAdapter } from './core/types.js';

/** Exported for tests: pure adapter-selection logic, no process/env access. */
export function pickAdapter(
  name: string,
  config: ReturnType<typeof loadConfig>,
  storage: NodeFileStorage,
  billingHandler?: (req: BillingHttpRequest) => Promise<BillingHttpResponse>,
): PlatformAdapter {
  switch (name) {
    case 'discord':
      return new DiscordAdapter(config.discord.token);
    case 'slack':
      return new SlackAdapter(config.slack.botToken, config.slack.appToken);
    case 'matrix':
      return new MatrixAdapter(config.matrix.homeserverUrl, config.matrix.accessToken, config.dataDir);
    case 'mattermost':
      return new MattermostAdapter(config.mattermost.url, config.mattermost.token);
    case 'web':
      // Share the Bot's storage so the adapter can enrich the roster and serve
      // card portraits from the same live session state.
      return new WebAdapter(config.web.host, config.web.port, config.web.password, undefined, undefined, storage, billingHandler);
    case 'cli':
    default:
      return new CliAdapter();
  }
}

/** Exported for tests: pure argv parsing, no process access. */
export function parseAdapterArg(argv: string[]): string {
  const idx = argv.indexOf('--adapter');
  return idx !== -1 && argv[idx + 1] ? argv[idx + 1] : 'cli';
}

async function main() {
  const config = loadConfig();
  const adapterArg = parseAdapterArg(process.argv);

  if (!config.llm.apiKey && config.llm.baseUrl.includes('openrouter')) {
    console.warn(
      '⚠️  No LLM_API_KEY set. Get a free OpenRouter key at https://openrouter.ai/keys and put it in .env\n' +
        '   (Local backends like Ollama/LM Studio do not need a key — just change LLM_BASE_URL.)\n',
    );
  }

  const provider = createProvider(config);
  const storage = new NodeFileStorage(config.dataDir);

  // Hosted billing (opt-in): a persistent purchase store feeds the entitlements
  // gate live, and a billing HTTP handler (Stripe checkout/webhook) is mounted
  // on the web adapter. Off entirely for self-host — nothing is gated there.
  let purchases: FilePurchaseStore | undefined;
  let billingHandler: ((req: BillingHttpRequest) => Promise<BillingHttpResponse>) | undefined;
  if (config.billing.enabled) {
    purchases = await new FilePurchaseStore(config.billing.storeFile).load();
    billingHandler = createBillingHandler({
      store: purchases,
      prices: config.billing.prices,
      apiKey: config.billing.secretKey,
      webhookSecret: config.billing.webhookSecret,
      successUrl: config.billing.successUrl,
      cancelUrl: config.billing.cancelUrl,
      mode: config.billing.mode,
    });
    console.log(`💳 Hosted billing enabled — ${Object.keys(config.billing.prices).length} purchasable pack(s), unlocks persisted to ${config.billing.storeFile}.`);
  }

  const bot = new Bot(config, provider, storage, undefined, 'server', purchases);
  const adapter = pickAdapter(adapterArg, config, storage, billingHandler);

  adapter.onMessage((msg) => bot.handle(msg, (out) => adapter.send(out)));

  process.on('SIGINT', async () => {
    await adapter.stop();
    process.exit(0);
  });

  console.log(`Starting OmniDM with the "${adapter.name}" adapter…`);
  await adapter.start();
}

// Only run when executed directly (e.g. `tsx src/index.ts`) — importing this
// module (as the smoke test does, to exercise pickAdapter/parseAdapterArg)
// must not start a live adapter as a side effect.
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file://${path.resolve(process.argv[1] ?? '')}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
