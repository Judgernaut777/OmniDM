/**
 * Fog of war — per-player private narration (daicer's `player_perspectives`).
 *
 * When a session has fog enabled, the narrator asks the model to append
 * optional private sections using exact markers:
 *
 *   [PRIVATE:CharacterName]only that character perceives this[/PRIVATE]
 *
 * This module owns both halves of that contract: the system-prompt addition
 * and the parser that splits a completion into the public remainder plus the
 * per-character private sections. Delivery (channel vs. whisper/DM) is the
 * bot router's job; unknown character names are dropped silently there.
 */

export const FOG_PROMPT = `## Fog of war (private narration)
Fog of war is ON. After the shared narration, you MAY append private sections that only one character perceives (whispers, hidden details, secret perception results), using EXACTLY this format:
[PRIVATE:CharacterName]text only that character learns[/PRIVATE]
Use a character's exact name from the party roster. Everything outside these markers is public to the whole party. Never reveal one character's private information in the public text.`;

export interface PrivateSection {
  characterName: string;
  content: string;
}

const MARKER = /\[PRIVATE:([^\]]+)\]([\s\S]*?)\[\/PRIVATE\]/g;

/** Split a completion into the public remainder and its private sections. */
export function splitFog(narration: string): { publicText: string; privates: PrivateSection[] } {
  const privates: PrivateSection[] = [];
  const publicText = narration
    .replace(MARKER, (_m, name: string, content: string) => {
      const characterName = name.trim();
      if (characterName && content.trim()) privates.push({ characterName, content: content.trim() });
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { publicText, privates };
}
