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

const TOKEN = /\[PRIVATE:([^\]]*)\]|\[\/PRIVATE\]/g;

/**
 * Split a completion into the public remainder and its private sections.
 *
 * Fail-closed by design: models malform markers (truncated completions leave a
 * dangling opener; some nest sections), and anything that slips through here is
 * broadcast to the whole channel. So this is a linear scan with a stack, not a
 * pair-matching regex: an unclosed `[PRIVATE:...]` keeps everything to the end
 * of the text private, nested sections each go to their own character, and a
 * stray `[/PRIVATE]` in public text is dropped rather than echoed.
 */
export function splitFog(narration: string): { publicText: string; privates: PrivateSection[] } {
  const privates: PrivateSection[] = [];
  const publicParts: string[] = [];
  const stack: string[] = []; // enclosing private sections' character names, innermost last
  let cursor = 0;

  const flush = (end: number) => {
    const segment = narration.slice(cursor, end);
    const owner = stack.at(-1);
    if (owner === undefined) publicParts.push(segment);
    else if (owner && segment.trim()) privates.push({ characterName: owner, content: segment.trim() });
    // owner === '' (nameless marker): undeliverable — dropped, never public.
  };

  for (const match of narration.matchAll(TOKEN)) {
    flush(match.index);
    cursor = match.index + match[0].length;
    if (match[1] !== undefined) stack.push(match[1].trim());
    else stack.pop(); // closer; a stray one in public text pops nothing
  }
  flush(narration.length); // unclosed opener → the tail stays private

  const publicText = publicParts.join('').replace(/\n{3,}/g, '\n\n').trim();
  return { publicText, privates };
}
