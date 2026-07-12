/**
 * Narrator — builds the prompt and calls the model to narrate a turn.
 *
 * Borrowed shape (daicer's narrative-engine): the LLM narrates an ALREADY
 * RESOLVED turn. Dice are in `rolls` and are stated as fixed facts, so the model
 * can't fudge them. We keep v1 output as prose (not strict JSON) on purpose:
 * the small/free models you'll test with are unreliable at JSON, and the
 * open-tabletop-gm probe notes they drift after a few structured tool calls.
 */
import type { ChatMessage, CheckResult, GameSession, LLMProvider, Player, RollResult } from '../types.js';
import { renderCard } from '../cards/card-parse.js';
import { classPreset, MAX_BIO_CHARS } from '../portraits.js';
import { buildWorldInfo } from '../lore/lorebook.js';
import { HISTORY_WINDOW, type MemoryRecord } from '../memory/retrieval.js';
import { bundledRulesProvider, type RulesProvider } from '../rules/registry.js';
import { summarizeCombat } from '../rules/combat.js';
import { describeConditions } from '../rules/conditions.js';
import { findSpell, slotSummary } from '../rules/spells.js';
import { FOG_PROMPT } from './fog.js';

const BASE_DM_PROMPT = `You are an expert tabletop RPG Dungeon Master running a game for multiple players in a shared chat channel. You are collaborative, vivid, and fair. You keep the spotlight moving between players and never railroad them. Stay in character as the narrator/DM at all times.`;

/**
 * Engine-owned mechanical state, explained ONCE here (system-neutral) so every
 * rules module (dnd5e.system.ts etc.) can just remind the model to use it in
 * its own terms. This is additive and safe to ignore: nothing breaks if the
 * model never emits a marker — the game just stays pure narration for that
 * turn, exactly as before this existed.
 */
const MECHANICS_PROMPT = `## Mechanical state markers (optional, invisible to players)
HP and conditions are tracked by the game engine, not by you. When your narration deals damage, heals someone, or imposes/lifts a condition (e.g. unconscious, prone, frightened, dead) on a REAL combatant — a party member OR a monster listed under "Combat" — end your reply with one machine marker per change, each ALONE on its own line, in exactly this form:
<<hp CharacterName -7>>              (damage — a negative number)
<<heal CharacterName 4>>             (healing — a positive number)
<<condition CharacterName prone>>    (impose a condition, one lowercase word)
<<uncondition CharacterName prone>>  (lift a condition the character had)
Use the exact name as shown under "The party" or the combat order. The engine reads these markers, applies the mechanical change, and STRIPS them before players see your text — never mention the marker syntax in your prose, never fabricate a marker for someone who isn't a real combatant, and never emit one when nothing mechanical happened.`;

/**
 * A one-line character sheet for the prompt: the player's class (with its flavor
 * descriptor) and bounded bio. Empty when the player has set neither — the card
 * block, if any, carries the rest of the persona.
 */
function characterSheet(p: Player): string {
  const parts: string[] = [];
  if (p.class) {
    const cls = classPreset(p.class);
    parts.push(`Class: ${cls.name} (${cls.flavor})`);
  }
  if (p.bio) {
    const bio = p.bio.length > MAX_BIO_CHARS ? `${p.bio.slice(0, MAX_BIO_CHARS)}…` : p.bio;
    parts.push(`Bio: ${bio}`);
  }
  // Equipped gear + spellcasting are engine-owned facts (see rules/inventory.ts,
  // rules/spells.ts): surfaced READ-ONLY so the DM narrates them consistently
  // (mentions the worn armor, doesn't hand out a slot the caster has spent).
  const gear = [
    p.equipped?.weapon ? `wielding ${itemName(p, p.equipped.weapon)}` : '',
    p.equipped?.armor ? `wearing ${itemName(p, p.equipped.armor)}` : '',
    p.equipped?.shield ? `with a ${itemName(p, p.equipped.shield)}` : '',
  ].filter(Boolean);
  if (gear.length) parts.push(`Equipped: ${gear.join(', ')}`);
  if (p.spellSlots && Object.keys(p.spellSlots).length) parts.push(`Spell slots: ${slotSummary(p)}`);
  const spells = (p.spells ?? []).map((id) => findSpell(id)?.name).filter(Boolean);
  if (spells.length) parts.push(`Knows: ${spells.join(', ')}`);
  if (!parts.length) return '';
  const name = p.characterName || p.userName;
  return `- ${name} (played by ${p.userName}) — ${parts.join('. ')}`;
}

/** The display name of a carried item id, falling back to the id itself. */
function itemName(p: Player, id: string): string {
  return (p.inventory ?? []).find((it) => it.id === id)?.name ?? id;
}

export class Narrator {
  /**
   * @param provider the LLM backend
   * @param rules where the per-session system module (rules markdown) comes
   *   from. Defaults to the bundled, dependency-free registry so the narrator
   *   never touches node:fs and can run in a browser; a Node host may inject a
   *   filesystem-backed provider to restore the "drop a markdown file" flow.
   */
  constructor(
    private provider: LLMProvider,
    private rules: RulesProvider = bundledRulesProvider,
  ) {}

  private buildMessages(
    session: GameSession,
    actions: { name: string; text: string }[],
    rolls: RollResult[],
    pastEvents: MemoryRecord[],
    checks: CheckResult[] = [],
  ): ChatMessage[] {
    const roster = Object.values(session.players)
      .map((p) => {
        const conds = p.conditions?.length ? ` [${p.conditions.join(', ')}]` : '';
        return `- ${p.characterName || p.userName} (HP ${p.hp}/${p.maxHp})${conds}`;
      })
      .join('\n') || '- (no characters yet)';

    // Live combat: engine-owned initiative order + round, so the DM narrates the
    // turn whose combatant is acting and never invents turn order or round count.
    const combatText = summarizeCombat(session);

    // A glossary of the conditions currently in play (players + monsters), so the
    // DM plays "restrained"/"frightened" by its rules, not as a flavor word.
    const activeConditions = [
      ...Object.values(session.players).flatMap((p) => p.conditions ?? []),
      ...(session.encounter?.order ?? []).flatMap((c) => c.conditions ?? []),
    ];
    const conditionGlossary = describeConditions(activeConditions);

    // Lightweight per-player character notes (class + bio) — a complement to any
    // imported card, not a duplicate: the sheet is a one-liner, the card its own
    // rich block below. Bounded so a long bio can't blow the prompt budget.
    const sheets = Object.values(session.players)
      .map((p) => characterSheet(p))
      .filter(Boolean);

    // Imported Character Cards: player personas + session NPCs, bounded blocks.
    const cards = [
      ...Object.values(session.players)
        .filter((p) => p.card)
        .map((p) => renderCard(p.card!, `player character (played by ${p.userName})`)),
      ...(session.npcs ?? []).map((c) => renderCard(c, 'NPC (portrayed by you, the DM)')),
    ];

    // A content pack's homebrew rules module is scoped to THIS session (see
    // `GameSession.customRules`) and takes priority over the shared registry
    // when it matches the session's current system — never a process-wide
    // lookup, so a pack loaded in one session can't leak into or collide with
    // another session's rules.
    const rulesText = session.customRules?.id === session.systemId
      ? session.customRules.markdown
      : this.rules.system(session.systemId);

    const system = [
      BASE_DM_PROMPT,
      MECHANICS_PROMPT,
      rulesText,
      `## The party\n${roster}`,
      combatText,
      conditionGlossary ? `## Active conditions (play these by their rules)\n${conditionGlossary}` : '',
      sheets.length ? `## Player characters (play each true to their class and bio)\n${sheets.join('\n')}` : '',
      cards.length ? `## Imported characters (portray each consistently with their card)\n${cards.join('\n\n')}` : '',
      session.fogOfWar ? FOG_PROMPT : '',
      session.summary ? `## Story so far\n${session.summary}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    // Recent verbatim history (the rolling summary covers older turns).
    const historyText = session.history
      .slice(-HISTORY_WINDOW)
      .map((t) => {
        const acts = t.actions.map((a) => `${a.name}: ${a.text}`).join('\n');
        return `${acts}\nDM: ${t.narration}`;
      })
      .join('\n\n');

    const rollText = rolls.length
      ? rolls
          .map((r) => `${r.by} rolled ${r.notation} → ${r.total} [${r.rolls.join(', ')}]${r.note ? ` (${r.note})` : ''}`)
          .join('\n')
      : '(no dice this turn)';

    const checkText = checks.length
      ? checks
          .map((c) => {
            const mod = c.modifier ? (c.modifier > 0 ? `+${c.modifier}` : `${c.modifier}`) : '';
            return `${c.by} attempted a ${c.ability} check (DC ${c.dc}): rolled ${c.roll}${mod} = ${c.total} → ${c.pass ? 'PASS' : 'FAIL'}${c.note ? ` (${c.note})` : ''}`;
          })
          .join('\n')
      : '';

    const actionText = actions.map((a) => `${a.name}: ${a.text}`).join('\n');

    // Lorebook: scan this turn's actions plus recent turns (newest first) for
    // entry keywords; matched world info is injected, bounded, freshest first.
    const scanTexts = [
      actions.map((a) => a.text).join('\n'),
      ...session.history
        .slice(-HISTORY_WINDOW)
        .reverse()
        .map((t) => [...t.actions.map((a) => a.text), t.narration].join('\n')),
    ];
    const worldInfo = buildWorldInfo(session.lorebook ?? [], scanTexts);

    // Vector-memory recall: older turns relevant to this action, retrieved by
    // the pipeline from outside the recent-history window above.
    const pastText = pastEvents.map((m) => `- ${m.text}`).join('\n');

    const user = [
      worldInfo ? `WORLD INFO (established lore — keep your narration consistent with it):\n${worldInfo}` : '',
      pastText ? `RELEVANT PAST EVENTS (recalled from earlier in the campaign — stay consistent with them):\n${pastText}` : '',
      historyText ? `RECENT HISTORY:\n${historyText}` : '',
      `RESOLVED ROLLS (narrate these exact outcomes; do not change them):\n${rollText}`,
      checkText ? `RESOLVED CHECKS (state each result as PASS or FAIL exactly as given; do not change it):\n${checkText}` : '',
      `THE PLAYERS' ACTIONS THIS TURN:\n${actionText}`,
      `As the DM, narrate what happens next.`,
    ]
      .filter(Boolean)
      .join('\n\n');

    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  async narrate(
    session: GameSession,
    actions: { name: string; text: string }[],
    rolls: RollResult[],
    pastEvents: MemoryRecord[] = [],
    checks: CheckResult[] = [],
  ): Promise<string> {
    const messages = this.buildMessages(session, actions, rolls, pastEvents, checks);
    return this.provider.complete({ model: session.model, messages });
  }
}
