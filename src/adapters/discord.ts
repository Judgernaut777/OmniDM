/**
 * Discord adapter. Translates Discord messages to/from the canonical types.
 * The engine never sees a Discord object — only IncomingMessage/OutgoingMessage.
 *
 * Setup: create an app at https://discord.com/developers/applications, add a
 * bot, enable the MESSAGE CONTENT INTENT, invite it to your server, and put the
 * token in DISCORD_TOKEN. A game lives in whichever channel it's started in.
 */
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../core/types.js';

export class DiscordAdapter implements PlatformAdapter {
  readonly name = 'discord';
  private client: Client;
  private handler?: (msg: IncomingMessage) => void | Promise<void>;

  constructor(private token: string) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });
  }

  onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (!this.token) throw new Error('DISCORD_TOKEN is not set. See .env.example.');

    this.client.once(Events.ClientReady, (c) => {
      console.log(`🤖 Discord connected as ${c.user.tag}. Invite it to a server and type /dm help in a channel.`);
    });

    this.client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot) return;
      await this.handler?.({
        platform: 'discord',
        channelId: message.channelId,
        userId: message.author.id,
        userName: message.member?.displayName || message.author.username,
        text: message.content,
        raw: message,
      });
    });

    await this.client.login(this.token);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  async send(msg: OutgoingMessage): Promise<void> {
    const channel = await this.client.channels.fetch(msg.channelId);
    if (channel && channel.isTextBased() && 'send' in channel) {
      // Discord caps messages at 2000 chars — chunk long narration.
      for (const chunk of chunkText(msg.text, 1900)) {
        await channel.send(chunk);
      }
    }
  }
}

function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
