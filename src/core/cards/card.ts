/**
 * Character Card import — the V2/V3 spec used across the SillyTavern
 * ecosystem. Cards arrive either as raw JSON (spec_version '2.0'/'3.0', fields
 * under `data`) or embedded in a PNG: a tEXt/zTXt chunk keyed 'chara' (V2) or
 * 'ccv3' (V3) holding base64 JSON. The PNG chunk walk is done by hand — the
 * format is simple enough that a dependency isn't worth it.
 *
 * Sources are UNTRUSTED — any channel member can pass one to `/dm import`, so
 * loading is hardened: local paths must stay under the data dir (no /etc/passwd
 * oracle), URLs must resolve to public addresses (no SSRF against loopback or
 * cloud metadata), downloads and zTXt inflation are size-capped (no OOM), and
 * parse errors never echo input bytes back to the channel.
 */
import { lookup } from 'node:dns/promises';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

/** Cards are small; anything bigger is a mistake or an attack. */
export const MAX_CARD_BYTES = 2 * 1024 * 1024;

/**
 * A character portrait: EITHER a preset archetype id (the server stores only
 * the id; the art is rendered client-side) OR stored image bytes (from a card
 * PNG's embedded art, or a player upload). Image bytes are base64-encoded so
 * they serialize into the session JSON; they are served over HTTP by the web
 * adapter, NEVER inlined into a WebSocket frame (the 32KB frame cap).
 */
export type Portrait =
  | { kind: 'preset'; id: string }
  | { kind: 'image'; mime: string; data: string };

/** A normalized character card, whatever spec version it came from. */
export interface CharacterCard {
  specVersion: string;   // '2.0' | '3.0'
  name: string;
  description?: string;
  personality?: string;
  scenario?: string;
  firstMes?: string;
  mesExample?: string;
  systemPrompt?: string;
  /** Legacy flattened lore (cards saved pre-lorebook) — still rendered inline. */
  bookEntries?: string[];
  /** Structured `character_book` entries — imported into the session lorebook. */
  book?: CardBookEntry[];
  /** Portrait art. Set from the embedded image when the card is a PNG. Absent-safe. */
  portrait?: Portrait;
}

/** One `character_book` entry, normalized. Shape matches the lorebook's needs. */
export interface CardBookEntry {
  name: string;
  keywords: string[];
  content: string;
  enabled: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Parse a decoded card JSON object (V2/V3; tolerates V1's top-level fields). */
export function parseCardJson(json: unknown): CharacterCard {
  const obj = (json ?? {}) as Record<string, unknown>;
  const data = (obj.data ?? obj) as Record<string, unknown>;
  const name = str(data.name);
  if (!name) throw new Error('not a character card (missing data.name)');
  const entries = (data.character_book as { entries?: unknown } | undefined)?.entries;
  return {
    specVersion: str(obj.spec_version) || '2.0',
    name,
    description: str(data.description),
    personality: str(data.personality),
    scenario: str(data.scenario),
    firstMes: str(data.first_mes),
    mesExample: str(data.mes_example),
    systemPrompt: str(data.system_prompt),
    book: Array.isArray(entries)
      ? entries.flatMap((raw): CardBookEntry[] => {
          const e = (raw ?? {}) as Record<string, unknown>;
          const content = str(e.content);
          if (!content || e.enabled === false) return [];
          const keys = Array.isArray(e.keys) ? e.keys.map(str).filter(Boolean) : [];
          return [{ name: str(e.name) || str(e.comment), keywords: keys, content, enabled: true }];
        })
      : [],
  };
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Walk PNG chunks and pull the embedded card ('ccv3' preferred over 'chara'). */
export function extractCardFromPng(buf: Buffer): CharacterCard {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG file');
  const texts = new Map<string, Buffer>();
  for (let off = 8; off + 12 <= buf.length; ) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (type === 'IEND') break;
    if (type === 'tEXt' || type === 'zTXt') {
      const data = buf.subarray(off + 8, off + 8 + len);
      const nul = data.indexOf(0);
      if (nul > 0) {
        const key = data.toString('latin1', 0, nul);
        // zTXt: a compression-method byte follows the NUL, then zlib data.
        // maxOutputLength stops decompression bombs (a few KB inflating to GBs).
        texts.set(
          key,
          type === 'tEXt'
            ? data.subarray(nul + 1)
            : inflateSync(data.subarray(nul + 2), { maxOutputLength: MAX_CARD_BYTES }),
        );
      }
    }
    off += 12 + len; // length + type + data + CRC
  }
  const b64 = texts.get('ccv3') ?? texts.get('chara');
  if (!b64) throw new Error('PNG has no embedded character card (no chara/ccv3 chunk)');
  const card = parseCardJson(parseJson(Buffer.from(b64.toString('latin1'), 'base64'), 'embedded card is not valid JSON'));
  // The card art IS this PNG — keep the bytes as the character's portrait
  // (served over HTTP by the web adapter, never inlined into a WS frame).
  card.portrait = { kind: 'image', mime: 'image/png', data: buf.toString('base64') };
  return card;
}

/** JSON.parse without echoing input bytes: Node's SyntaxError embeds a prefix of the input. */
function parseJson(buf: Buffer, message: string): unknown {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Error(message);
  }
}

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
 * http(s) URL (size-capped); JSON or card PNG.
 */
export async function loadCard(source: string, baseDir: string): Promise<CharacterCard> {
  const buf = /^https?:\/\//i.test(source) ? await fetchCard(source) : await readCardFile(source, baseDir);
  if (buf.subarray(0, 8).equals(PNG_SIG)) return extractCardFromPng(buf);
  return parseCardJson(parseJson(buf, 'file is neither a card PNG nor valid card JSON'));
}

/** Per-field clip so one giant card can't blow out the prompt budget. */
const FIELD_CLIP = 700;
const clip = (s: string) => (s.length > FIELD_CLIP ? `${s.slice(0, FIELD_CLIP)}…` : s);

/** Render a card as a bounded prompt block for the narrator. */
export function renderCard(card: CharacterCard, role: string): string {
  const lines = [`### ${card.name} — ${role}`];
  if (card.description) lines.push(`Description: ${clip(card.description)}`);
  if (card.personality) lines.push(`Personality: ${clip(card.personality)}`);
  if (card.scenario) lines.push(`Scenario: ${clip(card.scenario)}`);
  if (card.systemPrompt) lines.push(`Character notes: ${clip(card.systemPrompt)}`);
  if (card.mesExample) lines.push(`Example dialogue: ${clip(card.mesExample)}`);
  for (const entry of (card.bookEntries ?? []).slice(0, 3)) lines.push(`Lore: ${clip(entry)}`);
  return lines.join('\n');
}
