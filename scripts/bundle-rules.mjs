/**
 * Regenerate src/core/rules/dnd5e.system.ts from src/rules/dnd5e/system.md.
 *
 * The narrator reads rules text through a browser-safe registry (no node:fs),
 * so the human-editable markdown is embedded as a string module. Smoke asserts
 * the two are byte-identical; run this after editing the markdown to keep them
 * in sync.
 *
 *   node scripts/bundle-rules.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mdPath = path.join(root, 'src/rules/dnd5e/system.md');
const outPath = path.join(root, 'src/core/rules/dnd5e.system.ts');

const md = readFileSync(mdPath, 'utf8');
const literal = JSON.stringify(md);

const out = `/**
 * Bundled rules content for the D&D 5e system module.
 *
 * This is the BROWSER-SAFE form of rules/dnd5e/system.md: the string is embedded
 * so the narrator can read it WITHOUT node:fs, letting the engine run in a
 * WebView. The on-disk markdown (src/rules/dnd5e/system.md) stays the human-
 * editable source of truth; smoke asserts the two are byte-identical so they
 * cannot drift. Regenerate with: node scripts/bundle-rules.mjs (see below) or by
 * hand-copying the markdown.
 */
export const DND5E_SYSTEM = ${literal};
`;

writeFileSync(outPath, out);
console.log(`bundled ${md.length} chars of rules markdown → ${path.relative(root, outPath)}`);
