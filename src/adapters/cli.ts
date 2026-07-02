/**
 * CLI adapter — a terminal "platform" so the whole engine runs end-to-end with
 * zero bot setup and zero tokens (point it at a free model). Invaluable for
 * development: same code path as Discord, just stdin/stdout.
 *
 * Input is processed through a serial queue so messages can't interleave, and
 * the queue is drained before exit so async work (e.g. saving the session)
 * always completes — important when input is piped rather than typed.
 */
import * as readline from 'node:readline';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../core/types.js';

export class CliAdapter implements PlatformAdapter {
  readonly name = 'cli';
  private handler?: (msg: IncomingMessage) => void | Promise<void>;
  private rl?: readline.Interface;
  private queue: Promise<unknown> = Promise.resolve();

  onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('🎲 OmniDM CLI. Type `/dm help` to begin, or Ctrl+C to quit.\n');
    this.prompt();

    this.rl.on('line', (line) => {
      const text = line.trim();
      if (!text) return this.prompt();
      // Chain each line so handlers run one at a time and exit can await them.
      this.queue = this.queue
        .then(() =>
          this.handler?.({
            platform: 'cli',
            channelId: 'local',
            userId: 'local-user',
            userName: 'You',
            text,
          }),
        )
        .then(() => this.prompt());
    });

    await new Promise<void>((resolve) => {
      this.rl!.on('close', async () => {
        await this.queue; // drain pending work (saves, narration) before exiting
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.rl?.close();
    await this.queue;
  }

  async send(msg: OutgoingMessage): Promise<void> {
    const label = msg.speaker ? `\n📖 ${msg.speaker}:` : '';
    // The terminal has one seat, so a private message is rendered as a whisper.
    const text = msg.targetUserId ? `(whisper to ${msg.targetUserName ?? msg.targetUserId}) ${msg.text}` : msg.text;
    process.stdout.write(`${label}\n${text}\n\n`);
  }

  private prompt(): void {
    process.stdout.write('> ');
  }
}
