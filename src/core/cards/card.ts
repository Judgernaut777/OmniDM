/**
 * Character Card import — the NODE half.
 *
 * The V2/V3 PARSING (JSON, PNG chunk walk, base64) is browser-safe and lives in
 * ./card-parse.ts. This module layers on the Node-only concerns that a WebView
 * can't (and shouldn't) do the same way:
 *   - fetching a card over http(s) behind an SSRF/DNS guard (no loopback/metadata),
 *   - reading a local file restricted to the data dir (no /etc/passwd oracle),
 *   - inflating zTXt via node:zlib with a hard output cap (no zip bomb).
 * All three protections are UNCHANGED from before the split. The pure API is
 * re-exported so existing importers (`import … from './cards/card.js'`) keep
 * working; the browser build imports ./card-parse.js (and a browser platform)
 * directly instead of this file.
 */
import { lookup } from 'node:dns/promises';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import {
  extractCardFromPng,
  type InflateFn,
  isPng,
  MAX_CARD_BYTES,
  parseCardJson,
  parseJson,
  type CharacterCard,
} from './card-parse.js';

// Re-export the pure surface so callers of card.js are unaffected by the split.
export {
  MAX_CARD_BYTES,
  parseCardJson,
  extractCardFromPng,
  renderCard,
  isPng,
  bytesToBase64,
  base64ToBytes,
} from './card-parse.js';
export type { CharacterCard, CardBookEntry, Portrait, InflateFn } from './card-parse.js';

/** node:zlib inflate with the same hard output cap the pure walker enforces. */
const nodeInflate: InflateFn = (data, maxOutputBytes) =>
  inflateSync(data, { maxOutputLength: maxOutputBytes });

/** RFC1918/loopback/link-local/CGNAT/unspecified — anything a bot host must not be steered into. */
function isPrivateIp(ip: string): boolean {
  if (ip.includes(':')) {
    const v6 = ip.toLowerCase();
    if (v6.startsWith('::ffff:') && net.isIP(v6.slice(7)) === 4) return isPrivateIp(v6.slice(7)); // v4-mapped
    return v6 === '::' || v6 === '::1' || v6.startsWith('fe8') || v6.startsWith('fc') || v6.startsWith('fd');
  }
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** SSRF guard: http(s) only, and the host must not be (or resolve to) a private address. */
async function assertPublicUrl(source: string): Promise<void> {
  const url = new URL(source);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http(s) URLs can be imported');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('that URL points at a private address');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('that URL points at a private address');
    return;
  }
  const addrs = await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address)))
    throw new Error('that URL points at a private address');
}

/** Size-capped streaming download; redirects are refused (they could re-point at private hosts). */
async function fetchCard(source: string): Promise<Buffer> {
  await assertPublicUrl(source);
  const res = await fetch(source, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  if (Number(res.headers.get('content-length')) > MAX_CARD_BYTES) throw new Error('card too large');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body ?? []) {
    const b = Buffer.from(chunk as Uint8Array);
    total += b.length;
    if (total > MAX_CARD_BYTES) throw new Error('card too large');
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

/** Read a local card, refusing paths (and symlink targets) outside the data dir. */
async function readCardFile(source: string, baseDir: string): Promise<Buffer> {
  const root = await fs.realpath(path.resolve(baseDir)).catch(() => path.resolve(baseDir));
  let real: string;
  try {
    real = await fs.realpath(path.resolve(source));
  } catch {
    throw new Error('no such file');
  }
  if (real !== root && !real.startsWith(root + path.sep))
    throw new Error(`local card files must live under ${baseDir}`);
  if ((await fs.stat(real)).size > MAX_CARD_BYTES) throw new Error('card too large');
  return fs.readFile(real);
}

/**
 * Load a card from a local file path (restricted to `baseDir`) or a public
 * http(s) URL (size-capped); JSON or card PNG. This is the Node entrypoint;
 * an in-browser build parses uploaded bytes with ./card-parse.js directly.
 */
export async function loadCard(source: string, baseDir: string): Promise<CharacterCard> {
  const buf = /^https?:\/\//i.test(source) ? await fetchCard(source) : await readCardFile(source, baseDir);
  if (isPng(buf)) return extractCardFromPng(buf, nodeInflate);
  return parseCardJson(parseJson(buf, 'file is neither a card PNG nor valid card JSON'));
}
