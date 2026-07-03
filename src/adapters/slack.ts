/**
 * Slack adapter. Translates Slack messages to/from the canonical types via
 * @slack/bolt in Socket Mode — no public URL or event subscription needed.
 *
 * Setup: create an app at https://api.slack.com/apps, enable Socket Mode (get
 * an app-level token with `connections:write` → SLACK_APP_TOKEN), add a bot
 * with `chat:write`, `channels:history`, `groups:history` + `users:read`
 * scopes and subscribe it to `message.channels` (→ SLACK_BOT_TOKEN), then
 * invite it to a channel. A game lives in whichever channel it's started in.
 *
 * Fog-of-war whispers (`targetUserId`) are delivered as ephemeral messages —
 * visible in the channel, but only to that player.
 */
import { App, LogLevel } from '@slack/bolt';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../core/types.js';

export class SlackAdapter implements PlatformAdapter {
  readonly name = 'slack';
  private app: App;
  private handler?: (msg: IncomingMessage) => void | Promise<void>;
  private names = new Map<string, string>(); // userId → display name cache

  constructor(botToken: string, appToken: string) {
    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must both be set for the Slack adapter (Socket Mode). See .env.example.',
      );
    }
    // deferInitialization keeps the constructor offline: without it, Bolt fires
    // an auth.test immediately as a floating promise, and a bad token becomes an
    // unhandled rejection that kills the process instead of failing in start().
    this.app = new App({ token: botToken, appToken, socketMode: true, logLevel: LogLevel.WARN, deferInitialization: true });
  }

  onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    await this.app.init(); // deferred from the constructor — a bad token fails here, loudly
    this.app.message(async ({ message }) => {
      // Plain user messages only — subtypes cover bot posts, edits, joins, etc.
      if (message.subtype !== undefined || !message.user || !message.text) return;
      await this.handler?.({
        platform: 'slack',
        channelId: message.channel,
        userId: message.user,
        userName: await this.userName(message.user),
        text: message.text,
        raw: message,
      });
    });

    await this.app.start();
    console.log('🤖 Slack connected in Socket Mode. Invite the bot to a channel and type /dm help.');
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }

  async send(msg: OutgoingMessage): Promise<void> {
    // Private (fog-of-war) delivery: an ephemeral message only the target sees.
    if (msg.targetUserId) {
      await this.app.client.chat.postEphemeral({
        channel: msg.channelId,
        user: msg.targetUserId,
        text: `🌫️ ${msg.text}`,
      });
      return;
    }
    await this.app.client.chat.postMessage({ channel: msg.channelId, text: msg.text });
  }

  /** Resolve a Slack user id to a display name, cached per process. */
  private async userName(userId: string): Promise<string> {
    const cached = this.names.get(userId);
    if (cached) return cached;
    let name = userId;
    try {
      const { user } = await this.app.client.users.info({ user: userId });
      name = user?.profile?.display_name || user?.real_name || user?.name || userId;
    } catch {
      // users:read missing or transient failure — fall back to the raw id.
    }
    this.names.set(userId, name);
    return name;
  }
}
