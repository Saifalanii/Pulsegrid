// Generates the PWA icon set as real PNG files, in code, with zero dependencies.
//
// Manifests can't reliably take data: URIs and installability wants actual PNGs, so
// rather than ship a binary asset I encode one here: signed-distance-field rendering
// into an RGBA buffer, then a hand-rolled PNG writer (Node's zlib does the deflate).
//
//   node tools/make-icons.mjs
//
// Re-run it after changing the mark. The output is deterministic.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------ PNG writer

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {Uint8Array} rgba length w*h*4 */
function encodePng(rgba, w, h) {
  const stride = w * 4;
  // Filter type 0 (None) per scanline. The image is smooth gradients, and deflate
  // handles it fine without the complexity of adaptive filtering.
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ SDFs

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const len = (x, y) => Math.sqrt(x * x + y * y);

function sdHexagon(px, py, r) {
  const kx = -0.866025404, ky = 0.5, kz = 0.577350269;
  let x = Math.abs(px), y = Math.abs(py);
  const d = 2 * Math.min(kx * x + ky * y, 0);
  x -= d * kx; y -= d * ky;
  x -= clamp(x, -kz * r, kz * r);
  y -= r;
  return len(x, y) * Math.sign(y);
}

function sdTriangle(px, py, r) {
  const k = Math.sqrt(3);
  let x = Math.abs(px) - r;
  let y = py + r / k;
  if (x + k * y > 0) {
    const nx = (x - k * y) / 2, ny = (-k * x - y) / 2;
    x = nx; y = ny;
  }
  x -= clamp(x, -2 * r, 0);
  return -len(x, y) * Math.sign(y);
}

/** Emissive band around an SDF isoline: bright core, exponential falloff. */
const band = (d, width, softness) => {
  const a = Math.max(0, 1 - Math.abs(d) / width);
  return a * a + Math.exp(-Math.abs(d) / softness) * 0.85;
};

// ------------------------------------------------------------------ render

const CYAN = [34, 224, 255];
const DEEP = [10, 120, 190];
const WHITE = [255, 255, 255];

/**
 * @param {number} size px
 * @param {number} inset 0..0.5 — extra padding for maskable icons, whose outer ~20%
 *                       can be cropped to a circle/squircle by the launcher.
 */
function renderIcon(size, inset = 0) {
  const buf = new Uint8Array(size * size * 4);
  const S = 4;                       // supersampling factor per axis
  const contentScale = 1 - inset * 2;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let R = 0, G = 0, B = 0;

      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          // Normalised coords in [-1, 1], with the mark shrunk by contentScale.
          const ux = ((px + (sx + 0.5) / S) / size * 2 - 1) / contentScale;
          const uy = ((py + (sy + 0.5) / S) / size * 2 - 1) / contentScale;
          const rad = len(ux, uy);

          // --- background: tinted void with a centre bloom ---
          let r = 4, g = 7, b = 13;
          const centreGlow = Math.exp(-rad * 2.1) * 0.55;
          r += DEEP[0] * centreGlow * 0.35;
          g += DEEP[1] * centreGlow * 0.35;
          b += DEEP[2] * centreGlow * 0.35;

          // --- grid ---
          const gridN = 5;
          const gx = Math.abs(((ux * gridN + 100) % 1) - 0.5);
          const gy = Math.abs(((uy * gridN + 100) % 1) - 0.5);
          const grid = Math.max(0, 1 - Math.min(gx, gy) * 22) * 0.16 * Math.exp(-rad * 1.3);
          r += CYAN[0] * grid * 0.35; g += CYAN[1] * grid * 0.35; b += CYAN[2] * grid * 0.35;

          // --- outer hexagon ring ---
          const dh = sdHexagon(ux, uy, 0.80);
          const ring = band(dh, 0.030, 0.055);
          r += CYAN[0] * ring; g += CYAN[1] * ring; b += CYAN[2] * ring;
          if (Math.abs(dh) < 0.012) { r += WHITE[0] * 0.9; g += WHITE[1] * 0.9; b += WHITE[2] * 0.9; }

          // --- inner hexagon, counter-scaled ---
          const dh2 = sdHexagon(ux, uy, 0.60);
          const ring2 = band(dh2, 0.012, 0.030) * 0.45;
          r += CYAN[0] * ring2 * 0.7; g += CYAN[1] * ring2 * 0.7; b += CYAN[2] * ring2 * 0.7;

          // --- player triangle (points up; the in-game hull) ---
          const dt = sdTriangle(ux, -uy, 0.40);
          if (dt < 0) {
            const core = Math.min(1, -dt * 7);
            r += 40 + WHITE[0] * core * 0.95;
            g += 60 + WHITE[1] * core * 0.95;
            b += 70 + WHITE[2] * core * 0.95;
          }
          const tri = band(dt, 0.022, 0.045);
          r += CYAN[0] * tri * 1.15; g += CYAN[1] * tri * 1.15; b += CYAN[2] * tri * 1.15;

          R += r; G += g; B += b;
        }
      }

      const n = S * S;
      const i = (py * size + px) * 4;
      // Reinhard-ish tone map keeps the additive stack from clipping to flat white.
      const tm = (v) => {
        const x = v / n / 255;
        return Math.round(clamp((x / (1 + x * 0.62)) * 255 * 1.28, 0, 255));
      };
      buf[i] = tm(R); buf[i + 1] = tm(G); buf[i + 2] = tm(B); buf[i + 3] = 255;
    }
  }
  return buf;
}

// ------------------------------------------------------------------ output

const targets = [
  { file: 'icon-192.png', size: 192, inset: 0.02 },
  { file: 'icon-512.png', size: 512, inset: 0.02 },
  { file: 'icon-180.png', size: 180, inset: 0.02 },   // apple-touch-icon
  { file: 'icon-maskable-192.png', size: 192, inset: 0.14 },
  { file: 'icon-maskable-512.png', size: 512, inset: 0.14 },
  { file: 'favicon-64.png', size: 64, inset: 0.0 },
];

for (const t of targets) {
  const rgba = renderIcon(t.size, t.inset);
  const png = encodePng(rgba, t.size, t.size);
  writeFileSync(join(OUT, t.file), png);
  console.log(`  ${t.file.padEnd(24)} ${t.size}x${t.size}  ${(png.length / 1024).toFixed(1)} KB`);
}
console.log('icons written to', OUT);
