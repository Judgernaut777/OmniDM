/**
 * Mattermost adapter. Translates Mattermost posts to/from the canonical types
 * using the REST API v4 over built-in fetch plus the events WebSocket at
 * /api/v4/websocket (Node 22's global WebSocket — no SDK dependency).
 * A channel id is the channelId — a game lives in whichever channel it's
 * started in.
 *
 * Setup: create a bot account (System Console → Integrations → Bot Accounts)
 * or a personal access token, put the server URL in MATTERMOST_URL and the
 * token in MATTERMOST_TOKEN, then add the bot to a channel.
 *
 * Fog-of-war whispers (`targetUserId`) are delivered in the direct-message
 * channel with the target player (`POST /channels/direct` returns the
 * existing DM channel or creates it).
 */
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '../core/types.js';

export class MattermostAdapter implements PlatformAdapter {
  readonly name = 'mattermost';
  private readonly apiUrl: string; // https://server/api/v4
  private readonly wsUrl: string;  // wss://server/api/v4/websocket
  private handler?: (msg: IncomingMessage) => void | Promise<void>;
  private ws?: WebSocket;
  private selfId = '';
  private stopped = false;
  private names = new Map<string, string>(); // userId → display name cache
  private dms = new Map<string, string>();   // userId → DM channel id cache

  constructor(url: string, private readonly token: string) {
    if (!url || !token) {
      throw new Error(
        'MATTERMOST_URL and MATTERMOST_TOKEN must both be set for the Mattermost adapter. See .env.example.',
      );
    }
    const base = url.replace(/\/+$/, '');
    this.apiUrl = `${base}/api/v4`;
    this.wsUrl = `${base.replace(/^http/, 'ws')}/api/v4/websocket`;
  }

  onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    const me = await this.api<{ id: string; username: string }>('GET', '/users/me');
    this.selfId = me.id;
    this.connect();
    console.log(`🤖 Mattermost connected as @${me.username}. Add the bot to a channel and type /dm help.`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ws?.close();
  }

  async send(msg: OutgoingMessage): Promise<void> {
    // Private (fog-of-war) delivery: the DM channel with the target player,
    // returned (or created) by /channels/direct and cached per process.
    const channelId = msg.targetUserId ? await this.dmChannel(msg.targetUserId) : msg.channelId;
    const text = msg.targetUserId ? `🌫️ ${msg.text}` : msg.text;
    await this.api('POST', '/posts', { channel_id: channelId, message: text });
  }

  /** Open the events WebSocket, authenticate, and reconnect on drop. */
  private connect(): void {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ seq: 1, action: 'authentication_challenge', data: { token: this.token } }));
    });

    ws.addEventListener('message', (ev) => {
      let event: MattermostEvent;
      try { event = JSON.parse(String(ev.data)); } catch { return; }
      if (event.event !== 'posted' || !event.data?.post) return;
      let post: MattermostPost;
      try { post = JSON.parse(event.data.post); } catch { return; }
      if (post.user_id === this.selfId || !post.message) return; // ignore the bot's own posts
      void this.dispatch(post);
    });

    ws.addEventListener('close', () => {
      if (this.stopped) return;
      setTimeout(() => this.connect(), 3000); // transparent reconnect
    });
    ws.addEventListener('error', () => ws.close());
  }

  private async dispatch(post: MattermostPost): Promise<void> {
    await this.handler?.({
      platform: 'mattermost',
      channelId: post.channel_id,
      userId: post.user_id,
      userName: await this.userName(post.user_id),
      text: post.message,
      raw: post,
    });
  }

  /** Get (or create) the direct-message channel with a user, cached per process. */
  private async dmChannel(userId: string): Promise<string> {
    const cached = this.dms.get(userId);
    if (cached) return cached;
    const channel = await this.api<{ id: string }>('POST', '/channels/direct', [this.selfId, userId]);
    this.dms.set(userId, channel.id);
    return channel.id;
  }

  /** Resolve a Mattermost user id to a display name, cached per process. */
  private async userName(userId: string): Promise<string> {
    const cached = this.names.get(userId);
    if (cached) return cached;
    let name = userId;
    try {
      const u = await this.api<{ username?: string; nickname?: string; first_name?: string }>('GET', `/users/${userId}`);
      name = u.nickname || u.first_name || u.username || userId;
    } catch {
      // Lookup failed — fall back to the raw id.
    }
    this.names.set(userId, name);
    return name;
  }

  /** Thin authenticated fetch wrapper around the REST API v4. */
  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Mattermost API ${method} ${path} failed (${res.status}): ${await res.text()}`);
    return (await res.json()) as T;
  }
}

/** The slice of a Mattermost WebSocket event the adapter reads. */
interface MattermostEvent {
  event?: string;
  data?: { post?: string }; // "posted" events carry the post as a JSON string
}

/** The slice of a Mattermost post the adapter reads. */
interface MattermostPost {
  user_id: string;
  channel_id: string;
  message: string;
}
