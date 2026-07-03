/* OmniDM procedural portraits — shared client helper that draws stylized
 * D&D-CLASS CHARACTER BUSTS (an actual head, shoulders, hair/headwear and a
 * class-defining prop), not heraldic crests. Loaded BEFORE app.js (see
 * index.html) so both share PORTRAIT_PRESETS and portraitSVG(). Plain classic
 * script, no build step, no external origins.
 *
 * SECURITY: every node is built with document.createElementNS + setAttribute —
 * never innerHTML. The only "untrusted" input is a seed string (a character or
 * user name), used solely as a deterministic hash source and, for the class,
 * an allow-listed key lookup; a hostile name can never inject markup. An
 * unknown class id falls through to a neutral adventurer bust.
 *
 * DETERMINISM: the whole bust is a pure function of (seed, class). No
 * Math.random / Date anywhere — same seed + class always renders the same
 * portrait, which the smoke suite relies on for reproducible checks.
 *
 * BACKWARDS-COMPAT (smoke contract): the returned <svg> keeps class="crest",
 * contains a `.crest-emblem` group (the class-defining prop/headwear), has
 * >= 2 <path> children and a >= 2-stop background gradient, so the existing
 * headless crest/board checks keep passing.
 */
'use strict';

/* The fixed class catalog — mirrors src/core/portraits.ts (the 12 official D&D
 * 5e classes). */
const PORTRAIT_PRESETS = ['barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk', 'paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard'];

/* Retired ids from the old 8-archetype catalog → their nearest surviving class,
 * so a stale saved id still renders sensibly (mirrors resolvePresetId server-side). */
const CLASS_ALIASES = { mage: 'wizard' };

const PSVGNS = 'http://www.w3.org/2000/svg';
let PORTRAIT_UID = 0;

/** Namespaced SVG element with attributes — the sanctioned XSS-safe builder. */
function pnode(tag, attrs) {
  const e = document.createElementNS(PSVGNS, tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
}

/** FNV-1a string hash → unsigned 32-bit. Deterministic per seed. */
function phash(seed) {
  let h = 2166136261 >>> 0;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Mulberry32 PRNG → deterministic 0..1 stream seeded from a 32-bit int. */
function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hsl = (h, s, l) => `hsl(${((h % 360) + 360) % 360} ${Math.max(0, Math.min(100, s))}% ${Math.max(0, Math.min(100, l))}%)`;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** N-point star polygon points around (cx,cy). */
function starPoints(cx, cy, outer, inner, points, rot) {
  const out = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (rot || 0) + (Math.PI * i) / points;
    out.push(`${(cx + r * Math.sin(a)).toFixed(2)},${(cy - r * Math.cos(a)).toFixed(2)}`);
  }
  return out.join(' ');
}

/* Natural skin tones (h,s,l), pale → deep, plus two cool fantasy tints used
 * only by the innately-magical classes. Seeded pick varies faces of one class. */
const SKINS = [
  [28, 44, 83], [27, 46, 76], [25, 47, 68], [23, 46, 58],
  [21, 43, 48], [19, 41, 38], [17, 37, 30], [15, 33, 24],
];
const SKINS_ARCANE = [[268, 16, 72], [210, 14, 70]]; // faint violet / cold pallor

/* Hair colours (h,s,l): black, browns, auburn, blonde, red, grey, white. */
const HAIRS = [
  [22, 24, 12], [24, 40, 20], [26, 48, 30], [30, 58, 42],
  [34, 62, 54], [40, 70, 66], [12, 66, 38], [0, 0, 66], [40, 16, 86],
];

/* Per-class garment palette (h,s,l base) + accent (metal/gilt/eldritch) used
 * for headwear and props, kept muted for the candlelit gold-on-ink theme. */
const NEUTRAL = { g: [38, 20, 40], accent: '#d8c39a' };
const CLASS = {
  barbarian: { g: [24, 40, 34], accent: '#e7d7b2' },
  bard: { g: [322, 34, 42], accent: '#f0d27a' },
  cleric: { g: [45, 26, 66], accent: '#f4e2a0' },
  druid: { g: [96, 26, 32], accent: '#b98a52' },
  fighter: { g: [212, 10, 52], accent: '#ccd6e2' },
  monk: { g: [32, 52, 45], accent: '#e8c98a' },
  paladin: { g: [220, 30, 44], accent: '#ecdf9c' },
  ranger: { g: [140, 28, 30], accent: '#c9a869' },
  rogue: { g: [220, 12, 26], accent: '#9fb0c4' },
  sorcerer: { g: [4, 56, 42], accent: '#ffb257' },
  warlock: { g: [280, 34, 28], accent: '#79e6cf' },
  wizard: { g: [250, 42, 34], accent: '#f3e08a' },
};

/** Normalize any input to an allow-listed class id, or '' for the neutral bust. */
function resolveClass(raw) {
  const id = String(raw == null ? '' : raw).trim().toLowerCase().replace(/^preset:/, '');
  if (PORTRAIT_PRESETS.indexOf(id) !== -1) return id;
  return CLASS_ALIASES[id] || '';
}

/* Fixed head/face geometry in the 0..100 viewBox. The bust is centred so it
 * reads inside both the circular token clip and the card's rounded square. */
const HCX = 50, HCY = 43, HRX = 15, HRY = 17.5;
const EYE_Y = 45, EYE_L = 43.4, EYE_R = 56.6;

/** Build the character bust <svg> for `seed`, themed to `opts.class`/`opts.preset`. */
function portraitSVG(seed, opts) {
  opts = opts || {};
  const cls = resolveClass(opts.class || opts.preset || seed);
  const seedStr = String(seed == null ? '' : seed) || cls || 'anon';
  const rng = mulberry(phash(`${seedStr}|${cls}`));
  const cfg = CLASS[cls] || NEUTRAL;
  const uid = ++PORTRAIT_UID;

  // ── Seeded colours ────────────────────────────────────────────────────────
  const arcane = (cls === 'sorcerer' || cls === 'warlock') && rng() < 0.5;
  const skinBase = arcane ? SKINS_ARCANE[Math.floor(rng() * SKINS_ARCANE.length)] : SKINS[Math.floor(rng() * SKINS.length)];
  const skin = hsl(skinBase[0], skinBase[1], skinBase[2]);
  const skinDk = hsl(skinBase[0], skinBase[1], skinBase[2] - 13);
  const skinLt = hsl(skinBase[0], skinBase[1] + 4, Math.min(92, skinBase[2] + 8));
  const hairBase = HAIRS[Math.floor(rng() * HAIRS.length)];
  const hair = hsl(hairBase[0], hairBase[1], hairBase[2]);
  const hairDk = hsl(hairBase[0], hairBase[1], Math.max(6, hairBase[2] - 12));

  const gl = clamp(cfg.g[2] + Math.round(rng() * 10 - 5), 14, 80);
  const garment = hsl(cfg.g[0], cfg.g[1], gl);
  const garmentDk = hsl(cfg.g[0], cfg.g[1], Math.max(6, gl - 14));
  const garmentLt = hsl(cfg.g[0], cfg.g[1], Math.min(90, gl + 12));
  const accent = cfg.accent;
  const hairStyle = ['short', 'long', 'wild', 'topknot'][Math.floor(rng() * 4)];

  const bgTop = hsl(cfg.g[0], Math.round(cfg.g[1] * 0.5), 26);
  const bgBot = hsl(cfg.g[0], Math.round(cfg.g[1] * 0.6), 8);

  // ── Scaffold ──────────────────────────────────────────────────────────────
  const svg = pnode('svg', { viewBox: '0 0 100 100', class: 'crest', 'aria-hidden': 'true', preserveAspectRatio: 'xMidYMid meet' });
  const defs = pnode('defs');
  const grad = pnode('radialGradient', { id: `pg${uid}`, cx: '0.42', cy: '0.30', r: '0.95' });
  grad.append(pnode('stop', { offset: '0', 'stop-color': bgTop }));
  grad.append(pnode('stop', { offset: '1', 'stop-color': bgBot }));
  defs.append(grad);
  svg.append(defs);
  svg.append(pnode('rect', { x: 0, y: 0, width: 100, height: 100, fill: `url(#pg${uid})` }));

  const add = (tag, attrs, parent) => { const n = pnode(tag, attrs); (parent || svg).append(n); return n; };
  const path = (d, fill, parent, extra) => add('path', Object.assign({ d, fill }, extra || {}), parent);

  // Layer groups, back → front.
  const back = add('g', { class: 'bust-back' });   // halo, back hair, hood/antler backs
  const body = add('g', { class: 'bust-body' });    // garment + shoulders (>=1 path)
  const face = add('g', { class: 'bust-face' });    // neck, head, features
  const emblem = add('g', { class: 'crest-emblem' }); // headwear + class prop (smoke needs this)

  // ── Shoulders / garment (path #1) ─────────────────────────────────────────
  const bareShoulders = cls === 'barbarian';
  const shoulderFill = bareShoulders ? skin : garment;
  path('M2 100 C2 79 19 69 50 69 C81 69 98 79 98 100 Z', shoulderFill, body);
  // A little chest shading + a collar to give the garment form (path #2).
  path('M50 69 C34 69 20 74 14 84 C24 77 37 74 50 74 C63 74 76 77 86 84 C80 74 66 69 50 69 Z', garmentDk, body, { opacity: bareShoulders ? 0.35 : 0.7 });

  // ── Neck (behind the jaw) ─────────────────────────────────────────────────
  path('M43 54 L57 54 L58.5 71 L41.5 71 Z', skinDk, face);
  add('path', { d: 'M43 54 L57 54 L57.6 61 L42.4 61 Z', fill: skin, opacity: 0.6 }, face);

  // ── Back hair (behind head), unless a helm/hood/hat will hide it ───────────
  const helm = cls === 'fighter' || cls === 'paladin';
  const hooded = cls === 'rogue' || cls === 'ranger' || cls === 'warlock';
  const hatted = cls === 'wizard';
  const bald = cls === 'monk';
  const showHair = !helm && !hatted && !bald;
  if (showHair && !hooded) {
    add('ellipse', { cx: HCX, cy: HCY - 1, rx: HRX + 2.5, ry: HRY + 2, fill: hairDk }, back);
    if (hairStyle === 'long') path('M31 40 C27 60 30 74 34 80 L40 78 C36 66 36 52 38 44 Z M69 40 C73 60 70 74 66 80 L60 78 C64 66 64 52 62 44 Z', hairDk, back);
  }

  // ── Head + ears ───────────────────────────────────────────────────────────
  add('ellipse', { cx: 35.5, cy: 46, rx: 3, ry: 3.6, fill: skinDk }, face);
  add('ellipse', { cx: 64.5, cy: 46, rx: 3, ry: 3.6, fill: skinDk }, face);
  add('ellipse', { cx: HCX, cy: HCY, rx: HRX, ry: HRY, fill: skin }, face);
  // Soft cheek/jaw shading down one side (adds depth + a path).
  path('M50 26 C42 26 36 33 35.6 44 C35.2 54 41 60 50 60.5 C46 55 44 48 44.5 40 C45 33 47 29 50 26 Z', skinDk, face, { opacity: 0.28 });

  // ── Face features ─────────────────────────────────────────────────────────
  const glowEyes = cls === 'sorcerer' || cls === 'warlock';
  const shadowBand = hooded || cls === 'rogue';
  if (shadowBand) add('rect', { x: 33, y: 40, width: 34, height: 8.5, rx: 4, fill: '#05060a', opacity: 0.62 }, face);
  // Brows
  add('path', { d: `M39.5 41 Q43.4 39 47 41`, fill: 'none', stroke: hairDk, 'stroke-width': 1.4, 'stroke-linecap': 'round' }, face);
  add('path', { d: `M53 41 Q56.6 39 60.5 41`, fill: 'none', stroke: hairDk, 'stroke-width': 1.4, 'stroke-linecap': 'round' }, face);
  // Eyes
  const eyeCol = glowEyes ? accent : '#241a12';
  if (glowEyes) {
    add('circle', { cx: EYE_L, cy: EYE_Y, r: 4.4, fill: accent, opacity: 0.28 }, face);
    add('circle', { cx: EYE_R, cy: EYE_Y, r: 4.4, fill: accent, opacity: 0.28 }, face);
  }
  add('ellipse', { cx: EYE_L, cy: EYE_Y, rx: 1.9, ry: 2.2, fill: eyeCol }, face);
  add('ellipse', { cx: EYE_R, cy: EYE_Y, rx: 1.9, ry: 2.2, fill: eyeCol }, face);
  if (glowEyes) {
    add('circle', { cx: EYE_L, cy: EYE_Y - 0.4, r: 0.8, fill: '#fff', opacity: 0.85 }, face);
    add('circle', { cx: EYE_R, cy: EYE_Y - 0.4, r: 0.8, fill: '#fff', opacity: 0.85 }, face);
  }
  // Nose + mouth (subtle)
  add('path', { d: `M50 46 L48.6 51 Q50 52.2 51.4 51`, fill: 'none', stroke: skinDk, 'stroke-width': 1, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, face);
  add('path', { d: `M46 55.5 Q50 57.5 54 55.5`, fill: 'none', stroke: skinDk, 'stroke-width': 1.2, 'stroke-linecap': 'round' }, face);

  // War paint (barbarian): two bold stripes across the eyes.
  if (cls === 'barbarian') {
    const paint = hsl(cfg.g[0] + 4, 60, 34);
    add('rect', { x: 40.5, y: 38, width: 3.2, height: 15, rx: 1.4, fill: paint, opacity: 0.8 }, face);
    add('rect', { x: 56.3, y: 38, width: 3.2, height: 15, rx: 1.4, fill: paint, opacity: 0.8 }, face);
  }
  // Forehead mark (monk).
  if (bald) add('circle', { cx: HCX, cy: 33, r: 1.7, fill: accent }, face);

  // ── Front hair fringe (framing the face) ──────────────────────────────────
  if (showHair && !hooded) {
    if (hairStyle === 'wild' || cls === 'sorcerer') {
      path('M33 40 L30 24 L37 33 L40 20 L44 32 L50 19 L56 32 L60 20 L63 33 L70 24 L67 40 Q50 30 33 40 Z', hair, face);
    } else if (hairStyle === 'topknot') {
      add('ellipse', { cx: HCX, cy: 24, rx: 4.5, ry: 5, fill: hair }, face);
      path('M35 39 Q50 27 65 39 Q58 33 50 33 Q42 33 35 39 Z', hair, face);
    } else {
      path('M34 41 Q34 25 50 24 Q66 25 66 41 Q64 31 50 31 Q36 31 34 41 Z', hair, face);
    }
  }

  // ── Class-defining headwear + prop (the "emblem") ─────────────────────────
  drawClassFeatures(cls, { add, path, emblem, back, body, face, accent, garment, garmentDk, garmentLt, hair, hairDk, skin, skinDk, rng });

  return svg;
}

/** Draws the recognizable per-class silhouette: headwear, props, chest sigils. */
function drawClassFeatures(cls, C) {
  const { add, path, emblem, back, body, accent } = C;
  const metalHi = '#e9eef4', metalMid = '#aab6c4', metalDk = '#5e6b7a';

  switch (cls) {
    case 'wizard': {
      // Long beard flowing over the collar.
      path('M40 52 Q41 74 50 86 Q59 74 60 52 Q55 62 50 62 Q45 62 40 52 Z', C.hair, C.face);
      // Tall pointed, slightly drooping starry hat.
      path('M28 34 Q30 33 32 33 L57 6 Q56 22 50 33 Q40 34 28 34 Z', C.garment, emblem);
      path('M26 33 Q50 27 74 35 Q74 40 68 40 Q50 35 32 40 Q26 40 26 33 Z', C.garmentDk, emblem);
      for (const s of [[41, 24, 2.2], [50, 16, 1.6], [37, 30, 1.4]]) add('polygon', { points: starPoints(s[0], s[1], s[2], s[2] * 0.42, 5, 0), fill: accent }, emblem);
      break;
    }
    case 'sorcerer': {
      // Ember motes drifting around wild hair; eyes already glow.
      for (const m of [[26, 30, 1.5], [74, 34, 1.3], [30, 52, 1.1], [70, 55, 1.4], [22, 44, 1]]) {
        add('circle', { cx: m[0], cy: m[1], r: m[2] + 0.8, fill: accent, opacity: 0.25 }, back);
        add('circle', { cx: m[0], cy: m[1], r: m[2], fill: accent, opacity: 0.9 }, emblem);
      }
      break;
    }
    case 'warlock': {
      // Dark hood + a floating eldritch eye sigil above the brow.
      hood(C, C.garmentDk, C.garment);
      const eye = accent;
      add('ellipse', { cx: 50, cy: 20, rx: 6.5, ry: 3.6, fill: 'none', stroke: eye, 'stroke-width': 1.4 }, emblem);
      add('circle', { cx: 50, cy: 20, r: 2, fill: eye }, emblem);
      for (let i = 0; i < 6; i++) { const a = (Math.PI * i) / 3; add('line', { x1: 50 + 7 * Math.cos(a), y1: 20 + 4 * Math.sin(a), x2: 50 + 9.5 * Math.cos(a), y2: 20 + 5.6 * Math.sin(a), stroke: eye, 'stroke-width': 1, 'stroke-linecap': 'round', opacity: 0.8 }, emblem); }
      break;
    }
    case 'rogue': {
      hood(C, C.garmentDk, C.garment);
      break;
    }
    case 'ranger': {
      hood(C, C.garment, C.garmentLt);
      // A feather tucked at the side of the hood.
      const g = add('g', { transform: 'rotate(24 70 26)' }, emblem);
      add('path', { d: 'M70 12 Q76 22 72 34 Q68 24 70 12 Z', fill: accent }, g);
      add('line', { x1: 71, y1: 15, x2: 71, y2: 33, stroke: C.garmentDk, 'stroke-width': 0.8 }, g);
      break;
    }
    case 'fighter': {
      helmet(C, metalHi, metalMid, metalDk);
      pauldrons(C, metalMid, metalDk);
      break;
    }
    case 'paladin': {
      helmet(C, metalHi, accent, metalDk);
      // Side wings on the helm.
      for (const s of [-1, 1]) {
        const cx = 50 + s * 15;
        add('path', { d: `M${cx} 26 q${s * 12} -3 ${s * 16} 4 q${-s * 8} -1 ${-s * 14} 3 q${s * 6} -4 ${-s * 2} -10 Z`, fill: accent, stroke: metalDk, 'stroke-width': 0.6 }, emblem);
      }
      // Tabard stripe with a cross on the chest.
      add('rect', { x: 45, y: 70, width: 10, height: 30, fill: C.garmentLt }, emblem);
      add('rect', { x: 48.4, y: 78, width: 3.2, height: 12, fill: accent }, emblem);
      add('rect', { x: 46, y: 82, width: 8, height: 3, fill: accent }, emblem);
      break;
    }
    case 'barbarian': {
      // Fur circlet with two curved horns.
      path('M33 37 Q50 27 67 37 Q64 31 50 31 Q36 31 33 37 Z', hsl(26, 34, 26), emblem);
      for (const s of [-1, 1]) add('path', { d: `M${50 + s * 13} 33 Q${50 + s * 26} 26 ${50 + s * 24} 10 Q${50 + s * 30} 24 ${50 + s * 15} 37 Z`, fill: accent, stroke: '#00000040', 'stroke-width': 0.6 }, emblem);
      break;
    }
    case 'cleric': {
      // Radiant halo behind the head + a sun holy-symbol at the chest.
      add('ellipse', { cx: 50, cy: 30, rx: 20, ry: 8, fill: 'none', stroke: accent, 'stroke-width': 2, opacity: 0.5 }, back);
      add('ellipse', { cx: 50, cy: 30, rx: 20, ry: 8, fill: 'none', stroke: accent, 'stroke-width': 0.8 }, back);
      sunSymbol(C, 50, 84, accent);
      break;
    }
    case 'druid': {
      // Branching antlers + a couple of leaves at the brow, earthy.
      for (const s of [-1, 1]) {
        const x0 = 50 + s * 8;
        add('path', { d: `M${x0} 30 Q${x0 + s * 6} 16 ${x0 + s * 4} 6 M${x0 + s * 3} 20 q${s * 7} -2 ${s * 9} -6 M${x0 + s * 4.5} 12 q${s * 6} -1 ${s * 8} -5`, fill: 'none', stroke: accent, 'stroke-width': 1.8, 'stroke-linecap': 'round' }, emblem);
      }
      add('path', { d: 'M40 33 Q34 30 32 24 Q40 26 42 32 Z', fill: hsl(96, 40, 40) }, emblem);
      add('path', { d: 'M60 33 Q66 30 68 24 Q60 26 58 32 Z', fill: hsl(96, 40, 40) }, emblem);
      break;
    }
    case 'monk': {
      // Wrapped shoulder sash across the bare-ish garment.
      add('path', { d: 'M18 96 L64 68 L72 74 L26 100 Z', fill: C.garmentLt, opacity: 0.9 }, emblem);
      add('path', { d: 'M18 96 L64 68 L66 71 L20 98 Z', fill: C.garmentDk, opacity: 0.5 }, emblem);
      break;
    }
    case 'bard': {
      // Jaunty feathered cap.
      path('M32 34 Q40 20 58 22 Q70 23 68 34 Q50 29 32 34 Z', C.garment, emblem);
      add('path', { d: 'M60 24 Q74 16 82 4 Q76 20 66 30 Q62 27 60 24 Z', fill: accent }, emblem);
      // Lute headstock + tuning pegs rising past the shoulder.
      const g = add('g', { transform: 'rotate(18 74 78)' }, emblem);
      add('rect', { x: 71, y: 60, width: 6, height: 34, rx: 2, fill: hsl(28, 44, 30) }, g);
      add('rect', { x: 69.5, y: 58, width: 9, height: 7, rx: 2, fill: hsl(28, 40, 22) }, g);
      for (const y of [61, 64]) for (const x of [67.5, 78.5]) add('circle', { cx: x, cy: y, r: 1.3, fill: accent }, g);
      break;
    }
    default: {
      // Neutral adventurer: a simple cloak clasp so there's always an emblem.
      add('circle', { cx: 50, cy: 76, r: 3.2, fill: accent, stroke: '#00000040', 'stroke-width': 0.6 }, emblem);
      add('circle', { cx: 50, cy: 76, r: 1.2, fill: C.garmentDk }, emblem);
    }
  }
}

/* ── Shared feature primitives ─────────────────────────────────────────────── */

/** A cowl hood framing the face: a back cowl + a front brim arch. */
function hood(C, fill, rim) {
  const { add, path, emblem, back } = C;
  add('path', { d: 'M24 62 Q20 24 50 18 Q80 24 76 62 Q70 40 50 38 Q30 40 24 62 Z', fill }, back);
  path('M28 50 Q26 22 50 17 Q74 22 72 50 Q64 33 50 33 Q36 33 28 50 Z', fill, emblem);
  add('path', { d: 'M32 46 Q31 25 50 21 Q69 25 68 46 Q60 35 50 35 Q40 35 32 46 Z', fill: 'none', stroke: rim, 'stroke-width': 0.8, opacity: 0.6 }, emblem);
}

/** A metal helm dome with brow ridge + nasal guard. */
function helmet(C, hi, mid, dk) {
  const { add, path, emblem } = C;
  const uid = ++PORTRAIT_UID;
  const grad = pnode('radialGradient', { id: `hg${uid}`, cx: '0.4', cy: '0.25', r: '0.9' });
  grad.append(pnode('stop', { offset: '0', 'stop-color': hi }));
  grad.append(pnode('stop', { offset: '1', 'stop-color': mid }));
  const defs = pnode('defs'); defs.append(grad); emblem.append(defs);
  path('M32 46 Q32 20 50 19 Q68 20 68 46 Q68 40 66 38 L34 38 Q32 40 32 46 Z', `url(#hg${uid})`, emblem, { stroke: dk, 'stroke-width': 0.8, 'stroke-linejoin': 'round' });
  add('rect', { x: 32, y: 39, width: 36, height: 3.2, fill: dk, opacity: 0.55 }, emblem); // brow band
  add('rect', { x: 48.4, y: 40, width: 3.2, height: 16, rx: 1.4, fill: mid, stroke: dk, 'stroke-width': 0.6 }, emblem); // nasal guard
  add('polygon', { points: starPoints(50, 15, 3, 1.2, 5, 0), fill: hi }, emblem); // small crest stud
}

/** Shoulder pauldrons over the garment. */
function pauldrons(C, mid, dk) {
  const { add } = C;
  for (const s of [-1, 1]) {
    const cx = 50 + s * 33;
    add('ellipse', { cx, cy: 82, rx: 15, ry: 11, fill: mid, stroke: dk, 'stroke-width': 0.8 }, C.emblem);
    add('ellipse', { cx, cy: 80, rx: 15, ry: 5, fill: '#ffffff', opacity: 0.18 }, C.emblem);
  }
}

/** A rayed sun holy-symbol at (cx,cy). */
function sunSymbol(C, cx, cy, col) {
  const { add } = C;
  for (let i = 0; i < 12; i++) { const a = (Math.PI * i) / 6; add('line', { x1: cx + 4.5 * Math.sin(a), y1: cy - 4.5 * Math.cos(a), x2: cx + 8 * Math.sin(a), y2: cy - 8 * Math.cos(a), stroke: col, 'stroke-width': 1.3, 'stroke-linecap': 'round' }, C.emblem); }
  add('circle', { cx, cy, r: 4, fill: col }, C.emblem);
  add('circle', { cx, cy, r: 2, fill: '#00000030' }, C.emblem);
}
