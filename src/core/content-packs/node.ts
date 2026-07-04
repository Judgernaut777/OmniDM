/**
 * Content-pack loading — the NODE half (reads a pack JSON file off disk).
 * The pure parse/validate lives in ./validate.ts; this just adds the
 * `node:fs` read + a size guard, same split as `cards/card.ts` vs
 * `card-parse.ts`. A Node host (CLI, server operator tooling) can point this
 * at any `.pack.json` file, including third-party ones dropped in later —
 * `parseContentPackJson` is what actually enforces the untrusted-input caps.
 */
import { promises as fs } from 'node:fs';
import { MAX_PACK_BYTES, parseContentPackJson } from './validate.js';
import type { ContentPack } from './types.js';

/** Read + validate a content pack from a local JSON file. */
export async function loadContentPackFile(filePath: string): Promise<ContentPack> {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_PACK_BYTES) throw new Error('content pack file is too large');
  const text = await fs.readFile(filePath, 'utf8');
  return parseContentPackJson(text);
}
