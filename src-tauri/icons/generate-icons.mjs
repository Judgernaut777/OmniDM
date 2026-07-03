/**
 * Dependency-free icon generator for the OmniDM desktop (Tauri) app.
 *
 *   node src-tauri/icons/generate-icons.mjs
 *
 * Emits the exact icon set Tauri's bundler + `tauri-build` expect
 * (32x32.png, 128x128.png, 128x128@2x.png, icon.png, icon.ico, icon.icns)
 * beside this file. Uses only Node's built-in zlib — no ImageMagick, no CDN.
 *
 * The art is a gold d20-style diamond crest on a dark-fantasy field, matching
 * the web client's 🎲 motif. On a machine with the Rust toolchain you can
 * instead regenerate a richer set from any square source PNG with:
 *   npm run tauri icon path/to/source.png
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

const BG = [0x1a, 0x14, 0x20, 0xff];      // deep arcane purple
const GOLD = [0xd8, 0xb4, 0x6b, 0xff];    // candle gold
const GOLD_DK = [0x8a, 0x6d, 0x2f, 0xff]; // shadowed gold

/** Render an RGBA buffer of a gold diamond crest on the dark field. */
function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const r = size * 0.42;      // diamond "radius" (Manhattan)
  const inner = size * 0.30;  // inner facet line
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.abs(x - cx) + Math.abs(y - cy); // Manhattan → diamond
      let c = BG;
      if (d <= r) {
        // Facet the diamond: darker gold on the lower half for a bit of depth.
        c = y > cy ? GOLD_DK : GOLD;
        // Thin inner outline to suggest the d20 silhouette.
        if (Math.abs(d - inner) < Math.max(1, size * 0.02)) c = BG;
      }
      const i = (y * size + x) * 4;
      buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = c[3];
    }
  }
  return buf;
}

// ── PNG encoding (color type 6, 8-bit RGBA) ──────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(size) {
  const rgba = render(size);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  // 10,11,12 = compression/filter/interlace = 0
  // Prefix every scanline with filter byte 0 (None).
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── ICO container wrapping a single PNG (Vista+ PNG-in-ICO) ──────────────────
function encodeIco(pngBySize) {
  const sizes = [16, 32, 48, 256];
  const entries = [];
  const images = [];
  let offset = 6 + sizes.length * 16;
  for (const s of sizes) {
    const png = pngBySize(s);
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s; // width  (0 means 256)
    e[1] = s >= 256 ? 0 : s; // height
    e[2] = 0;                // palette
    e[3] = 0;                // reserved
    e.writeUInt16LE(1, 4);   // color planes
    e.writeUInt16LE(32, 6);  // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    images.push(png);
    offset += png.length;
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(sizes.length, 4);
  return Buffer.concat([header, ...entries, ...images]);
}

// ── ICNS container wrapping PNGs (OS X 10.7+ PNG-in-ICNS) ─────────────────────
function encodeIcns(pngBySize) {
  // type → source pixel size
  const parts = [['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]];
  const chunks = [];
  for (const [type, s] of parts) {
    const png = pngBySize(s);
    const head = Buffer.alloc(8);
    Buffer.from(type, 'ascii').copy(head, 0);
    head.writeUInt32BE(png.length + 8, 4);
    chunks.push(head, png);
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  Buffer.from('icns', 'ascii').copy(header, 0);
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

// Cache PNGs per size (ico/icns reuse them).
const pngCache = new Map();
const png = (s) => {
  if (!pngCache.has(s)) pngCache.set(s, encodePng(s));
  return pngCache.get(s);
};

const out = (name, buf) => {
  writeFileSync(path.join(here, name), buf);
  console.log(`  ${name}  (${buf.length} bytes)`);
};

console.log('Generating OmniDM desktop icons:');
out('32x32.png', png(32));
out('128x128.png', png(128));
out('128x128@2x.png', png(256));
out('icon.png', png(512));
out('icon.ico', encodeIco(png));
out('icon.icns', encodeIcns(png));
console.log('Done.');
