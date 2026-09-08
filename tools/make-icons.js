/**
 * make-icons.js — Genera le icone PNG della PWA senza dipendenze esterne (encoder PNG minimale con zlib).
 *   node tools/make-icons.js
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'icons');

const BLU = [15, 76, 129], ARANCIO = [255, 109, 0], BIANCO = [255, 255, 255];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Disegna l'icona: quadrato blu arrotondato, griglia catastale, particella arancione, mirino. */
function drawIcon(size, { maskable = false } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const s = size, pad = maskable ? s * 0.1 : 0, r = maskable ? 0 : s * 0.19;
  const inRounded = (x, y) => {
    if (maskable) return true;
    const cx = Math.max(r, Math.min(s - r, x)), cy = Math.max(r, Math.min(s - r, y));
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const g0 = pad + s * 0.1875 * (1 - (pad * 2) / s), g1 = s - g0; // griglia
  const cell = (g1 - g0) / 4;
  const lw = Math.max(2, s * 0.012);
  const near = (v, target) => Math.abs(v - target) <= lw;
  const put = (i, c, a = 1) => { px[i] = Math.round(px[i] * (1 - a) + c[0] * a); px[i + 1] = Math.round(px[i + 1] * (1 - a) + c[1] * a); px[i + 2] = Math.round(px[i + 2] * (1 - a) + c[2] * a); px[i + 3] = 255; };
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const i = (y * s + x) * 4;
    if (!inRounded(x + 0.5, y + 0.5)) { px[i + 3] = 0; continue; }
    put(i, BLU);
    const inGrid = x >= g0 - lw && x <= g1 + lw && y >= g0 - lw && y <= g1 + lw;
    if (inGrid) {
      for (let k = 0; k <= 4; k++) if (near(x, g0 + k * cell) || near(y, g0 + k * cell)) put(i, BIANCO, 0.85);
    }
    // particella evidenziata (cella 2,2)
    const px0 = g0 + cell, py0 = g0 + cell;
    if (x >= px0 && x <= px0 + cell && y >= py0 && y <= py0 + cell) {
      const edge = x - px0 < lw * 1.6 || px0 + cell - x < lw * 1.6 || y - py0 < lw * 1.6 || py0 + cell - y < lw * 1.6;
      put(i, edge ? BIANCO : ARANCIO);
    }
    // mirino
    const mx = g0 + cell * 3.25, my = g0 + cell * 3.25, d = Math.hypot(x - mx, y - my);
    if (d <= cell * 0.34) put(i, BIANCO);
    if (d <= cell * 0.16) put(i, BLU);
  }
  return encodePng(s, s, px);
}

fs.mkdirSync(OUT, { recursive: true });
const jobs = [
  ['icon-192.png', 192, {}], ['icon-512.png', 512, {}], ['icon-maskable-512.png', 512, { maskable: true }], ['apple-touch-icon.png', 180, { maskable: true }]
];
for (const [name, size, opts] of jobs) {
  fs.writeFileSync(path.join(OUT, name), drawIcon(size, opts));
  console.log('creata', name);
}
