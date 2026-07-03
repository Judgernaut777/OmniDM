/**
 * Narrator — builds the prompt and calls the model to narrate a turn.
 *
 * Borrowed shape (daicer's narrative-engine): the LLM narrates an ALREADY
 * RESOLVED turn. Dice are in `rolls` and are stated as fixed facts, so the model
 * can't fudge them. We keep v1 output as prose (not strict JSON) on purpose:
 * the small/free models you'll test with are unreliable at JSON, and the
 * open-tabletop-gm probe notes they drift after a few structured tool calls.
 */
import type { ChatMessage, GameSession, LLMProvider, Player, RollResult } from '../types.js';
import { renderCard } from '../cards/card-parse.js';
import { classPreset, MAX_BIO_CHARS } from '../portraits.js';
import { buildWorldInfo } from '../lore/lorebook.js';
import { HISTORY_WINDOW, type MemoryRecord } from '../memory/retrieval.js';
import { bundledRulesProvider, type RulesProvider } from '../rules/registry.js';
import { FOG_PROMPT } from './fog.js';

const BASE_DM_PROMPT = `You are an expert tabletop RPG Dungeon Master running a game for multiple players in a shared chat channel. You are collaborative, vivid, and fair. You keep the spotlight moving between players and never railroad them. Stay in character as the narrator/DM at all times.`;

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
  if (!parts.length) return '';
  const name = p.characterName || p.userName;
  return `- ${name} (played by ${p.userName}) — ${parts.join('. ')}`;
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
  ): ChatMessage[] {
    const roster = Object.values(session.players)
      .map((p) => `- ${p.characterName || p.userName} (HP ${p.hp}/${p.maxHp})`)
      .join('\n') || '- (no characters yet)';

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

    const system = [
      BASE_DM_PROMPT,
      this.rules.system(session.systemId),
      `## The party\n${roster}`,
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
  ): Promise<string> {
    const messages = this.buildMessages(session, actions, rolls, pastEvents);
    return this.provider.complete({ model: session.model, messages });
  }
}
