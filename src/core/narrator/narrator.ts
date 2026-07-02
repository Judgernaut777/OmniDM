/**
 * Narrator — builds the prompt and calls the model to narrate a turn.
 *
 * Borrowed shape (daicer's narrative-engine): the LLM narrates an ALREADY
 * RESOLVED turn. Dice are in `rolls` and are stated as fixed facts, so the model
 * can't fudge them. We keep v1 output as prose (not strict JSON) on purpose:
 * the small/free models you'll test with are unreliable at JSON, and the
 * open-tabletop-gm probe notes they drift after a few structured tool calls.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ChatMessage, GameSession, LLMProvider, RollResult } from '../types.js';
import { renderCard } from '../cards/card.js';
import { buildWorldInfo } from '../lore/lorebook.js';
import { HISTORY_WINDOW, type MemoryRecord } from '../memory/retrieval.js';
import { FOG_PROMPT } from './fog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_DM_PROMPT = `You are an expert tabletop RPG Dungeon Master running a game for multiple players in a shared chat channel. You are collaborative, vivid, and fair. You keep the spotlight moving between players and never railroad them. Stay in character as the narrator/DM at all times.`;

function loadSystemModule(systemId: string): string {
  try {
    const p = path.join(__dirname, '..', '..', 'rules', systemId, 'system.md');
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

export class Narrator {
  constructor(private provider: LLMProvider) {}

  private buildMessages(
    session: GameSession,
    actions: { name: string; text: string }[],
    rolls: RollResult[],
    pastEvents: MemoryRecord[],
  ): ChatMessage[] {
    const roster = Object.values(session.players)
      .map((p) => `- ${p.characterName || p.userName} (HP ${p.hp}/${p.maxHp})`)
      .join('\n') || '- (no characters yet)';

    // Imported Character Cards: player personas + session NPCs, bounded blocks.
    const cards = [
      ...Object.values(session.players)
        .filter((p) => p.card)
        .map((p) => renderCard(p.card!, `player character (played by ${p.userName})`)),
      ...(session.npcs ?? []).map((c) => renderCard(c, 'NPC (portrayed by you, the DM)')),
    ];

    const system = [
      BASE_DM_PROMPT,
      loadSystemModule(session.systemId),
      `## The party\n${roster}`,
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
