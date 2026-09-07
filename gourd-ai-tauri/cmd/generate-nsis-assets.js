/**
 * generate-nsis-assets.js —— 生成 NSIS 安装器所需的品牌位图。
 *
 * 背景：tauri.conf.json 的 nsis.headerImage / nsis.sidebarImage 会被写入
 *      installer.nsi 的 MUI_HEADERIMAGE_BITMAP / MUI_WELCOMEFINISHPAGE_BITMAP。
 *      MUI2 的这两个槽位只接受 **BMP**（PNG 会让 makensis 报错），且不支持
 *      alpha 通道，透明像素必须先合成到不透明底色上，否则会渲染成黑块。
 *
 * 因此这里从 src-tauri/icons/icon.png（512x512 RGBA）离线合成：
 *   - header.bmp   150x57  ：右上角条幅，图标居中于右侧（MUI 默认 header 图靠右显示）
 *   - sidebar.bmp  164x314 ：欢迎页/完成页左侧竖幅
 *
 * 实现不引入任何依赖：PNG 解码用 zlib + 手写 defilter，BMP 用 24bpp BI_RGB 裸写。
 * 之所以不用 System.Drawing/sharp：前者是 Windows-only（mac/linux 打包会断），
 * 后者要装原生依赖。当前只需最近邻缩放，手写足够且跨平台。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SRC_ICON = path.join(ROOT, 'src-tauri', 'icons', 'icon.png');
const OUT_DIR = path.join(ROOT, 'src-tauri', 'installer');

// 位图规格取自 tauri 官方文档的推荐值，改动会导致 MUI 拉伸变形
const HEADER = { w: 150, h: 57 };
const SIDEBAR = { w: 164, h: 314 };

// 应用图标是「黑色圆底 + 白色 G」（实测 90.6% 不透明，黑 167k / 白 57k 像素）。
// 若把它压在品牌蓝 #4f6ef7 上，黑圆盘会变成一块突兀的色斑，因此 sidebar 改用
// 深色渐变作底，让圆盘自然融入；品牌蓝只保留在渐变尾部做点缀。
const SIDEBAR_TOP = { r: 0x1c, g: 0x21, b: 0x40 };  // 对应 ui/css 深色主题 --accent-light
const SIDEBAR_BOTTOM = { r: 0x3b, g: 0x5d, b: 0xe7 }; // ui/css --accent-hover
const HEADER_BG = { r: 0xff, g: 0xff, b: 0xff }; // MUI header 区域底色是白，必须对齐否则露边

// ── PNG 解码（仅支持 icon.png 实际使用的 8bit/RGBA/非隔行）───────────────────
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG: ' + SRC_ICON);

  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len; // len + type(4) + data + crc(4)
  }

  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error(`unsupported PNG (bitDepth=${bitDepth}, interlace=${interlace})`);
  }
  // 6=RGBA, 2=RGB。项目图标是 6，留 2 只是为了换图后不至于立刻崩
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error('unsupported PNG colorType=' + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);

  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));

    // PNG defilter：a=左像素, b=上像素, c=左上像素（单位是字节数，非像素）
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      switch (filter) {
        case 0: break;
        case 1: line[i] = (line[i] + a) & 0xff; break;
        case 2: line[i] = (line[i] + b) & 0xff; break;
        case 3: line[i] = (line[i] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          line[i] = (line[i] + pred) & 0xff;
          break;
        }
        default: throw new Error('bad PNG filter ' + filter + ' at row ' + y);
      }
    }
    prev = line;

    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
  }

  return { width, height, data: out };
}

// ── 画布：RGB 三元组，alpha 在贴图时就地合成 ────────────────────────────────
function createCanvas(w, h, fill) {
  const px = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    px[i * 3] = fill.r;
    px[i * 3 + 1] = fill.g;
    px[i * 3 + 2] = fill.b;
  }
  return { w, h, px };
}

function fillVerticalGradient(canvas, top, bottom) {
  for (let y = 0; y < canvas.h; y++) {
    const t = canvas.h === 1 ? 0 : y / (canvas.h - 1);
    const r = Math.round(top.r + (bottom.r - top.r) * t);
    const g = Math.round(top.g + (bottom.g - top.g) * t);
    const b = Math.round(top.b + (bottom.b - top.b) * t);
    for (let x = 0; x < canvas.w; x++) {
      const d = (y * canvas.w + x) * 3;
      canvas.px[d] = r;
      canvas.px[d + 1] = g;
      canvas.px[d + 2] = b;
    }
  }
}

/** 最近邻缩放 + alpha over 合成到画布 (dx,dy) 处 */
function drawImage(canvas, img, dx, dy, dw, dh) {
  for (let y = 0; y < dh; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= canvas.h) continue;
    const sy = Math.min(img.height - 1, Math.floor((y * img.height) / dh));
    for (let x = 0; x < dw; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= canvas.w) continue;
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / dw));
      const s = (sy * img.width + sx) * 4;
      const alpha = img.data[s + 3] / 255;
      if (alpha === 0) continue;
      const d = (ty * canvas.w + tx) * 3;
      canvas.px[d] = Math.round(img.data[s] * alpha + canvas.px[d] * (1 - alpha));
      canvas.px[d + 1] = Math.round(img.data[s + 1] * alpha + canvas.px[d + 1] * (1 - alpha));
      canvas.px[d + 2] = Math.round(img.data[s + 2] * alpha + canvas.px[d + 2] * (1 - alpha));
    }
  }
}

// ── BMP 编码（24bpp BI_RGB，bottom-up，行四字节对齐）───────────────────────
function encodeBmp(canvas) {
  const rowSize = Math.ceil((canvas.w * 3) / 4) * 4;
  const pixelSize = rowSize * canvas.h;
  const buf = Buffer.alloc(54 + pixelSize);

  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(54 + pixelSize, 2);
  buf.writeUInt32LE(54, 10);      // 像素数据偏移
  buf.writeUInt32LE(40, 14);      // BITMAPINFOHEADER
  buf.writeInt32LE(canvas.w, 18);
  buf.writeInt32LE(canvas.h, 22); // 正数 = bottom-up
  buf.writeUInt16LE(1, 26);       // planes
  buf.writeUInt16LE(24, 28);      // bpp
  buf.writeUInt32LE(0, 30);       // BI_RGB
  buf.writeUInt32LE(pixelSize, 34);
  buf.writeInt32LE(2835, 38);     // 72 DPI
  buf.writeInt32LE(2835, 42);

  for (let y = 0; y < canvas.h; y++) {
    const srcY = canvas.h - 1 - y; // bottom-up
    for (let x = 0; x < canvas.w; x++) {
      const s = (srcY * canvas.w + x) * 3;
      const d = 54 + y * rowSize + x * 3;
      buf[d] = canvas.px[s + 2];     // B
      buf[d + 1] = canvas.px[s + 1]; // G
      buf[d + 2] = canvas.px[s];     // R
    }
  }
  return buf;
}

function main() {
  const icon = decodePng(fs.readFileSync(SRC_ICON));
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // header：白底 + 右侧图标。留 6px 边距，避免贴到 MUI 画的分隔线上
  const header = createCanvas(HEADER.w, HEADER.h, HEADER_BG);
  const hSize = HEADER.h - 12;
  drawImage(header, icon, HEADER.w - hSize - 8, (HEADER.h - hSize) >> 1, hSize, hSize);
  fs.writeFileSync(path.join(OUT_DIR, 'header.bmp'), encodeBmp(header));

  // sidebar：深色竖向渐变 + 上部居中图标（下部留给 MUI 绘制的欢迎文案）
  const sidebar = createCanvas(SIDEBAR.w, SIDEBAR.h, SIDEBAR_TOP);
  fillVerticalGradient(sidebar, SIDEBAR_TOP, SIDEBAR_BOTTOM);
  const sSize = 96;
  drawImage(sidebar, icon, (SIDEBAR.w - sSize) >> 1, 48, sSize, sSize);
  fs.writeFileSync(path.join(OUT_DIR, 'sidebar.bmp'), encodeBmp(sidebar));

  console.log('[nsis-assets] header.bmp  %dx%d', HEADER.w, HEADER.h);
  console.log('[nsis-assets] sidebar.bmp %dx%d', SIDEBAR.w, SIDEBAR.h);
  console.log('[nsis-assets] output -> %s', OUT_DIR);
}

if (require.main === module) main();

module.exports = { decodePng, encodeBmp, createCanvas, drawImage };
