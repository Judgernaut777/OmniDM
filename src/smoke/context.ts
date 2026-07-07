/**
 * Shared context threaded into topical section modules (src/smoke/sections/*).
 *
 * The monolith kept its setup — config, the shared MockProvider/Bot, the message
 * helpers, and a bag of cross-section fixtures — as locals in one function. As
 * self-contained section groups are lifted into their own files, they receive
 * this context instead. `fx` is the mutable fixture bag for the (still
 * co-located) sections that reuse an earlier section's fixture; a group that
 * doesn't touch shared fixtures (rules, billing) simply ignores it.
 */
import type { Config } from '../config.js';
import type { Bot } from '../core/bot.js';
import type { IncomingMessage, OutgoingMessage } from '../core/types.js';
import type { NodeFileStorage } from '../core/session/store.js';
import type { MockProvider } from './harness.js';

/** Cross-section mutable fixtures (set by one section, reused by a later one). */
export interface SmokeFixtures {
  sessionFile?: string;
  store?: NodeFileStorage;
  pngChunk?: (type: string, data: Buffer) => Buffer;
  embedded?: string;
  pngPath?: string;
  bomb?: Buffer;
}

export interface SmokeCtx {
  dataDir: string;
  config: Config;
  provider: MockProvider;
  bot: Bot;
  out: OutgoingMessage[];
  send: (m: OutgoingMessage) => Promise<void>;
  from: (userId: string, userName: string, text: string, channelId?: string) => IncomingMessage;
  fx: SmokeFixtures;
}
