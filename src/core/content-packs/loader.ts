/**
 * Content-pack loader — imports a validated {@link ContentPack} into a
 * session, reusing the SAME machinery `/dm lore add`, `/dm import`, and the
 * rules registry already use. This is the "install" step; validation
 * happens first (see ./validate.ts) and entitlement gating happens here.
 *
 * Browser-safe: no `node:` imports.
 */
import type { CharacterCard } from '../cards/card-parse.js';
import type { GameSession, TurnRecord } from '../types.js';
import { makeEntry } from '../lore/lorebook.js';
import { selfHostEntitlements, type Entitlements, type EntitlementScope } from '../entitlements/entitlements.js';
import type { ContentPack } from './types.js';

/** Thrown by {@link loadContentPack} when a premium pack isn't unlocked for the current entitlements. */
export class PackLockedError extends Error {
  constructor(public readonly packId: string) {
    super(`Content pack "${packId}" is a premium pack and isn't unlocked.`);
    this.name = 'PackLockedError';
  }
}

/** What a load actually did — surfaced so a caller (bot/UI) can report it without re-deriving. */
export interface ContentPackLoadResult {
  packId: string;
  lorebookAdded: number;
  npcsAdded: number;
  rulesRegistered: boolean;
  starterApplied: boolean;
}

/**
 * Whether `pack` should be displayed as locked ("(locked)" in `/dm pack
 * list`) for `entitlements`/`scope` — the SAME condition
 * {@link loadContentPack} actually enforces (`pack.premium &&
 * !entitlements.isUnlocked(...)`), factored out so a display surface can't
 * silently drift from the real gate. A free pack (`premium` falsy) is never
 * locked, regardless of what `isUnlocked` says for its id — loading a free
 * pack always succeeds, so showing "(locked)" next to one would be a lie.
 */
export function isPackLockedForDisplay(
  pack: { id: string; premium?: boolean },
  entitlements: Entitlements,
  scope?: EntitlementScope,
): boolean {
  return Boolean(pack.premium) && !entitlements.isUnlocked(pack.id, scope);
}

function npcToCard(npc: ContentPack['npcs'][number]): CharacterCard {
  return {
    specVersion: '2.0',
    name: npc.name,
    description: npc.description,
    personality: npc.personality,
    scenario: npc.scenario,
    firstMes: npc.firstMes,
    mesExample: npc.mesExample,
    systemPrompt: npc.systemPrompt,
  };
}

/**
 * Import `pack` into `session`: attaches its rules module (if any) to THIS
 * session only (`session.customRules` — never a process-wide registry, so
 * one session's pack can't leak into or clobber another session's rules; see
 * `GameSession.customRules`), adds its lorebook entries and NPCs
 * (deduplicated by content/name — loading the same pack twice is a no-op the
 * second time), and — only for a session with no history yet — applies its
 * campaign starter.
 *
 * Throws {@link PackLockedError} if `pack.premium` and `entitlements` doesn't
 * unlock `pack.id`. Defaults to {@link selfHostEntitlements} (everything
 * unlocked), matching self-host's "no billing, nothing gated" posture.
 */
export function loadContentPack(
  pack: ContentPack,
  session: GameSession,
  entitlements: Entitlements = selfHostEntitlements,
): ContentPackLoadResult {
  if (pack.premium && !entitlements.isUnlocked(pack.id, { platform: session.platform, channelId: session.channelId }))
    throw new PackLockedError(pack.id);

  let lorebookAdded = 0;
  for (const e of pack.lorebook) {
    if (session.lorebook.some((existing) => existing.content === e.content)) continue;
    const entry = makeEntry(e.name, e.keywords, e.content);
    entry.enabled = e.enabled ?? true;
    session.lorebook.push(entry);
    lorebookAdded++;
  }

  let npcsAdded = 0;
  for (const npc of pack.npcs) {
    if (session.npcs.some((existing) => existing.name === npc.name)) continue;
    session.npcs.push(npcToCard(npc));
    npcsAdded++;
  }

  let rulesRegistered = false;
  if (pack.rulesModule) {
    session.customRules = { id: pack.rulesModule.id, markdown: pack.rulesModule.markdown };
    rulesRegistered = true;
  }

  let starterApplied = false;
  const starter = pack.campaignStarter;
  if (starter && session.history.length === 0) {
    session.summary = session.summary ? `${session.summary}\n\n${starter.summary}` : starter.summary;
    if (starter.systemId) session.systemId = starter.systemId;
    if (starter.openingNarration) {
      const turn: TurnRecord = { actions: [], rolls: [], narration: starter.openingNarration, ts: Date.now() };
      session.history.push(turn);
    }
    starterApplied = true;
  }

  return { packId: pack.id, lorebookAdded, npcsAdded, rulesRegistered, starterApplied };
}
