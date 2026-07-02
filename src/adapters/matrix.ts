/**
 * Matrix adapter. Translates Matrix room messages to/from the canonical types
 * via matrix-bot-sdk. A room id is the channelId — a game lives in whichever
 * room it's started in. The bot auto-joins rooms it's invited to.
 *
 * Setup: on any homeserver, create a bot account and grab an access token
 * (e.g. Element → Settings → Help & About → Advanced, or a `login` API call).
 * Put the homeserver URL in MATRIX_HOMESERVER_URL and the token in
 * MATRIX_ACCESS_TOKEN, then invite the bot to a room.
 *
 * Fog-of-war whispers (`targetUserId`) are delivered in a direct-message room
 * with the target player — an existing DM is reused, otherwise one is created
 * (and recorded in `m.direct` account data so it's found again next time).
 */
import path from 'node:path';
import { AutojoinRoomsMixin, MatrixClient, SimpleFsStorageProvider } from 'matrix-bot-sdk';
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../core/types.js';

export class MatrixAdapter implements PlatformAdapter {
  readonly name = 'matrix';
  private client: MatrixClient;
  private handler?: (msg: IncomingMessage) => void | Promise<void>;
  private selfId = '';
  private startedAt = 0;
  private names = new Map<string, string>(); // userId → display name cache

  constructor(homeserverUrl: string, accessToken: string, dataDir = './data') {
    if (!homeserverUrl || !accessToken) {
      throw new Error(
        'MATRIX_HOMESERVER_URL and MATRIX_ACCESS_TOKEN must both be set for the Matrix adapter. See .env.example.',
      );
    }
    // The sync token persists here so restarts don't replay old messages.
    const storage = new SimpleFsStorageProvider(path.join(dataDir, 'matrix-sync.json'));
    this.client = new MatrixClient(homeserverUrl, accessToken, storage);
    AutojoinRoomsMixin.setupOnClient(this.client);
  }

  onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.selfId = await this.client.getUserId();
    this.startedAt = Date.now();

    this.client.on('room.message', async (roomId: string, event: MatrixMessageEvent) => {
      if (event.sender === this.selfId) return; // ignore the bot's own messages
      if (event.content?.msgtype !== 'm.text' || !event.content.body) return;
      // Skip messages from before this run (a fresh sync store replays history).
      if ((event.origin_server_ts ?? Date.now()) < this.startedAt - 5000) return;
      await this.handler?.({
        platform: 'matrix',
        channelId: roomId,
        userId: event.sender,
        userName: await this.userName(event.sender),
        text: event.content.body,
        raw: event,
      });
    });

    await this.client.start();
    console.log(`🤖 Matrix connected as ${this.selfId}. Invite the bot to a room and type /dm help.`);
  }

  async stop(): Promise<void> {
    this.client.stop();
  }

  async send(msg: OutgoingMessage): Promise<void> {
    // Private (fog-of-war) delivery: a direct room with the target player,
    // created on first use and reused (tracked via m.direct) afterwards.
    if (msg.targetUserId) {
      const dmRoomId = await this.client.dms.getOrCreateDm(msg.targetUserId);
      await this.client.sendText(dmRoomId, `🌫️ ${msg.text}`);
      return;
    }
    await this.client.sendText(msg.channelId, msg.text);
  }

  /** Resolve a Matrix user id to a display name, cached per process. */
  private async userName(userId: string): Promise<string> {
    const cached = this.names.get(userId);
    if (cached) return cached;
    let name = userId;
    try {
      const profile = await this.client.getUserProfile(userId);
      name = profile?.displayname || userId;
    } catch {
      // Profile lookup failed — fall back to the raw @user:server id.
    }
    this.names.set(userId, name);
    return name;
  }
}

/** The slice of a Matrix `m.room.message` event the adapter reads. */
interface MatrixMessageEvent {
  sender: string;
  origin_server_ts?: number;
  content?: { msgtype?: string; body?: string };
}
