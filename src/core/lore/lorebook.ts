/**
 * Lorebook — keyword-triggered world info (SillyTavern's "World Info" pattern).
 *
 * Entries live on the session. Each turn, the narrator scans the current
 * action plus recent history for entry keywords (case-insensitive substring)
 * and injects the matched contents as a bounded WORLD INFO block, most
 * recently matched first. Entries with no keywords are constant: always
 * injected. Imported Character Cards feed their `character_book` in here.
 */
import { nanoid } from 'nanoid';

export interface LoreEntry {
  id: string;
  name: string;
  keywords: string[]; // case-insensitive substring triggers; [] = always on
  content: string;
  enabled: boolean;
}

export function makeEntry(name: string, keywords: string[], content: string): LoreEntry {
  return { id: nanoid(6), name, keywords, content, enabled: true };
}

/** Find an entry by exact id or case-insensitive name. */
export function findEntry(book: LoreEntry[], idOrName: string): LoreEntry | undefined {
  const q = idOrName.toLowerCase();
  return book.find((e) => e.id === idOrName || e.name.toLowerCase() === q);
}

/** Import a card's `character_book` entries; skips duplicates. Returns count added. */
export function importCardBook(
  book: LoreEntry[],
  entries: { name: string; keywords: string[]; content: string; enabled: boolean }[],
  fallbackName: string,
): number {
  let added = 0;
  for (const e of entries) {
    if (book.some((b) => b.content === e.content)) continue;
    book.push({ id: nanoid(6), name: e.name || fallbackName, keywords: e.keywords, content: e.content, enabled: e.enabled });
    added++;
  }
  return added;
}

/** Bounds so one chatty lorebook can't blow out the prompt budget. */
const ENTRY_CLIP = 500;
const TOTAL_CAP = 1500;
const clip = (s: string) => (s.length > ENTRY_CLIP ? `${s.slice(0, ENTRY_CLIP)}…` : s);

/**
 * Match enabled entries against scan texts (ordered most recent FIRST) and
 * render them as a bounded block: recently matched entries win the budget.
 * Returns '' when nothing matches.
 */
export function buildWorldInfo(book: LoreEntry[], texts: string[], cap = TOTAL_CAP): string {
  const matched: LoreEntry[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    const low = text.toLowerCase();
    for (const e of book) {
      if (!e.enabled || !e.content || seen.has(e.id)) continue;
      if (e.keywords.length === 0 || e.keywords.some((k) => k && low.includes(k.toLowerCase()))) {
        matched.push(e);
        seen.add(e.id);
      }
    }
  }
  const lines: string[] = [];
  let used = 0;
  for (const e of matched) {
    const line = `- ${e.name}: ${clip(e.content)}`;
    if (used + line.length > cap) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join('\n');
}
