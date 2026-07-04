/**
 * Content-pack format — the monetization scaffold's actual substance.
 *
 * A content pack is a versioned, portable JSON bundle: an optional rules/system
 * module (the narrator's system prompt for a homebrew ruleset), lorebook
 * entries, NPC cards, and an optional campaign starter. It reuses the SAME
 * types the rest of the engine already uses for these things (`LoreEntry`,
 * `CharacterCard`-shaped NPCs, `RulesProvider`) rather than inventing a
 * parallel content model — a pack is just a bulk, shareable way to fill in
 * the same session fields `/dm lore add`, `/dm import`, and a system module
 * already populate one at a time.
 *
 * `formatVersion` is a SEPARATE number from the pack's own `version` (an
 * author's semver for their content): it's the schema contract this file
 * commits to, bumped only when the shape of a `ContentPack` itself changes,
 * so a loader can refuse a pack from a newer/older format outright instead of
 * partially importing garbage.
 *
 * Browser-safe: no `node:` imports anywhere in this module.
 */

/** The schema version this module implements. Bump on any shape change. */
export const CONTENT_PACK_FORMAT_VERSION = 1 as const;

/** One lorebook entry as shipped in a pack — same shape `/dm lore add` builds, minus the generated id. */
export interface PackLoreEntry {
  name: string;
  /** Case-insensitive substring triggers; [] = always injected. */
  keywords: string[];
  content: string;
  enabled?: boolean; // defaults true
}

/** One NPC as shipped in a pack — the subset of `CharacterCard` a pack author writes by hand. */
export interface PackNpc {
  name: string;
  description?: string;
  personality?: string;
  scenario?: string;
  firstMes?: string;
  mesExample?: string;
  systemPrompt?: string;
}

/**
 * An optional rules/system module a pack ships for its own ruleset. Same shape
 * the narrator already consumes (see `rules/registry.ts`'s bundled markdown
 * modules) — a pack just registers one at load time instead of it being
 * compiled in.
 */
export interface PackRulesModule {
  /** The `systemId` this module registers as (what a session's `systemId` is set to). */
  id: string;
  name: string;
  /** The system-prompt markdown the narrator injects for this system, verbatim. */
  markdown: string;
}

/** An optional ready-to-play opening for a fresh session. */
export interface PackCampaignStarter {
  title: string;
  /** Seeds the session's rolling "living summary". */
  summary: string;
  /** Optional opening DM narration, recorded as the session's first turn. */
  openingNarration?: string;
  /** If set, a fresh session's `systemId` is switched to this pack's rules module. */
  systemId?: string;
}

/** A validated, normalized content pack — the shape {@link validateContentPack} returns. */
export interface ContentPack {
  formatVersion: typeof CONTENT_PACK_FORMAT_VERSION;
  /** Short, stable, kebab-case identifier — also the entitlement key premium packs gate on. */
  id: string;
  name: string;
  /** The pack author's own semver, independent of `formatVersion`. */
  version: string;
  description?: string;
  author?: string;
  /** True if this pack requires an unlocking entitlement (see `entitlements/`). Defaults false. */
  premium?: boolean;
  rulesModule?: PackRulesModule;
  lorebook: PackLoreEntry[];
  npcs: PackNpc[];
  campaignStarter?: PackCampaignStarter;
}
