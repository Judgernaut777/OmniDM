/**
 * Content-pack registry — the browser-safe catalog of bundled packs, parsed
 * from ./bundled-sources.ts (see that file's doc comment for why the JSON is
 * embedded as a string rather than read off disk). Mirrors `rules/registry.ts`'s
 * split between "bundled string" and "the thing that resolves it".
 *
 * Every bundled pack is validated EAGERLY at module load: a pack shipped in
 * this repo that fails validation is a build-time bug, not a runtime one, so
 * failing fast here (instead of swallowing it) is the right default.
 */
import { parseContentPackJson } from './validate.js';
import type { ContentPack } from './types.js';
import { BUNDLED_CONTENT_PACK_SOURCES } from './bundled-sources.js';

/** All bundled packs, validated once at module load, keyed by pack id. */
export const BUNDLED_CONTENT_PACKS: Record<string, ContentPack> = Object.fromEntries(
  Object.entries(BUNDLED_CONTENT_PACK_SOURCES).map(([id, json]) => [id, parseContentPackJson(json)]),
);

/** Look up a bundled pack by id, or `undefined` if there's no such pack. */
export function getBundledContentPack(id: string): ContentPack | undefined {
  return BUNDLED_CONTENT_PACKS[id];
}

/** List bundled packs (id/name/version/premium), for a catalog UI or `/dm pack list`. */
export function listBundledContentPacks(): Pick<ContentPack, 'id' | 'name' | 'version' | 'description' | 'premium'>[] {
  return Object.values(BUNDLED_CONTENT_PACKS).map(({ id, name, version, description, premium }) => ({
    id,
    name,
    version,
    description,
    premium,
  }));
}
