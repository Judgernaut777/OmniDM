/**
 * Global concurrency ceiling for LLM provider calls.
 *
 * WHY: `ChannelLock` (see core/session/session-manager.ts / bot.ts) serializes
 * turns WITHIN a single channel, so two messages in the same channel can't race
 * each other into the provider. But it does nothing ACROSS channels — an
 * attacker who opens many WebSocket connections, each presenting a distinct
 * (attacker-chosen) `channelId`, gets one independent lock per channel and can
 * therefore drive an UNBOUNDED number of PARALLEL `complete()`/`embed()` calls
 * server-wide. Each call costs real provider-quota/money, so this is a
 * cost-amplification and quota-exhaustion DoS, not just a perf concern.
 *
 * This wrapper adds the orthogonal piece ChannelLock can't provide: a single
 * process-wide semaphore bounding how many network-bound provider calls may be
 * in flight AT ONCE, regardless of which channel they came from. It is a pure
 * decorator around any `LLMProvider` — it does not know about channels,
 * sessions, or the bot at all.
 *
 * Behavior when the cap is hit: additional callers WAIT in a bounded queue
 * (`maxQueue`) rather than piling up unboundedly in memory. Once the queue
 * itself is full, further calls are REJECTED immediately with a clear "server
 * busy" error instead of being queued forever — turning an unbounded-fan-out
 * attack into a bounded queue plus a fast, explicit failure. The bot's existing
 * turn-failure handling already scrubs provider errors and surfaces a generic
 * "the DM is busy" notice to the channel, so this fast-fail composes cleanly
 * with no changes needed there.
 */
import type { CompletionRequest, LLMProvider, ModelInfo } from '../core/types.js';

export class CapacityError extends Error {
  constructor() {
    super('LLM provider is at capacity (server busy) — try again shortly');
    this.name = 'CapacityError';
  }
}

/**
 * A minimal counting semaphore: `maxConcurrent` callers may hold a slot at
 * once; anyone else queues (FIFO) up to `maxQueue` waiters, then further
 * acquires reject immediately. No external deps — just a counter and an array
 * of waiter resolvers.
 */
class Semaphore {
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueue: number,
  ) {}

  /** Resolves once a slot is held; throws {@link CapacityError} if the queue is already full. */
  async acquire(): Promise<void> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight++;
      return;
    }
    if (this.waiters.length >= this.maxQueue) {
      throw new CapacityError();
    }
    // Queue for a slot. The releasing holder hands its slot DIRECTLY to us
    // (see `release`) without ever dropping `inFlight` below the cap, so we
    // must NOT increment on wake. Incrementing here would over-subscribe:
    // between a release decrementing and the woken waiter incrementing, a
    // fresh acquire() could slip into the transiently-free slot, pushing
    // in-flight past maxConcurrent.
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Frees the caller's slot: hand it straight to the next waiter, or drop the count. */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Transfer the slot: `inFlight` stays put, so a concurrent acquire()
      // still sees a full pool and queues instead of over-subscribing.
      next();
    } else {
      this.inFlight--;
    }
  }

  /** Runs `fn` behind the semaphore, always releasing — even if `fn` throws/rejects. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export interface ConcurrencyLimitOptions {
  /** Max in-flight provider calls at once. <= 0 means unlimited (the wrapper should not be used in that case). */
  maxConcurrent: number;
  /** Max callers queued waiting for a slot before further calls fast-fail. */
  maxQueue: number;
}

/**
 * Wraps an inner `LLMProvider` so all of its network-bound calls
 * (`complete`, `embed`, `listModels`) share one process-wide semaphore capped
 * at `opts.maxConcurrent` in-flight calls, with up to `opts.maxQueue` more
 * queued before new calls are rejected outright.
 *
 * `id`, `supportsModel`, and `defaultModel` pass through untouched — they're
 * cheap/local, not network calls. `embed` is defined on the returned wrapper
 * ONLY when the inner provider defines it, so callers that feature-detect
 * `provider.embed` (falling back to lexical scoring otherwise) keep working
 * unchanged.
 */
export class ConcurrencyLimitedProvider implements LLMProvider {
  readonly id: string;
  readonly supportsModel?: (modelId: string) => boolean;
  readonly defaultModel?: string;
  readonly embed?: (texts: string[]) => Promise<number[][]>;

  private readonly sem: Semaphore;

  constructor(
    private readonly inner: LLMProvider,
    opts: ConcurrencyLimitOptions,
  ) {
    this.sem = new Semaphore(opts.maxConcurrent, opts.maxQueue);
    this.id = inner.id;
    if (inner.supportsModel) this.supportsModel = (modelId: string) => inner.supportsModel!(modelId);
    this.defaultModel = inner.defaultModel;
    if (inner.embed) {
      this.embed = (texts: string[]) => this.sem.run(() => inner.embed!(texts));
    }
  }

  listModels(): Promise<ModelInfo[]> {
    return this.sem.run(() => this.inner.listModels());
  }

  complete(req: CompletionRequest): Promise<string> {
    return this.sem.run(() => this.inner.complete(req));
  }
}

/** Convenience factory mirroring the class above (some call sites prefer a function). */
export function withConcurrencyLimit(inner: LLMProvider, opts: ConcurrencyLimitOptions): LLMProvider {
  return new ConcurrencyLimitedProvider(inner, opts);
}
