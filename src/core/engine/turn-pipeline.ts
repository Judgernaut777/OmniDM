/**
 * Turn pipeline — the "sandwich" architecture, borrowed from daicer:
 *
 *   Intent  →  Resolution (pure)  →  Persistence  →  Narration  →  (Broadcast)
 *
 * The deterministic layer (dice) runs BEFORE the LLM, so the model narrates
 * outcomes it didn't choose. A per-channel lock serializes concurrent turns,
 * which is what makes multiplayer safe (daicer/Agnai both do this).
 *
 * v1 uses "immediate" turn mode: each player message is a turn. Because the
 * session history is shared, it's genuinely multiplayer. Round-robin/initiative
 * ordering is a future `turnMode`.
 */
import type { GameSession, LLMProvider, RollResult, TurnRecord } from '../types.js';
import { Narrator } from '../narrator/narrator.js';
import { SessionManager } from '../session/session-manager.js';
import { extractRolls, roll } from './dice.js';

/** Minimal in-process async mutex keyed by channel. */
class ChannelLock {
  private chains = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(
      key,
      next.catch(() => {}),
    );
    return next;
  }
}

export interface TurnInput {
  actorName: string; // character or display name
  text: string;
}

export class TurnPipeline {
  private locks = new ChannelLock();

  constructor(
    private sessions: SessionManager,
    private narrator: Narrator,
    private provider: LLMProvider,
  ) {}

  async processTurn(session: GameSession, input: TurnInput): Promise<TurnRecord> {
    const lockKey = `${session.platform}:${session.channelId}`;
    return this.locks.run(lockKey, async () => {
      // 1. INTENT + 2. RESOLUTION (pure, deterministic dice)
      const rolls: RollResult[] = extractRolls(input.text).map((n) => roll(n, input.actorName));

      // 3. NARRATION (LLM narrates the resolved turn)
      const actions = [{ name: input.actorName, text: input.text }];
      const narration = await this.narrator.narrate(session, actions, rolls);

      // 4. PERSISTENCE
      const record: TurnRecord = { actions, rolls, narration, ts: Date.now() };
      session.history.push(record);
      await this.maybeCompact(session);
      await this.sessions.save(session);

      return record;
    });
  }

  /**
   * "Living summary" memory (NeverEndingQuest / NarrativeEngine-P pattern):
   * once history grows past a threshold, fold the oldest turns into a rolling
   * prose summary so context stays bounded.
   */
  private async maybeCompact(session: GameSession): Promise<void> {
    const KEEP = 8;
    const COMPACT_AT = 14;
    if (session.history.length < COMPACT_AT) return;

    const toFold = session.history.slice(0, session.history.length - KEEP);
    const transcript = toFold
      .map((t) => `${t.actions.map((a) => `${a.name}: ${a.text}`).join('; ')}\nDM: ${t.narration}`)
      .join('\n\n');

    try {
      const summary = await this.provider.complete({
        model: session.model,
        maxTokens: 400,
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content:
              'You compress tabletop RPG session logs into a concise running summary. Preserve names, places, unresolved threads, promises, deaths, and key items. Output prose only.',
          },
          {
            role: 'user',
            content: `Existing summary:\n${session.summary || '(none)'}\n\nNew events to fold in:\n${transcript}\n\nReturn the updated summary.`,
          },
        ],
      });
      if (summary) {
        session.summary = summary;
        session.history = session.history.slice(-KEEP);
      }
    } catch (err) {
      // Compaction is best-effort; never block play on it.
      console.warn('[pipeline] summary compaction failed:', (err as Error).message);
    }
  }
}
