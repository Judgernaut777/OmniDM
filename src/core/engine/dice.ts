/**
 * Deterministic dice roller — ported from open-tabletop-gm's dice.py.
 *
 * Why it lives in the engine and not the LLM: the model must narrate outcomes
 * it did not get to choose. Rolls are resolved here, then handed to the narrator
 * as fixed facts. Supports an optional seed so a whole session can be replayed.
 *
 * Notation: d20  2d6  d20+5  4d6kh3  4d6kl3  d20 adv  d20+3 dis  2d6+3
 */
import type { CheckResult, RollResult } from '../types.js';

/** Mulberry32 — tiny seedable PRNG. Unseeded falls back to Math.random. */
function makeRng(seed?: number): () => number {
  if (seed === undefined) return Math.random;
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ParsedNotation {
  numDice: number;
  dieSize: number;
  modifier: number;
  keepMode?: 'kh' | 'kl';
  keepCount?: number;
  adv: boolean;
  dis: boolean;
}

export function parseNotation(input: string): ParsedNotation {
  let notation = input.trim().toLowerCase();
  const adv = /\b(adv|advantage)\b/.test(notation);
  const dis = /\b(dis|disadvantage)\b/.test(notation);
  notation = notation.replace(/\s*(adv|dis|advantage|disadvantage)\w*/g, '').trim();

  const m = notation.replace(/\s+/g, '').match(/^(\d*)d(\d+)(?:(kh|kl)(\d+))?([+-]\d+)?$/);
  if (!m) throw new Error(`Cannot parse dice notation: '${input}'`);

  return {
    numDice: m[1] ? parseInt(m[1], 10) : 1,
    dieSize: parseInt(m[2], 10),
    keepMode: (m[3] as 'kh' | 'kl') || undefined,
    keepCount: m[4] ? parseInt(m[4], 10) : undefined,
    modifier: m[5] ? parseInt(m[5], 10) : 0,
    adv,
    dis,
  };
}

export function roll(notation: string, by = 'Someone', seed?: number): RollResult {
  const rng = makeRng(seed);
  const p = parseNotation(notation);
  const rollN = (n: number, size: number) =>
    Array.from({ length: n }, () => 1 + Math.floor(rng() * size));

  // Advantage / disadvantage (single die, take higher/lower of two)
  if (p.adv || p.dis) {
    const a = rollN(p.numDice, p.dieSize);
    const b = rollN(p.numDice, p.dieSize);
    const totalA = a.reduce((s, r) => s + r, 0) + p.modifier;
    const totalB = b.reduce((s, r) => s + r, 0) + p.modifier;
    const takeA = p.adv ? totalA >= totalB : totalA <= totalB;
    return {
      by,
      notation,
      rolls: takeA ? a : b,
      total: takeA ? totalA : totalB,
      note: p.adv ? 'advantage' : 'disadvantage',
    };
  }

  const rolls = rollN(p.numDice, p.dieSize);

  // Keep highest / lowest (e.g. ability-score generation 4d6kh3)
  if (p.keepMode && p.keepCount) {
    const sorted = [...rolls].sort((x, y) => (p.keepMode === 'kh' ? y - x : x - y));
    const kept = sorted.slice(0, p.keepCount);
    return {
      by,
      notation,
      rolls: kept,
      total: kept.reduce((s, r) => s + r, 0) + p.modifier,
      note: `kept ${p.keepMode}${p.keepCount}`,
    };
  }

  const total = rolls.reduce((s, r) => s + r, 0) + p.modifier;
  let note: string | undefined;
  if (p.numDice === 1 && p.dieSize === 20) {
    if (rolls[0] === 20) note = 'CRITICAL HIT (nat 20)';
    else if (rolls[0] === 1) note = 'FUMBLE (nat 1)';
  }
  return { by, notation, rolls, total, note };
}

/** Pull dice notations out of free text, e.g. "I attack with my d20+5 sword". */
export function extractRolls(text: string): string[] {
  const matches = text.match(/\b\d*d\d+(?:(?:kh|kl)\d+)?(?:[+-]\d+)?(?:\s*(?:adv|dis))?/gi);
  return matches ? matches.map((s) => s.trim()) : [];
}

/** The six 5e ability score abbreviations `/dm check` accepts. */
export const ABILITIES = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'] as const;

/** Case-insensitively validate an ability abbreviation, e.g. "str" → "STR". Undefined if not one of the six. */
export function normalizeAbility(input: string): string | undefined {
  const up = input.trim().toUpperCase();
  return (ABILITIES as readonly string[]).includes(up) ? up : undefined;
}

/**
 * Resolve an ability check deterministically, engine-side, BEFORE narration:
 * roll 1d20 (+ an optional flat modifier) and compare to the DC. A natural 20
 * always passes and a natural 1 always fails, mirroring the crit rules `roll()`
 * already applies to attack-style d20s.
 */
export function rollCheck(ability: string, dc: number, modifier = 0, by = 'Someone', seed?: number): CheckResult {
  const rng = makeRng(seed);
  const die = 1 + Math.floor(rng() * 20);
  const total = die + modifier;
  let pass = total >= dc;
  let note: string | undefined;
  if (die === 20) {
    note = 'CRITICAL SUCCESS (nat 20)';
    pass = true;
  } else if (die === 1) {
    note = 'CRITICAL FAILURE (nat 1)';
    pass = false;
  }
  return { by, ability, dc, roll: die, modifier, total, pass, note };
}
