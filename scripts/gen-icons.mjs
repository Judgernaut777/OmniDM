#!/usr/bin/env node
/**
 * OmniDM Icon Generator
 *
 * Rasterizes assets/icon.svg to PNG at various sizes for all platforms:
 * - Web favicon (32x32, 64x64)
 * - Tauri desktop (32x32, 128x128, 256x256, 512x512)
 * - Capacitor mobile (icon 192x192, 512x512)
 * - Electron (512x512)
 *
 * Uses headless Chromium (at /usr/bin/chromium) to render SVG → PNG.
 * No heavy dependencies; output is placed in platform-specific directories.
 *
 *   node scripts/gen-icons.mjs
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const sourceIcon = path.join(rootDir, 'assets', 'icon.svg');

/**
 * Rasterize an SVG to PNG using headless Chromium.
 */
function rasterizeSvg(svgPath, width, height) {
  const svgContent = readFileSync(svgPath, 'utf8');
  const dataUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgContent)}`;

  // Create a temporary HTML file
  const tmpDir = '/tmp';
  const htmlPath = path.join(tmpDir, `omnidm-icon-${randomBytes(4).toString('hex')}.html`);
  const outputPath = path.join(tmpDir, `omnidm-icon-${randomBytes(4).toString('hex')}.png`);

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; }
    body { width: ${width}px; height: ${height}px; }
    img { display: block; width: ${width}px; height: ${height}px; }
  </style>
</head>
<body>
  <img src="${dataUri}" alt="icon">
</body>
</html>`;

  writeFileSync(htmlPath, html);

  try {
    const result = spawnSync('/usr/bin/chromium', [
      '--headless=old',
      '--disable-gpu',
      '--run-all-compositor-stages-before-draw',
      `--window-size=${width},${height}`,
      `--screenshot=${outputPath}`,
      `file://${htmlPath}`,
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 30000,
    });

    if (result.status !== 0) {
      const errorMsg = result.stderr?.toString() || 'Unknown error';
      throw new Error(`Chromium failed: ${errorMsg}`);
    }

    // Read the screenshot
    let pngData;
    try {
      pngData = readFileSync(outputPath);
    } catch (e) {
      // Chromium may write to a default location
      const defaultPath = `${outputPath.replace(/\.\w+$/, '')}.png`;
      pngData = readFileSync(defaultPath);
      unlinkSync(defaultPath);
    }

    return pngData;
  } finally {
    // Clean up
    try { unlinkSync(htmlPath); } catch (e) {}
    try { unlinkSync(outputPath); } catch (e) {}
  }
}

/**
 * Ensure a directory exists.
 */
function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

/**
 * Write an icon file and log it.
 */
function writeIcon(outputPath, data) {
  ensureDir(path.dirname(outputPath));
  writeFileSync(outputPath, data);
  const relPath = path.relative(rootDir, outputPath);
  console.log(`  ✓ ${relPath}  (${data.length} bytes)`);
}

/**
 * Main: generate all icons.
 */
function main() {
  console.log('Generating OmniDM app icons from assets/icon.svg\n');

  const sizes = [32, 64, 128, 192, 256, 512];
  const iconCache = new Map();

  try {
    // Pre-generate all sizes
    console.log('Rasterizing SVG to PNG at required sizes...');
    for (const size of sizes) {
      console.log(`  Rendering ${size}x${size}...`);
      const data = rasterizeSvg(sourceIcon, size, size);
      iconCache.set(size, data);
    }

    console.log('\nWriting platform-specific icons...\n');

    // Tauri (desktop): 32x32, 128x128, 256x256, 512x512
    console.log('Tauri (Desktop):');
    const tauriDir = path.join(rootDir, 'src-tauri', 'icons');
    writeIcon(path.join(tauriDir, '32x32.png'), iconCache.get(32));
    writeIcon(path.join(tauriDir, '128x128.png'), iconCache.get(128));
    writeIcon(path.join(tauriDir, '128x128@2x.png'), iconCache.get(256));
    writeIcon(path.join(tauriDir, 'icon.png'), iconCache.get(512));

    // ICO and ICNS are binary containers best regenerated with Tauri CLI:
    //   npm run tauri icon src-tauri/icons/icon.png
    // For now, we'll note this in the output.

    // Capacitor (Mobile): icon templates
    console.log('\nCapacitor (Mobile):');
    const capIconDir = path.join(rootDir, 'capacitor');
    ensureDir(capIconDir);
    writeIcon(path.join(capIconDir, 'icon-192.png'), iconCache.get(192));
    writeIcon(path.join(capIconDir, 'icon-512.png'), iconCache.get(512));

    // Electron (Desktop): icon
    console.log('Electron (Desktop):');
    const electronDir = path.join(rootDir, 'electron');
    ensureDir(electronDir);
    writeIcon(path.join(electronDir, 'icon-512.png'), iconCache.get(512));

    // Web: favicon PNGs
    console.log('Web:');
    const webDir = path.join(rootDir, 'web');
    writeIcon(path.join(webDir, 'favicon-32.png'), iconCache.get(32));
    writeIcon(path.join(webDir, 'favicon-64.png'), iconCache.get(64));

    console.log('\nGenerated all platform icons successfully!');
    console.log('\nNext steps:');
    console.log('  1. Review the new icon across platforms');
    console.log('  2. Run: npm run typecheck && npm run smoke (to verify web integration)');
    console.log('  3. For Tauri ICO/ICNS regeneration, run: npm run tauri icon src-tauri/icons/icon.png');
    console.log('  4. Commit: git add assets/ && git commit -m "Add cohesive app icon system"');
  } catch (error) {
    console.error('Error generating icons:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
