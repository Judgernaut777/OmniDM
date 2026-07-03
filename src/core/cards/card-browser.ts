/**
 * Character Card import — the BROWSER half.
 *
 * The in-app engine can't (and must not) fetch arbitrary URLs or read local
 * files the way the Node host does, so browser card import is UPLOAD-ONLY: the
 * user picks a file, the app hands its bytes here, and we reuse the pure parser
 * in ./card-parse.ts. The one platform primitive the parser needs — inflating a
 * PNG's zTXt chunk — is provided over the browser's async `DecompressionStream`
 * instead of node:zlib, with the SAME hard output cap so a decompression bomb is
 * still refused.
 *
 * Uses only web-platform globals (`DecompressionStream`, `Blob`), which Node ≥18
 * also exposes — so this module has NO `node:` imports and is exercised offline
 * by the smoke test.
 */
import {
  extractCardFromPng,
  type InflateFn,
  isPng,
  parseCardJson,
  parseJson,
  type CharacterCard,
} from './card-parse.js';

/** Inflate a zlib stream via `DecompressionStream`, capped to defuse zip bombs. */
export const browserInflate: InflateFn = async (data, maxOutputBytes) => {
  const ds = new DecompressionStream('deflate'); // zTXt is zlib-wrapped ("deflate" = zlib)
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxOutputBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('decompressed card too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
};

/**
 * Parse an uploaded card's raw bytes (JSON or card PNG) into a CharacterCard.
 * This is the browser entrypoint that replaces the Node `loadCard(path|url)`.
 */
export async function loadCardFromBytes(bytes: Uint8Array): Promise<CharacterCard> {
  if (isPng(bytes)) return extractCardFromPng(bytes, browserInflate);
  return parseCardJson(parseJson(bytes, 'file is neither a card PNG nor valid card JSON'));
}
