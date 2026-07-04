/**
 * Content-pack validation — the untrusted-input gate every pack passes
 * through before a single byte of it touches a session.
 *
 * Packs are exactly as untrusted as Character Cards (they can come from a
 * third-party marketplace later, same as cards do today): validation NEVER
 * echoes the raw input back into an error message, and every collection is
 * capped so a hostile or merely careless pack can't blow out prompt budgets
 * or memory (mirrors the caps in `lore/lorebook.ts` and `cards/card-parse.ts`).
 *
 * Browser-safe: no `node:` imports.
 */
import { CONTENT_PACK_FORMAT_VERSION, type ContentPack, type PackLoreEntry, type PackNpc, type PackRulesModule, type PackCampaignStarter } from './types.js';

export class ContentPackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentPackError';
  }
}

// Caps — generous enough for real content, small enough that a hostile pack
// can't turn into an unbounded prompt/memory sink.
export const MAX_PACK_BYTES = 2 * 1024 * 1024; // same ceiling as a Character Card
export const MAX_LOREBOOK_ENTRIES = 200;
export const MAX_NPCS = 50;
export const MAX_KEYWORDS_PER_ENTRY = 50;
export const MAX_SHORT_FIELD_CHARS = 200; // id/name/title-shaped fields
export const MAX_LONG_FIELD_CHARS = 20_000; // description/content/prose fields
export const MAX_RULES_MARKDOWN_CHARS = 50_000;

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function requireStr(v: unknown, field: string, max = MAX_SHORT_FIELD_CHARS): string {
  const s = str(v);
  if (!s) throw new ContentPackError(`content pack "${field}" is required`);
  if (s.length > max) throw new ContentPackError(`content pack "${field}" is too long (max ${max} chars)`);
  return s;
}

function optStr(v: unknown, field: string, max = MAX_LONG_FIELD_CHARS): string | undefined {
  if (v === undefined) return undefined;
  const s = str(v);
  if (s.length > max) throw new ContentPackError(`content pack "${field}" is too long (max ${max} chars)`);
  return s || undefined;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

function validateLoreEntry(raw: unknown, index: number): PackLoreEntry {
  if (!isObj(raw)) throw new ContentPackError(`content pack lorebook[${index}] must be an object`);
  const name = requireStr(raw.name, `lorebook[${index}].name`);
  const content = requireStr(raw.content, `lorebook[${index}].content`, MAX_LONG_FIELD_CHARS);
  const rawKeywords = raw.keywords;
  if (rawKeywords !== undefined && !Array.isArray(rawKeywords))
    throw new ContentPackError(`content pack lorebook[${index}].keywords must be an array of strings`);
  const keywordArr = Array.isArray(rawKeywords) ? rawKeywords : [];
  if (keywordArr.length > MAX_KEYWORDS_PER_ENTRY)
    throw new ContentPackError(`content pack lorebook[${index}].keywords has too many entries (max ${MAX_KEYWORDS_PER_ENTRY})`);
  const keywords = keywordArr.map((k) => str(k)).filter(Boolean);
  const enabled = raw.enabled === undefined ? true : Boolean(raw.enabled);
  return { name, keywords, content, enabled };
}

function validateNpc(raw: unknown, index: number): PackNpc {
  if (!isObj(raw)) throw new ContentPackError(`content pack npcs[${index}] must be an object`);
  return {
    name: requireStr(raw.name, `npcs[${index}].name`),
    description: optStr(raw.description, `npcs[${index}].description`),
    personality: optStr(raw.personality, `npcs[${index}].personality`),
    scenario: optStr(raw.scenario, `npcs[${index}].scenario`),
    firstMes: optStr(raw.firstMes, `npcs[${index}].firstMes`),
    mesExample: optStr(raw.mesExample, `npcs[${index}].mesExample`),
    systemPrompt: optStr(raw.systemPrompt, `npcs[${index}].systemPrompt`),
  };
}

function validateRulesModule(raw: unknown): PackRulesModule | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) throw new ContentPackError('content pack "rulesModule" must be an object');
  const id = requireStr(raw.id, 'rulesModule.id');
  if (!ID_RE.test(id)) throw new ContentPackError('content pack "rulesModule.id" must be a short lowercase-kebab identifier');
  return {
    id,
    name: requireStr(raw.name, 'rulesModule.name'),
    markdown: requireStr(raw.markdown, 'rulesModule.markdown', MAX_RULES_MARKDOWN_CHARS),
  };
}

function validateCampaignStarter(raw: unknown): PackCampaignStarter | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) throw new ContentPackError('content pack "campaignStarter" must be an object');
  return {
    title: requireStr(raw.title, 'campaignStarter.title'),
    summary: requireStr(raw.summary, 'campaignStarter.summary', MAX_LONG_FIELD_CHARS),
    openingNarration: optStr(raw.openingNarration, 'campaignStarter.openingNarration'),
    systemId: raw.systemId === undefined ? undefined : requireStr(raw.systemId, 'campaignStarter.systemId'),
  };
}

/**
 * Validate + normalize an untrusted, already-JSON-parsed value into a
 * {@link ContentPack}. Throws {@link ContentPackError} (never echoing the
 * input) on anything malformed.
 */
export function validateContentPack(raw: unknown): ContentPack {
  if (!isObj(raw)) throw new ContentPackError('content pack must be a JSON object');
  if (raw.formatVersion !== CONTENT_PACK_FORMAT_VERSION)
    throw new ContentPackError(`unsupported content pack formatVersion (this build supports ${CONTENT_PACK_FORMAT_VERSION})`);

  const id = requireStr(raw.id, 'id');
  if (!ID_RE.test(id)) throw new ContentPackError('content pack "id" must be a short lowercase-kebab identifier');

  const lorebookRaw = raw.lorebook;
  if (lorebookRaw !== undefined && !Array.isArray(lorebookRaw))
    throw new ContentPackError('content pack "lorebook" must be an array');
  const lorebookArr = Array.isArray(lorebookRaw) ? lorebookRaw : [];
  if (lorebookArr.length > MAX_LOREBOOK_ENTRIES)
    throw new ContentPackError(`content pack "lorebook" has too many entries (max ${MAX_LOREBOOK_ENTRIES})`);

  const npcsRaw = raw.npcs;
  if (npcsRaw !== undefined && !Array.isArray(npcsRaw))
    throw new ContentPackError('content pack "npcs" must be an array');
  const npcsArr = Array.isArray(npcsRaw) ? npcsRaw : [];
  if (npcsArr.length > MAX_NPCS) throw new ContentPackError(`content pack "npcs" has too many entries (max ${MAX_NPCS})`);

  return {
    formatVersion: CONTENT_PACK_FORMAT_VERSION,
    id,
    name: requireStr(raw.name, 'name'),
    version: requireStr(raw.version, 'version', 32),
    description: optStr(raw.description, 'description'),
    author: optStr(raw.author, 'author'),
    premium: raw.premium === undefined ? false : Boolean(raw.premium),
    rulesModule: validateRulesModule(raw.rulesModule),
    lorebook: lorebookArr.map((e, i) => validateLoreEntry(e, i)),
    npcs: npcsArr.map((e, i) => validateNpc(e, i)),
    campaignStarter: validateCampaignStarter(raw.campaignStarter),
  };
}

/** Parse pack JSON text without ever echoing the (untrusted) input in the error. */
export function parseContentPackJson(text: string): ContentPack {
  if (text.length > MAX_PACK_BYTES) throw new ContentPackError('content pack file is too large');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ContentPackError('content pack is not valid JSON');
  }
  return validateContentPack(json);
}
