/**
 * Character Card parsing — the PURE, browser-safe half of card import.
 *
 * Everything here works on `Uint8Array` and the platform-neutral base64/UTF-8
 * primitives (`btoa`/`atob`/`TextDecoder`, present in both Node ≥18 and every
 * browser), so it has NO `node:` imports and can run unchanged in a WebView.
 * The Node-only concerns — fetching a URL behind the SSRF/DNS guard, reading a
 * local file under the data dir, and node:zlib inflation — live in ./card.ts,
 * which layers them on top of this module. Decompression is INJECTED here (see
 * {@link InflateFn}) so the caller supplies node:zlib on the server and the
 * browser's `DecompressionStream` in-app.
 *
 * Sources are UNTRUSTED, so parse errors never echo input bytes back.
 */

/** Cards are small; anything bigger is a mistake or an attack. */
export const MAX_CARD_BYTES = 2 * 1024 * 1024;

/**
 * A character portrait: EITHER a preset archetype id (the server stores only
 * the id; the art is rendered client-side) OR stored image bytes (from a card
 * PNG's embedded art, or a player upload). Image bytes are base64-encoded so
 * they serialize into the session JSON.
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

/**
 * Inflate a zlib stream (a card PNG's zTXt chunk), capped at `maxOutputBytes` to
 * defuse decompression bombs. Node passes node:zlib's `inflateSync`; a browser
 * passes a `DecompressionStream('deflate')` wrapper. May be async so the browser
 * impl can await the stream.
 */
export type InflateFn = (data: Uint8Array, maxOutputBytes: number) => Uint8Array | Promise<Uint8Array>;

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

// ─── Platform-neutral byte helpers (no node:Buffer) ──────────────────────────

/** Decode bytes as latin1 (byte value === code point) — exact, unlike TextDecoder('latin1'). */
function latin1(u8: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000; // avoid String.fromCharCode arg-count limits on big buffers
  for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  return s;
}

const UTF8 = new TextDecoder('utf-8');
const bytesToUtf8 = (u8: Uint8Array): string => UTF8.decode(u8);

/** Standard base64 of a byte array — matches Buffer.toString('base64'). */
export function bytesToBase64(u8: Uint8Array): string {
  return btoa(latin1(u8));
}

/** Decode standard base64 to bytes — matches Buffer.from(str, 'base64'). */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/** JSON.parse without echoing input bytes: Node's SyntaxError embeds a prefix of the input. */
export function parseJson(bytes: Uint8Array, message: string): unknown {
  try {
    return JSON.parse(bytesToUtf8(bytes));
  } catch {
    throw new Error(message);
  }
}

// ─── PNG-embedded card extraction ────────────────────────────────────────────

export const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** True if the bytes begin with the PNG signature. */
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return false;
  return true;
}

/**
 * Walk PNG chunks and pull the embedded card ('ccv3' preferred over 'chara').
 * Async because zTXt chunks are inflated through the injected {@link InflateFn}
 * (which the browser implements over the async `DecompressionStream`).
 */
export async function extractCardFromPng(bytes: Uint8Array, inflate: InflateFn): Promise<CharacterCard> {
  if (!isPng(bytes)) throw new Error('not a PNG file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const texts = new Map<string, Uint8Array>();
  for (let off = 8; off + 12 <= bytes.length; ) {
    const len = view.getUint32(off);
    const type = latin1(bytes.subarray(off + 4, off + 8));
    if (type === 'IEND') break;
    if (type === 'tEXt' || type === 'zTXt') {
      const data = bytes.subarray(off + 8, off + 8 + len);
      const nul = data.indexOf(0);
      if (nul > 0) {
        const key = latin1(data.subarray(0, nul));
        // zTXt: a compression-method byte follows the NUL, then zlib data.
        // The cap stops decompression bombs (a few KB inflating to GBs).
        texts.set(
          key,
          type === 'tEXt'
            ? data.subarray(nul + 1)
            : await inflate(data.subarray(nul + 2), MAX_CARD_BYTES),
        );
      }
    }
    off += 12 + len; // length + type + data + CRC
  }
  const b64 = texts.get('ccv3') ?? texts.get('chara');
  if (!b64) throw new Error('PNG has no embedded character card (no chara/ccv3 chunk)');
  const card = parseCardJson(parseJson(base64ToBytes(latin1(b64)), 'embedded card is not valid JSON'));
  // The card art IS this PNG — keep the bytes as the character's portrait.
  card.portrait = { kind: 'image', mime: 'image/png', data: bytesToBase64(bytes) };
  return card;
}

// ─── Prompt rendering ────────────────────────────────────────────────────────

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
