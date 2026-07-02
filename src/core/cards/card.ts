/**
 * Character Card import — the V2/V3 spec used across the SillyTavern
 * ecosystem. Cards arrive either as raw JSON (spec_version '2.0'/'3.0', fields
 * under `data`) or embedded in a PNG: a tEXt/zTXt chunk keyed 'chara' (V2) or
 * 'ccv3' (V3) holding base64 JSON. The PNG chunk walk is done by hand — the
 * format is simple enough that a dependency isn't worth it.
 */
import { promises as fs } from 'node:fs';
import { inflateSync } from 'node:zlib';

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
        texts.set(key, type === 'tEXt' ? data.subarray(nul + 1) : inflateSync(data.subarray(nul + 2)));
      }
    }
    off += 12 + len; // length + type + data + CRC
  }
  const b64 = texts.get('ccv3') ?? texts.get('chara');
  if (!b64) throw new Error('PNG has no embedded character card (no chara/ccv3 chunk)');
  return parseCardJson(JSON.parse(Buffer.from(b64.toString('latin1'), 'base64').toString('utf8')));
}

/** Load a card from a local file path or an http(s) URL; JSON or card PNG. */
export async function loadCard(source: string): Promise<CharacterCard> {
  let buf: Buffer;
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
    buf = Buffer.from(await res.arrayBuffer());
  } else {
    buf = await fs.readFile(source);
  }
  if (buf.subarray(0, 8).equals(PNG_SIG)) return extractCardFromPng(buf);
  return parseCardJson(JSON.parse(buf.toString('utf8')));
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
