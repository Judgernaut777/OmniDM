/**
 * Vector memory / RAG — long-term recall alongside the living summary.
 *
 * Every resolved turn is stored on the session as a compact memory record
 * (who did what plus a narration snippet). On each new action, records that
 * fall OUTSIDE the recent-history window already in the prompt are scored
 * against the action and the top-k are injected under RELEVANT PAST EVENTS —
 * so the DM can recall the amulet from session one even after compaction
 * folded that turn into the summary.
 *
 * Two scoring backends:
 *   - embeddings + cosine similarity, when the provider exposes `embed()`
 *     (opt-in via EMBEDDINGS_MODEL → OpenAI-compatible /embeddings endpoint);
 *   - lexical token-overlap with a tiny stopword list — the zero-config
 *     default, works fully offline.
 * Records missing a vector (written while embeddings were off) fall back to
 * lexical scoring, so toggling the backend never invalidates old memories.
 * Cosine and Jaccard live on different scales (unrelated cosine ≈ 0.5+, a good
 * Jaccard hit ≈ 0.2), so the two rankings are never sorted against each other:
 * retrieve() ranks per backend and interleaves the winners.
 */
import type { GameSession, LLMProvider, TurnRecord } from '../types.js';

/** Verbatim turns the narrator puts in the prompt; retrieval skips those. */
export const HISTORY_WINDOW = 6;
/** How many past-event records to inject per turn. */
export const TOP_K = 3;
/** Cap on stored records — the session JSON is rewritten every turn, and an
 * embedding per record would otherwise grow it (and re-scoring) without bound. */
export const MAX_MEMORIES = 400;

export interface MemoryRecord {
  turn: number;      // global turn number — memories outlive history compaction
  text: string;      // "Thorin: I grab the amulet → The altar hums…"
  vector?: number[]; // embedding, present only when a backend was configured
  ts: number;
}

const STOPWORDS = new Set(
  ('the a an and or but if then than so as of to in on at by for with from into onto out up down over under ' +
    'is are was were be been am do does did have has had will would shall should can could may might must not no ' +
    'i you he she it we they me him her them us my your his its our their this that these those there here ' +
    'what who whom which when where how why').split(' '),
);

/** Lowercased content words: split on non-alphanumerics, drop stopwords. */
export function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/[^a-z0-9']+/).filter((t) => t.length > 1 && !STOPWORDS.has(t)),
  );
}

/** Jaccard overlap of content tokens — the offline lexical backend. */
export function lexicalScore(query: Set<string>, text: string): number {
  const tokens = tokenize(text);
  if (!query.size || !tokens.size) return 0;
  let shared = 0;
  for (const t of query) if (tokens.has(t)) shared++;
  return shared / (query.size + tokens.size - shared);
}

/** Cosine similarity — the embeddings backend. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const SNIPPET = 240;

function memoryText(record: TurnRecord): string {
  const acts = record.actions.map((a) => `${a.name}: ${a.text}`).join('; ');
  const snip = record.narration.length > SNIPPET ? `${record.narration.slice(0, SNIPPET)}…` : record.narration;
  return `${acts} → ${snip}`;
}

export class MemoryRetriever {
  constructor(private provider: LLMProvider) {}

  /** Store a resolved turn as a memory record, embedding it if the backend is on (best-effort). */
  async remember(session: GameSession, record: TurnRecord): Promise<void> {
    session.memories ??= [];
    // Turn numbers keep counting past pruning, so they stay unique ids.
    const mem: MemoryRecord = { turn: (session.memories.at(-1)?.turn ?? -1) + 1, text: memoryText(record), ts: record.ts };
    if (this.provider.embed) {
      try {
        [mem.vector] = await this.provider.embed([mem.text]);
      } catch (err) {
        console.warn('[memory] embedding failed; record stored for lexical recall:', (err as Error).message);
      }
    }
    session.memories.push(mem);
    if (session.memories.length > MAX_MEMORIES) session.memories.splice(0, session.memories.length - MAX_MEMORIES);
  }

  /** Top-k records relevant to the current action, from OUTSIDE the recent-history window. */
  async retrieve(session: GameSession, queryText: string, k = TOP_K): Promise<MemoryRecord[]> {
    const memories = session.memories ?? [];
    const inPrompt = Math.min(session.history.length, HISTORY_WINDOW);
    const candidates = memories.slice(0, memories.length - inPrompt);
    if (!candidates.length) return [];

    let queryVec: number[] | undefined;
    if (this.provider.embed) {
      try {
        [queryVec] = await this.provider.embed([queryText]);
      } catch (err) {
        console.warn('[memory] query embedding failed; falling back to lexical:', (err as Error).message);
      }
    }
    // Score each candidate on the backend it supports, then rank the two
    // backends SEPARATELY — cosine and Jaccard scales aren't comparable, and a
    // mixed sort would bury every pre-embeddings (vectorless) record under
    // unrelated-but-embedded ones. Winners are interleaved, cosine first.
    const queryTokens = tokenize(queryText);
    const scored = candidates
      .map((m) =>
        queryVec && m.vector
          ? { m, backend: 'cosine' as const, score: cosine(queryVec, m.vector) }
          : { m, backend: 'lexical' as const, score: lexicalScore(queryTokens, m.text) },
      )
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    const ranked = {
      cosine: scored.filter((s) => s.backend === 'cosine'),
      lexical: scored.filter((s) => s.backend === 'lexical'),
    };
    const out: MemoryRecord[] = [];
    for (let i = 0; out.length < k && (ranked.cosine[i] || ranked.lexical[i]); i++) {
      for (const backend of ['cosine', 'lexical'] as const) {
        const s = ranked[backend][i];
        if (s && out.length < k) out.push(s.m);
      }
    }
    return out;
  }
}
