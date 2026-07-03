/**
 * Portrait presets — a fixed catalog of archetype ids.
 *
 * The server stores only the id ({kind:'preset', id}); the actual art is
 * rendered client-side later. Players who want their own picture upload an
 * image instead (POST /portrait/… on the web adapter), which never violates
 * the WebSocket frame cap because the bytes travel over HTTP.
 */
export const PORTRAIT_PRESETS = [
  'fighter',
  'mage',
  'ranger',
  'rogue',
  'cleric',
  'bard',
  'barbarian',
  'druid',
] as const;

export type PortraitPresetId = (typeof PORTRAIT_PRESETS)[number];

/**
 * Normalize user input to a known preset id. Accepts a bare id (`fighter`) or
 * the `preset:fighter` form; returns '' when the id isn't in the catalog.
 */
export function normalizePresetId(raw: string): PortraitPresetId | '' {
  const id = raw.trim().toLowerCase().replace(/^preset:/, '');
  return (PORTRAIT_PRESETS as readonly string[]).includes(id) ? (id as PortraitPresetId) : '';
}
