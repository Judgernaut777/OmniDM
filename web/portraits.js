/* OmniDM procedural portraits — shared client helper for heraldic crest-style
 * avatars. Loaded BEFORE app.js (see index.html) so both share PORTRAIT_PRESETS
 * and portraitSVG(). Plain classic script, no build step, no external origins.
 *
 * SECURITY: every crest is built with document.createElementNS + setAttribute —
 * never innerHTML. The only "untrusted" input is a seed string, which is used
 * solely as a hash source and (for presets) an object-key lookup, so a hostile
 * character name cannot inject markup. A preset id that isn't in the catalog
 * falls through to the deterministic hash path rather than trusting it.
 */
'use strict';

/* The fixed archetype catalog — mirrors src/core/portraits.ts. Each has its own
 * hue + class emblem so the eight presets are visually distinct. */
const PORTRAIT_PRESETS = ['fighter', 'mage', 'ranger', 'rogue', 'cleric', 'bard', 'barbarian', 'druid'];

const PRESET_META = {
  fighter:   { hue: 2,   emblem: 'swords' },
  mage:      { hue: 262, emblem: 'star' },
  ranger:    { hue: 138, emblem: 'arrow' },
  rogue:     { hue: 214, emblem: 'dagger' },
  cleric:    { hue: 46,  emblem: 'sun' },
  bard:      { hue: 322, emblem: 'note' },
  barbarian: { hue: 20,  emblem: 'axe' },
  druid:     { hue: 96,  emblem: 'leaf' },
};

/* The full sigil vocabulary — presets pick a fixed one, seeded crests pick by
 * hash so every distinct name gets a stable, recognizable emblem. */
const EMBLEMS = ['swords', 'star', 'arrow', 'dagger', 'sun', 'note', 'axe', 'leaf', 'tower', 'chalice', 'skull', 'flame'];
const DIVISIONS = ['plain', 'chief', 'pale', 'fess', 'bend', 'base'];

const PSVGNS = 'http://www.w3.org/2000/svg';
/* A heraldic shield outline in the 0..100 viewBox — flat top, point at bottom. */
const SHIELD = 'M16 16 H84 V48 C84 70 68 83 50 92 C32 83 16 70 16 48 Z';
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

/** Points string for an N-point star centered at (cx,cy). */
function starPoints(cx, cy, outer, inner, points, rot) {
  const out = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = rot + (Math.PI * i) / points;
    out.push(`${(cx + r * Math.sin(a)).toFixed(2)},${(cy - r * Math.cos(a)).toFixed(2)}`);
  }
  return out.join(' ');
}

/** A field division band (tinted), later clipped to the shield shape. */
function divisionShapes(kind, tint) {
  switch (kind) {
    case 'chief': return [pnode('rect', { x: 0, y: 0, width: 100, height: 34, fill: tint })];
    case 'base':  return [pnode('rect', { x: 0, y: 62, width: 100, height: 38, fill: tint })];
    case 'pale':  return [pnode('rect', { x: 0, y: 0, width: 50, height: 100, fill: tint })];
    case 'fess':  return [pnode('rect', { x: 0, y: 42, width: 100, height: 16, fill: tint })];
    case 'bend':  return [pnode('polygon', { points: '0,0 30,0 100,70 100,100 70,100 0,30', fill: tint })];
    default:      return [];
  }
}

/** The class sigil, drawn centered around (50,50) in the crest's field. */
function crestEmblem(key, light, dark) {
  const g = pnode('g', { class: 'crest-emblem' });
  const add = (n) => { g.append(n); return n; };
  const line = (x1, y1, x2, y2, w, col) =>
    add(pnode('line', { x1, y1, x2, y2, stroke: col || light, 'stroke-width': w || 3, 'stroke-linecap': 'round' }));
  const path = (d, fill, stroke, w) =>
    add(pnode('path', { d, fill: fill === undefined ? light : fill, ...(stroke ? { stroke, 'stroke-width': w || 1.4, 'stroke-linejoin': 'round' } : {}) }));

  switch (key) {
    case 'swords':
      for (const rot of [34, -34]) {
        const s = pnode('g', { transform: `rotate(${rot} 50 50)` });
        s.append(pnode('rect', { x: 48.4, y: 24, width: 3.2, height: 40, rx: 1.4, fill: light, stroke: dark, 'stroke-width': 1 }));
        s.append(pnode('rect', { x: 43, y: 58, width: 14, height: 3, rx: 1.5, fill: light }));
        s.append(pnode('circle', { cx: 50, cy: 69, r: 2.6, fill: light, stroke: dark, 'stroke-width': 1 }));
        g.append(s);
      }
      break;
    case 'star':
      add(pnode('polygon', { points: starPoints(50, 50, 22, 9, 5, 0), fill: light, stroke: dark, 'stroke-width': 1.4, 'stroke-linejoin': 'round' }));
      break;
    case 'arrow':
      line(50, 30, 50, 72, 3, light);
      path('M50 23 L44 38 L56 38 Z', light, dark, 1);
      line(50, 68, 44, 74, 2.4, light);
      line(50, 68, 56, 74, 2.4, light);
      break;
    case 'dagger':
      path('M50 23 L54.5 58 L45.5 58 Z', light, dark, 1);
      add(pnode('rect', { x: 41, y: 58, width: 18, height: 3.2, rx: 1.5, fill: light }));
      add(pnode('rect', { x: 47.5, y: 61, width: 5, height: 11, rx: 1.5, fill: light, stroke: dark, 'stroke-width': 1 }));
      add(pnode('circle', { cx: 50, cy: 74, r: 2.6, fill: light }));
      break;
    case 'sun':
      for (let i = 0; i < 12; i++) {
        const a = (Math.PI * i) / 6;
        line(50 + 11 * Math.sin(a), 50 - 11 * Math.cos(a), 50 + 20 * Math.sin(a), 50 - 20 * Math.cos(a), 2.4, light);
      }
      add(pnode('circle', { cx: 50, cy: 50, r: 9, fill: light, stroke: dark, 'stroke-width': 1.4 }));
      break;
    case 'note':
      add(pnode('line', { x1: 44, y1: 62, x2: 44, y2: 32, stroke: light, 'stroke-width': 2.6, 'stroke-linecap': 'round' }));
      add(pnode('line', { x1: 64, y1: 56, x2: 64, y2: 28, stroke: light, 'stroke-width': 2.6, 'stroke-linecap': 'round' }));
      add(pnode('line', { x1: 44, y1: 32, x2: 64, y2: 28, stroke: light, 'stroke-width': 4, 'stroke-linecap': 'round' }));
      add(pnode('ellipse', { cx: 40, cy: 63, rx: 6, ry: 4.6, fill: light, stroke: dark, 'stroke-width': 1, transform: 'rotate(-22 40 63)' }));
      add(pnode('ellipse', { cx: 60, cy: 57, rx: 6, ry: 4.6, fill: light, stroke: dark, 'stroke-width': 1, transform: 'rotate(-22 60 57)' }));
      break;
    case 'axe':
      add(pnode('rect', { x: 48.6, y: 26, width: 2.8, height: 48, rx: 1.2, fill: light }));
      path('M51 30 Q70 29 73 43 Q70 47 51 45 Z', light, dark, 1);
      path('M49 30 Q30 29 27 43 Q30 47 49 45 Z', light, dark, 1);
      break;
    case 'leaf':
      path('M50 24 C64 38 64 60 50 76 C36 60 36 38 50 24 Z', light, dark, 1.4);
      line(50, 30, 50, 72, 1.4, dark);
      line(50, 44, 41, 40, 1, dark);
      line(50, 44, 59, 40, 1, dark);
      line(50, 56, 41, 52, 1, dark);
      line(50, 56, 59, 52, 1, dark);
      break;
    case 'tower':
      add(pnode('rect', { x: 38, y: 42, width: 24, height: 34, fill: light, stroke: dark, 'stroke-width': 1.2 }));
      for (const x of [38, 48, 58]) add(pnode('rect', { x, y: 34, width: 6, height: 9, fill: light, stroke: dark, 'stroke-width': 1 }));
      add(pnode('rect', { x: 46, y: 60, width: 8, height: 16, rx: 4, fill: dark }));
      break;
    case 'chalice':
      path('M38 36 L62 36 Q60 55 50 58 Q40 55 38 36 Z', light, dark, 1.2);
      add(pnode('rect', { x: 48.5, y: 58, width: 3, height: 10, fill: light }));
      add(pnode('rect', { x: 41, y: 68, width: 18, height: 3.4, rx: 1.6, fill: light, stroke: dark, 'stroke-width': 1 }));
      break;
    case 'skull':
      add(pnode('path', { d: 'M36 44 A14 14 0 0 1 64 44 L64 56 Q64 60 60 60 L40 60 Q36 60 36 56 Z', fill: light, stroke: dark, 'stroke-width': 1.2 }));
      add(pnode('rect', { x: 42, y: 60, width: 16, height: 8, rx: 2, fill: light, stroke: dark, 'stroke-width': 1 }));
      add(pnode('circle', { cx: 44, cy: 47, r: 3.4, fill: dark }));
      add(pnode('circle', { cx: 56, cy: 47, r: 3.4, fill: dark }));
      add(pnode('path', { d: 'M50 51 L47 57 L53 57 Z', fill: dark }));
      break;
    case 'flame':
      path('M50 24 C58 36 56 44 53 50 C60 48 60 40 60 40 C66 52 60 72 50 76 C40 72 34 54 42 44 C43 50 46 50 47 48 C44 40 47 32 50 24 Z', light, dark, 1.2);
      break;
    default:
      add(pnode('polygon', { points: starPoints(50, 50, 22, 9, 5, 0), fill: light, stroke: dark, 'stroke-width': 1.4 }));
  }
  return g;
}

/**
 * Build a heraldic crest <svg> for `seed`. When `opts.preset` (or the seed
 * itself) is one of PORTRAIT_PRESETS, the archetype's fixed hue + emblem win;
 * otherwise the hue, sigil, and field division are derived deterministically
 * from the seed, so the same name always renders the same crest.
 */
function portraitSVG(seed, opts) {
  opts = opts || {};
  const presetId = opts.preset && PRESET_META[opts.preset]
    ? opts.preset
    : (typeof seed === 'string' && PRESET_META[seed] ? seed : '');
  const seedStr = String(seed == null ? '' : seed) || presetId || 'anon';
  const h = phash(`${seedStr}|${presetId}`);
  const meta = presetId ? PRESET_META[presetId] : null;

  const hue = meta ? meta.hue : h % 360;
  const emblemKey = meta ? meta.emblem : EMBLEMS[h % EMBLEMS.length];
  const division = DIVISIONS[(h >>> 8) % DIVISIONS.length];
  const uid = ++PORTRAIT_UID;

  const light = `hsl(${hue} 60% 84%)`;
  const dark = `hsl(${hue} 45% 16%)`;
  const fieldHi = `hsl(${hue} 52% 42%)`;
  const fieldLo = `hsl(${hue} 50% 20%)`;
  const tint = `hsl(${(hue + 40) % 360} 42% 30%)`;

  const svg = pnode('svg', { viewBox: '0 0 100 100', class: 'crest', 'aria-hidden': 'true', preserveAspectRatio: 'xMidYMid meet' });

  const defs = pnode('defs');
  const grad = pnode('radialGradient', { id: `cg${uid}`, cx: '0.5', cy: '0.32', r: '0.9' });
  grad.append(pnode('stop', { offset: '0', 'stop-color': fieldHi }));
  grad.append(pnode('stop', { offset: '1', 'stop-color': fieldLo }));
  defs.append(grad);
  const clip = pnode('clipPath', { id: `cc${uid}` });
  clip.append(pnode('path', { d: SHIELD }));
  defs.append(clip);
  svg.append(defs);

  // Field, then the (clipped) division band, then the emblem, then the gilt rim.
  svg.append(pnode('path', { d: SHIELD, fill: `url(#cg${uid})` }));
  const shapes = divisionShapes(division, tint);
  if (shapes.length) {
    const divg = pnode('g', { 'clip-path': `url(#cc${uid})` });
    for (const s of shapes) divg.append(s);
    svg.append(divg);
  }
  svg.append(crestEmblem(emblemKey, light, dark));
  svg.append(pnode('path', { d: SHIELD, fill: 'none', stroke: '#e3ba66', 'stroke-width': 3, 'stroke-linejoin': 'round' }));
  svg.append(pnode('path', { d: SHIELD, fill: 'none', stroke: '#00000055', 'stroke-width': 1, 'stroke-linejoin': 'round' }));
  return svg;
}
