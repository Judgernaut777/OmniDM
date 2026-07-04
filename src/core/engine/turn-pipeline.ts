/**
 * Turn pipeline — the "sandwich" architecture, borrowed from daicer:
 *
 *   Intent  →  Resolution (pure)  →  Persistence  →  Narration  →  (Broadcast)
 *
 * The deterministic layer (dice) runs BEFORE the LLM, so the model narrates
 * outcomes it didn't choose. A per-channel lock serializes concurrent turns,
 * which is what makes multiplayer safe (daicer/Agnai both do this).
 *
 * The default "immediate" turn mode treats each player message as a turn.
 * Because the session history is shared, it's genuinely multiplayer. Turn
 * sequencing (`session.turnMode`, e.g. round-robin) is enforced HERE, inside
 * the channel lock: checking whose turn it is (and advancing the pointer)
 * outside the critical section would let a double-send from the current
 * player race the in-flight LLM call and consume other players' turns.
 */
import type { CheckResult, GameSession, LLMProvider, Player, RollResult, StateChange, TurnRecord } from '../types.js';
import { MemoryRetriever } from '../memory/retrieval.js';
import { Narrator } from '../narrator/narrator.js';
import { applyMarkers } from '../rules/mechanics.js';
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
  /**
   * Pre-resolved ability checks (`/dm check`), fed to the narrator as fixed
   * PASS/FAIL facts exactly like `rolls` — the model states the outcome, it
   * never adjudicates it.
   */
  checks?: CheckResult[];
}

export interface TurnResult {
  /** The resolved turn; absent when round-robin rejected the action. */
  record?: TurnRecord;
  /** Set instead of `record` when it wasn't the actor's turn: whose turn it is. */
  notYourTurn?: Player;
  /** The next player up, after a round-robin advance. */
  next?: Player | null;
  /**
   * Mechanical state changes the DM's narration markers applied this turn
   * (damage/heal/condition), in marker order. Empty when the model emitted
   * none — narration-driven mechanics are always optional.
   */
  changes?: StateChange[];
}

export class TurnPipeline {
  private locks = new ChannelLock();
  private memory: MemoryRetriever;

  constructor(
    private sessions: SessionManager,
    private narrator: Narrator,
    private provider: LLMProvider,
  ) {
    this.memory = new MemoryRetriever(provider);
  }

  private lockKey(session: GameSession): string {
    return `${session.platform}:${session.channelId}`;
  }

  async processTurn(session: GameSession, input: TurnInput, actorUserId?: string): Promise<TurnResult> {
    return this.locks.run(this.lockKey(session), async () => {
      // 0. SEQUENCING (inside the lock — a queued duplicate from the same
      // player must see the pointer already advanced by the turn before it)
      if (session.turnMode === 'round-robin' && actorUserId) {
        const current = this.sessions.currentPlayer(session);
        if (current && current.userId !== actorUserId) return { notYourTurn: current };
      }

      // 1. INTENT + 2. RESOLUTION (pure, deterministic dice + any pre-resolved checks)
      const rolls: RollResult[] = extractRolls(input.text).map((n) => roll(n, input.actorName));
      const checks = input.checks ?? [];

      // 3. NARRATION (LLM narrates the resolved turn, with long-term recall of
      // relevant older turns from outside the prompt's recent-history window)
      const actions = [{ name: input.actorName, text: input.text }];
      const pastEvents = await this.memory.retrieve(session, input.text);
      const rawNarration = await this.narrator.narrate(session, actions, rolls, pastEvents, checks);

      // 3b. MECHANICS (deterministic): parse+apply any <<hp/heal/condition ...>>
      // markers the DM ended its narration with, against the real party, and
      // strip them — players never see the marker syntax, only its effect.
      const { text: narration, changes } = applyMarkers(session, rawNarration);

      // 4. PERSISTENCE (history + a vector-memory record of the resolved turn)
      const record: TurnRecord = { actions, rolls, ...(checks.length ? { checks } : {}), narration, ts: Date.now() };
      session.history.push(record);
      await this.memory.remember(session, record);
      await this.maybeCompact(session);
      await this.sessions.save(session);

      const next = session.turnMode === 'round-robin' ? await this.sessions.advanceTurn(session) : undefined;
      return { record, next, changes };
    });
  }

  /** Skip the current player's round-robin turn — same critical section as turns. */
  async pass(session: GameSession, userId: string): Promise<TurnResult> {
    return this.locks.run(this.lockKey(session), async () => {
      const current = this.sessions.currentPlayer(session);
      if (current && current.userId !== userId) return { notYourTurn: current };
      return { next: await this.sessions.advanceTurn(session) };
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
