/**
 * Class presets — the fixed catalog of the 12 official D&D 5e classes.
 *
 * Each preset is both a PORTRAIT id ({kind:'preset', id}) and a character CLASS
 * id: a player's `class` can equal their preset portrait id. The server stores
 * only the id; the actual art is rendered client-side (web/portraits.js). Players
 * who want their own picture upload an image instead (POST /portrait on the web
 * adapter), whose bytes travel over HTTP and never violate the WS frame cap.
 */

export interface ClassPreset {
  /** Stable id — also a character's class id and a portrait preset id. */
  id: PortraitPresetId;
  /** Display name, e.g. "Wizard". */
  name: string;
  /** A short one-line flavor descriptor for the narrator prompt. */
  flavor: string;
}

/** The 12 official D&D 5e classes, in alphabetical order. */
export const PORTRAIT_PRESETS = [
  'barbarian',
  'bard',
  'cleric',
  'druid',
  'fighter',
  'monk',
  'paladin',
  'ranger',
  'rogue',
  'sorcerer',
  'warlock',
  'wizard',
] as const;

export type PortraitPresetId = (typeof PORTRAIT_PRESETS)[number];

export const CLASS_PRESETS: readonly ClassPreset[] = [
  { id: 'barbarian', name: 'Barbarian', flavor: 'a raging warrior of primal fury' },
  { id: 'bard', name: 'Bard', flavor: 'a silver-tongued weaver of song and magic' },
  { id: 'cleric', name: 'Cleric', flavor: "a divine channeler of a god's power" },
  { id: 'druid', name: 'Druid', flavor: 'a shapeshifting guardian of the wild' },
  { id: 'fighter', name: 'Fighter', flavor: 'a master of martial weapons and tactics' },
  { id: 'monk', name: 'Monk', flavor: 'a disciplined martial artist channeling inner ki' },
  { id: 'paladin', name: 'Paladin', flavor: 'a holy warrior bound by a sacred oath' },
  { id: 'ranger', name: 'Ranger', flavor: 'a wilderness hunter and unerring tracker' },
  { id: 'rogue', name: 'Rogue', flavor: 'a stealthy expert in guile and precision strikes' },
  { id: 'sorcerer', name: 'Sorcerer', flavor: 'an innate wielder of raw arcane power' },
  { id: 'warlock', name: 'Warlock', flavor: 'a caster empowered by an otherworldly pact' },
  { id: 'wizard', name: 'Wizard', flavor: 'a robed scholar of the arcane' },
];

/** Max characters a per-player bio may hold — a lightweight persona, kept short. */
export const MAX_BIO_CHARS = 500;

/**
 * Legacy portrait/class ids from the old 8-archetype catalog that no longer
 * exist, mapped to their closest surviving class. Anything not listed falls
 * back to a generic default (see {@link resolvePresetId}).
 */
const LEGACY_ALIASES: Record<string, PortraitPresetId> = { mage: 'wizard' };

const canonical = (raw: string): string => raw.trim().toLowerCase().replace(/^preset:/, '');

/**
 * Normalize user input to a known preset/class id. Accepts a bare id
 * (`fighter`), the `preset:fighter` form, or a display name (`Fighter`, since
 * names are just capitalized ids). Returns '' when the id isn't in the catalog.
 */
export function normalizePresetId(raw: string): PortraitPresetId | '' {
  const id = canonical(raw);
  return (PORTRAIT_PRESETS as readonly string[]).includes(id) ? (id as PortraitPresetId) : '';
}

/**
 * Resolve ANY stored id to a valid class in the catalog — never crashes. A
 * current id passes through; a retired legacy id (e.g. `mage`) maps via
 * {@link LEGACY_ALIASES}; anything else falls back to `fighter`. Use this when
 * you must read metadata off a possibly-stale saved id.
 */
export function resolvePresetId(raw: string): PortraitPresetId {
  const id = normalizePresetId(raw);
  if (id) return id;
  return LEGACY_ALIASES[canonical(raw)] ?? 'fighter';
}

/** The catalog entry for an id, resolving legacy/unknown ids to a sensible one. */
export function classPreset(raw: string): ClassPreset {
  const id = resolvePresetId(raw);
  return CLASS_PRESETS.find((c) => c.id === id) ?? CLASS_PRESETS[0];
}
