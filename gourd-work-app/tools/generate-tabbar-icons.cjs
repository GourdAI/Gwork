/**
 * GWork tabBar 图标生成器（零依赖）
 * ------------------------------------------------------------
 * 输出 81x81 RGBA PNG，共 8 个：
 *   tasks / tasks-active / loop / loop-active
 *   discover / discover-active / mine / mine-active
 * 未选中：#9b9ba2 线性描边；选中：#141416 实心 + #fafafa 反白细节。
 * 参考：mobile/js/icons.js 的 tabTask / tabLoop / tabDiscover / tabMine 及其 Solid 变体。
 * 运行：node tools/generate-tabbar-icons.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.join(__dirname, '..', 'static', 'tabbar');
const SIZE = 81;
const GRAY = [0x9b, 0x9b, 0xa2];
const BLACK = [0x14, 0x14, 0x16];
const PAPER = [0xfa, 0xfa, 0xfa]; // tabBar 背景色，用作实心图标的反白细节

function canvas() {
  return new Uint8Array(SIZE * SIZE * 4); // 全 0 = 透明
}
function dot(buf, x, y, color, radius, alpha) {
  const r = radius;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r + 0.4) continue;
      const px = Math.round(x + dx);
      const py = Math.round(y + dy);
      if (px < 0 || py < 0 || px >= SIZE || py >= SIZE) continue;
      const i = (py * SIZE + px) * 4;
      buf[i] = color[0]; buf[i + 1] = color[1]; buf[i + 2] = color[2];
      buf[i + 3] = alpha === undefined ? 255 : alpha;
    }
  }
}
function line(buf, x0, y0, x1, y1, color, width) {
  const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    dot(buf, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, color, width / 2);
  }
}
function polyline(buf, pts, color, width) {
  for (let i = 1; i < pts.length; i++) line(buf, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], color, width);
}
function circleOutline(buf, cx, cy, r, color, width) {
  const steps = Math.ceil(2 * Math.PI * r * 2);
  for (let s = 0; s <= steps; s++) {
    const a = (s / steps) * 2 * Math.PI;
    dot(buf, cx + Math.cos(a) * r, cy + Math.sin(a) * r, color, width / 2);
  }
}
function fillCircle(buf, cx, cy, r, color) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r * r) dot(buf, x, y, color, 0);
    }
  }
}
function fillRoundRect(buf, x0, y0, x1, y1, r, color) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x < x0 + r ? x0 + r - x : (x > x1 - r ? x - (x1 - r) : 0);
      const dy = y < y0 + r ? y0 + r - y : (y > y1 - r ? y - (y1 - r) : 0);
      if (dx * dx + dy * dy <= r * r) dot(buf, x, y, color, 0);
    }
  }
}
function fillTriangle(buf, p0, p1, p2, color) {
  const minX = Math.floor(Math.min(p0[0], p1[0], p2[0]));
  const maxX = Math.ceil(Math.max(p0[0], p1[0], p2[0]));
  const minY = Math.floor(Math.min(p0[1], p1[1], p2[1]));
  const maxY = Math.ceil(Math.max(p0[1], p1[1], p2[1]));
  const sign = (a, b, c) => (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1]);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const p = [x, y];
      const d1 = sign(p, p0, p1), d2 = sign(p, p1, p2), d3 = sign(p, p2, p0);
      const neg = d1 < 0 || d2 < 0 || d3 < 0;
      const pos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(neg && pos)) dot(buf, x, y, color, 0);
    }
  }
}

/* ---------- 4 个图标形状 ---------- */
function drawTask(buf, active) {
  const ink = active ? BLACK : GRAY;
  const detail = active ? PAPER : GRAY;
  if (active) fillRoundRect(buf, 9, 17, 71, 59, 13, ink);
  else {
    // 圆角矩形描边（四边 + 四角）
    line(buf, 22, 17, 58, 17, ink, 4); line(buf, 22, 59, 58, 59, ink, 4);
    line(buf, 9, 30, 9, 46, ink, 4); line(buf, 71, 30, 71, 46, ink, 4);
    circleOutline(buf, 22, 30, 13, ink, 4); // 角弧（用整圆会被覆盖，下面用局部弧）
    // 重画四角弧（只保留圆弧在角上的部分：用近似的短折线）
    polyline(buf, [[9, 30], [10, 25], [14, 20], [22, 17]], ink, 4);
    polyline(buf, [[58, 17], [66, 20], [70, 25], [71, 30]], ink, 4);
    polyline(buf, [[9, 46], [10, 51], [14, 56], [22, 59]], ink, 4);
    polyline(buf, [[58, 59], [66, 56], [70, 51], [71, 46]], ink, 4);
  }
  // 气泡尾巴
  fillTriangle(buf, [24, 57], [24, 70], [37, 59], ink);
  // 内部细节：两短横 + 勾
  line(buf, 22, 31, 37, 31, detail, 4);
  polyline(buf, [[23, 44], [30, 50], [41, 38]], detail, 4);
}

function drawLoop(buf, active) {
  const ink = active ? BLACK : GRAY;
  const detail = active ? PAPER : GRAY;
  // 两个铃耳
  line(buf, 17, 14, 9, 7, ink, 5);
  line(buf, 63, 14, 71, 7, ink, 5);
  if (active) fillCircle(buf, 40, 43, 25, ink);
  else circleOutline(buf, 40, 43, 25, ink, 4.5);
  polyline(buf, [[28, 43], [37, 51], [53, 33]], detail, 5);
}

function drawDiscover(buf, active) {
  const ink = active ? BLACK : GRAY;
  const detail = active ? PAPER : GRAY;
  if (active) fillCircle(buf, 40, 40, 28, ink);
  else circleOutline(buf, 40, 40, 28, ink, 4.5);
  // 指南针指针：菱形
  const p0 = [54, 26], p1 = [45, 45], p2 = [26, 54], p3 = [35, 35];
  if (active) {
    fillTriangle(buf, p0, p1, p3, detail);
    fillTriangle(buf, p2, p1, p3, detail);
  } else {
    polyline(buf, [p0, p1, p2, p3, p0], detail, 4);
  }
}

function drawMine(buf, active) {
  const ink = active ? BLACK : GRAY;
  if (active) {
    fillCircle(buf, 40, 27, 14, ink);
    // 肩部：梯形 + 圆角底
    fillRoundRect(buf, 16, 48, 64, 70, 14, ink);
    fillTriangle(buf, [16, 60], [40, 41], [64, 60], ink);
    fillRoundRect(buf, 16, 60, 64, 70, 10, ink);
  } else {
    circleOutline(buf, 40, 27, 14, ink, 4.5);
    // 肩部弧线
    polyline(buf, [[16, 66], [17, 58], [23, 51], [31, 47], [49, 47], [57, 51], [63, 58], [64, 66]], ink, 4.5);
  }
}

/* ---------- 最小 PNG 编码器 ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
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
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(rgba) {
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const icons = [
  ['tasks', drawTask], ['loop', drawLoop], ['discover', drawDiscover], ['mine', drawMine]
];
for (const [name, draw] of icons) {
  for (const active of [false, true]) {
    const buf = canvas();
    draw(buf, active);
    const file = path.join(OUT_DIR, name + (active ? '-active' : '') + '.png');
    fs.writeFileSync(file, encodePng(buf));
    console.log('generated', path.relative(path.join(__dirname, '..'), file), fs.statSync(file).size + ' bytes');
  }
}
