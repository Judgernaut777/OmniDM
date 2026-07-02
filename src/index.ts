/**
 * Entrypoint. Wires a platform adapter to the bot core and starts it.
 *
 *   npm run cli       → terminal adapter (zero setup, great for testing)
 *   npm run discord   → Discord adapter (needs DISCORD_TOKEN)
 *   npm run slack     → Slack adapter (needs SLACK_BOT_TOKEN + SLACK_APP_TOKEN)
 *   npm run matrix    → Matrix adapter (needs MATRIX_HOMESERVER_URL + MATRIX_ACCESS_TOKEN)
 *   npm run mattermost → Mattermost adapter (needs MATTERMOST_URL + MATTERMOST_TOKEN)
 *
 * Adding a platform = writing one PlatformAdapter and adding a case below.
 */
import { loadConfig } from './config.js';
import { createProvider } from './providers/index.js';
import { Bot } from './core/bot.js';
import { CliAdapter } from './adapters/cli.js';
import { DiscordAdapter } from './adapters/discord.js';
import { SlackAdapter } from './adapters/slack.js';
import { MatrixAdapter } from './adapters/matrix.js';
import { MattermostAdapter } from './adapters/mattermost.js';
import type { PlatformAdapter } from './core/types.js';

function pickAdapter(name: string, config: ReturnType<typeof loadConfig>): PlatformAdapter {
  switch (name) {
    case 'discord':
      return new DiscordAdapter(config.discord.token);
    case 'slack':
      return new SlackAdapter(config.slack.botToken, config.slack.appToken);
    case 'matrix':
      return new MatrixAdapter(config.matrix.homeserverUrl, config.matrix.accessToken, config.dataDir);
    case 'mattermost':
      return new MattermostAdapter(config.mattermost.url, config.mattermost.token);
    case 'cli':
    default:
      return new CliAdapter();
  }
}

async function main() {
  const config = loadConfig();
  const adapterArg = process.argv.includes('--adapter')
    ? process.argv[process.argv.indexOf('--adapter') + 1]
    : 'cli';

  if (!config.llm.apiKey && config.llm.baseUrl.includes('openrouter')) {
    console.warn(
      '⚠️  No LLM_API_KEY set. Get a free OpenRouter key at https://openrouter.ai/keys and put it in .env\n' +
        '   (Local backends like Ollama/LM Studio do not need a key — just change LLM_BASE_URL.)\n',
    );
  }

  const provider = createProvider(config);
  const bot = new Bot(config, provider);
  const adapter = pickAdapter(adapterArg, config);

  adapter.onMessage((msg) => bot.handle(msg, (out) => adapter.send(out)));

  process.on('SIGINT', async () => {
    await adapter.stop();
    process.exit(0);
  });

  console.log(`Starting OmniDM with the "${adapter.name}" adapter…`);
  await adapter.start();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
