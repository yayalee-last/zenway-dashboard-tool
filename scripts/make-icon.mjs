#!/usr/bin/env node
/**
 * 生成应用图标（纯 Node 实现，不依赖任何图形库）
 *
 * 用法：node scripts/make-icon.mjs
 * 产出：assets/icon.png（256×256）—— 窗口/任务栏图标
 *       assets/icon.ico（16~256 多尺寸）—— 打包后 exe 的文件图标
 *
 * 做法：4 倍超采样绘制 → 盒式降采样得到抗锯齿边缘 → 手写 PNG / ICO 编码。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT_DIR = path.join(ROOT, 'assets');

const LOGICAL = 256; // 设计尺寸
const SS = 4; // 超采样倍数
const N = LOGICAL * SS;

/* ---------------- 基础几何 ---------------- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const hex = (h) => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
];

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/* ---------------- 绘制到高分缓冲 ---------------- */

const BG_TOP = hex('#2a3040');
const BG_BOT = hex('#14161b');
const ACCENT = hex('#e8a33d');
const LINE = hex('#d8dce6');
const DIM = hex('#6b7280');

const buf = new Float32Array(N * N * 4); // 非预乘 RGBA

function blend(idx, r, g, b, a) {
  if (a <= 0) return;
  const o = idx * 4;
  const da = buf[o + 3];
  const oa = a + da * (1 - a);
  if (oa <= 0) return;
  buf[o] = (r * a + buf[o] * da * (1 - a)) / oa;
  buf[o + 1] = (g * a + buf[o + 1] * da * (1 - a)) / oa;
  buf[o + 2] = (b * a + buf[o + 2] * da * (1 - a)) / oa;
  buf[o + 3] = oa;
}

const s = 1 / SS; // 子采样 → 逻辑坐标

for (let py = 0; py < N; py++) {
  const y = (py + 0.5) * s;
  for (let px = 0; px < N; px++) {
    const x = (px + 0.5) * s;
    const idx = py * N + px;

    // 背景：圆角方块 + 纵向渐变
    if (inRoundRect(x, y, 8, 8, LOGICAL - 8, LOGICAL - 8, 54)) {
      const t = clamp01((y - 8) / (LOGICAL - 16));
      blend(
        idx,
        BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t,
        BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t,
        BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t,
        1
      );
    }

    // 左侧强调竖条
    if (inRoundRect(x, y, 44, 46, 54, 210, 5)) blend(idx, ACCENT[0], ACCENT[1], ACCENT[2], 1);

    // 三条任务行：状态点 + 文本条
    for (const row of [
      { cy: 82, dot: ACCENT, w: 118, solid: true },
      { cy: 128, dot: DIM, w: 142, solid: false },
      { cy: 174, dot: DIM, w: 96, solid: false },
    ]) {
      const alpha = row.solid ? 1 : 0.55;
      if (inCircle(x, y, 80, row.cy, 11)) blend(idx, row.dot[0], row.dot[1], row.dot[2], alpha);
      if (inRoundRect(x, y, 106, row.cy - 7, 106 + row.w, row.cy + 7, 7)) {
        blend(idx, LINE[0], LINE[1], LINE[2], alpha * 0.9);
      }
    }
  }
}

/* ---------------- 降采样到目标尺寸 ---------------- */

function render(size) {
  const out = Buffer.alloc(size * size * 4);
  const step = N / size;
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * step);
    const y1 = Math.min(N, Math.floor((y + 1) * step));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * step);
      const x1 = Math.min(N, Math.floor((x + 1) * step));
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        cnt = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const o = (sy * N + sx) * 4;
          const aa = buf[o + 3];
          r += buf[o] * aa;
          g += buf[o + 1] * aa;
          b += buf[o + 2] * aa;
          a += aa;
          cnt++;
        }
      }
      const dst = (y * size + x) * 4;
      if (a > 0) {
        out[dst] = Math.round((r / a) * 255);
        out[dst + 1] = Math.round((g / a) * 255);
        out[dst + 2] = Math.round((b / a) * 255);
      }
      out[dst + 3] = cnt ? Math.round((a / cnt) * 255) : 0;
    }
  }
  return out;
}

/* ---------------- PNG 编码 ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function toPng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- ICO 编码（内嵌 PNG，Vista+ 支持） ---------------- */

function toIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dirs = [];
  let offset = 6 + entries.length * 16;
  for (const { size, png } of entries) {
    const d = Buffer.alloc(16);
    d[0] = size >= 256 ? 0 : size;
    d[1] = size >= 256 ? 0 : size;
    d[2] = 0; // palette
    d[3] = 0; // reserved
    d.writeUInt16LE(1, 4); // planes
    d.writeUInt16LE(32, 6); // bpp
    d.writeUInt32LE(png.length, 8);
    d.writeUInt32LE(offset, 12);
    dirs.push(d);
    offset += png.length;
  }

  return Buffer.concat([header, ...dirs, ...entries.map((e) => e.png)]);
}

/* ---------------- 输出 ---------------- */

fs.mkdirSync(OUT_DIR, { recursive: true });

const PNG_SIZE = 256;
const png = toPng(render(PNG_SIZE), PNG_SIZE);
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png);
console.log(`icon.png -> ${(png.length / 1024).toFixed(1)} KB  (${PNG_SIZE}×${PNG_SIZE})`);

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const entries = ICO_SIZES.map((size) => ({ size, png: toPng(render(size), size) }));
const ico = toIco(entries);
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);
console.log(`icon.ico -> ${(ico.length / 1024).toFixed(1)} KB  (${ICO_SIZES.join('/')})`);
