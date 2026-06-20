// Zero-dependency PWA icon generator.
//
// Renders the TERMS app icon (indigo square + white "T" monogram) to PNG using
// only Node's built-in zlib — no sharp/ImageMagick needed. Regenerate with:
//   node scripts/generate-pwa-icons.mjs
//
// To use your real brand: replace the PNGs in public/icons/ with your own
// 192x192, 512x512 and a full-bleed 512x512 "maskable" version, then update
// public/manifest.webmanifest if filenames change.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(OUT, { recursive: true });

// ── Brand colours ──────────────────────────────────────────────────────────
const BG_TOP = [79, 70, 229];   // #4F46E5 indigo-600
const BG_BOT = [99, 102, 241];  // #6366F1 indigo-500
const FG = [255, 255, 255];     // white monogram

const lerp = (a, b, t) => Math.round(a + (b - a) * t);

// Render an RGBA pixel buffer for the icon.
// maskable = true → full-bleed background (no rounded corners / transparency),
// keeping the glyph inside the launcher "safe zone".
function render(size, maskable) {
  const buf = Buffer.alloc(size * size * 4);
  const r = size * 0.22;                 // corner radius (non-maskable)
  // "T" geometry (fraction of size) — sits within the central safe zone.
  const Lx = size * 0.30, Rx = size * 0.70;       // bar left/right
  const barT = size * 0.31, barB = size * 0.41;   // top horizontal bar
  const stemL = size * 0.44, stemR = size * 0.56; // vertical stem
  const stemB = size * 0.71;

  const inRoundedRect = (x, y) => {
    if (maskable) return true; // full bleed
    const minX = r, minY = r, maxX = size - r, maxY = size - r;
    let dx = 0, dy = 0;
    if (x < minX) dx = minX - x; else if (x > maxX) dx = x - maxX;
    if (y < minY) dy = minY - y; else if (y > maxY) dy = y - maxY;
    return dx * dx + dy * dy <= r * r;
  };
  const inT = (x, y) =>
    (x >= Lx && x <= Rx && y >= barT && y <= barB) ||      // horizontal bar
    (x >= stemL && x <= stemR && y >= barT && y <= stemB); // vertical stem

  for (let y = 0; y < size; y++) {
    const t = y / (size - 1);
    const bg = [lerp(BG_TOP[0], BG_BOT[0], t), lerp(BG_TOP[1], BG_BOT[1], t), lerp(BG_TOP[2], BG_BOT[2], t)];
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRoundedRect(x + 0.5, y + 0.5)) { buf[i + 3] = 0; continue; }
      const px = inT(x + 0.5, y + 0.5) ? FG : bg;
      buf[i] = px[0]; buf[i + 1] = px[1]; buf[i + 2] = px[2]; buf[i + 3] = 255;
    }
  }
  return buf;
}

// ── Minimal PNG encoder (RGBA, 8-bit, filter 0) ──────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b) => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const tc = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tc), 0);
  return Buffer.concat([len, tc, crc]);
};
function encodePNG(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const write = (name, size, maskable = false) => {
  writeFileSync(join(OUT, name), encodePNG(size, render(size, maskable)));
  console.log('wrote', name);
};

write('icon-192.png', 192);
write('icon-512.png', 512);
write('maskable-512.png', 512, true);
write('apple-touch-icon.png', 180);
write('favicon-32.png', 32);
console.log('done');
