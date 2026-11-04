'use strict';

/**
 * generate-icons.js —— 从 SVG 母版一键生成全部品牌图标资源（可复现）
 *
 * 用法（必须用 Electron 跑，借用 Chromium 的矢量光栅化，零第三方依赖）：
 *   cd gourd-ai-desktop
 *   npm run generate-icons
 *   （等价于 node_modules\.bin\electron.cmd cmd\generate-icons.js）
 *
 * 输入:
 *   resources/icons/GWork.svg —— 品牌图标唯一母版（viewBox 1024×1024）
 *
 * 输出（写入 resources/icons/，打包时由 prepare-resources.js 同步到 build/icons）:
 *   icon.ico     11 档 PNG 压缩档：16/20/24/32/40/48/64/96/128/192/256
 *                （20/40/96/192 为 125%/150%/175% 等 DPI 缩放的补档，
 *                  修复高分辨率下系统拿相邻档拉伸导致的发糊）
 *   icon.png     1024×1024（mac 生成 icns / linux 图标用）
 *   tray-16.png  16×16 托盘专用（100% 缩放）
 *   tray-32.png  32×32 托盘专用（>100% 缩放，避免托盘拿多级 ICO 缩放发虚）
 *
 * 原理：每一档都由矢量直接光栅化（隐藏离屏窗口 + capturePage），
 * 不经过「大图缩小再放大」链路，任意 DPI 下天然锐利。
 * ICO 采用 Vista+ 的 PNG 压缩格式（全档 PNG，体积小、无损）。
 *
 * 更换图标：替换 resources/icons/GWork.svg 后重跑本脚本即可。
 */

if (!process.versions.electron) {
  console.error('[generate-icons] 本脚本依赖 Chromium 矢量渲染，请用 Electron 运行：');
  console.error('[generate-icons]   npm run generate-icons');
  console.error('[generate-icons]   或 node_modules\\.bin\\electron.cmd cmd\\generate-icons.js');
  process.exit(1);
}

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

// 离屏光栅化走软件渲染即可，禁用硬件加速避免个别显卡驱动的 capturePage 异常
app.disableHardwareAcceleration();

const ROOT = path.join(__dirname, '..');
const ICONS_DIR = path.join(ROOT, 'resources', 'icons');
const SVG_PATH = path.join(ICONS_DIR, 'GWork.svg');

// ICO 档位：标准档 + DPI 中间档（20/40/96/192 对应高缩放下的真实需求尺寸）
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 192, 256];
// 独立 PNG 输出：文件名 -> 边长
const EXTRA_PNGS = { 'icon.png': 1024, 'tray-16.png': 16, 'tray-32.png': 32 };

/**
 * 以指定边长光栅化 SVG：隐藏离屏窗口内联 SVG，双帧等待后 capturePage。
 * @param {string} svg SVG 原文
 * @param {number} size 目标边长（px）
 * @returns {Promise<Buffer>} PNG 字节
 */
async function renderSize(svg, size) {
  // 离屏窗口存在最小尺寸钳制（小窗口会被撑大），故窗口按 max(size, 128) 创建，
  // SVG 精确定位在左上角，再用 capturePage(rect) 裁出目标区域。
  const side = Math.max(size, 128);
  const win = new BrowserWindow({
    width: side,
    height: side,
    show: false,
    webPreferences: { offscreen: true, deviceScaleFactor: 1 },
  });
  try {
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
      + 'html,body{margin:0;padding:0;overflow:hidden;background:transparent;}'
      + 'svg{display:block;width:' + size + 'px;height:' + size + 'px;}'
      + '</style></head><body>' + svg + '</body></html>';
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    // 等两个动画帧，确保矢量光栅化完成再截图
    await win.webContents.executeJavaScript(
      'new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(r);})})'
    );
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    if (!image || image.isEmpty()) {
      throw new Error('capturePage 返回空图（size=' + size + '）');
    }
    const got = image.getSize();
    if (got.width !== size || got.height !== size) {
      throw new Error('尺寸不符: 期望 ' + size + 'x' + size + '，实际 ' + got.width + 'x' + got.height);
    }
    return image.toPNG();
  } finally {
    win.destroy();
  }
}

/**
 * 组装 PNG 压缩多档 ICO（Vista+）。
 * 结构：ICONDIR(6B) + N × ICONDIRENTRY(16B) + N 段 PNG 数据。
 * @param {{size:number, buf:Buffer}[]} entries 升序档位
 * @returns {Buffer}
 */
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6 + count * 16);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type: 1 = ICO
  header.writeUInt16LE(count, 4);  // 图像数量
  let offset = header.length;
  entries.forEach(function (e, i) {
    const p = 6 + i * 16;
    header.writeUInt8(e.size >= 256 ? 0 : e.size, p);      // width（256 记 0）
    header.writeUInt8(e.size >= 256 ? 0 : e.size, p + 1);  // height（256 记 0）
    header.writeUInt8(0, p + 2);        // colorCount（PNG 档恒 0）
    header.writeUInt8(0, p + 3);        // reserved
    header.writeUInt16LE(1, p + 4);     // planes
    header.writeUInt16LE(32, p + 6);    // bitCount
    header.writeUInt32LE(e.buf.length, p + 8);   // 本档数据字节数
    header.writeUInt32LE(offset, p + 12);        // 本档数据偏移
    offset += e.buf.length;
  });
  return Buffer.concat([header].concat(entries.map(function (e) { return e.buf; })));
}

async function main() {
  if (!fs.existsSync(SVG_PATH)) {
    throw new Error('缺少 SVG 母版: ' + SVG_PATH);
  }
  const svg = fs.readFileSync(SVG_PATH, 'utf8');

  // 去重渲染：tray-16/32 与 ICO 同档复用，不重复光栅化
  const sizeSet = {};
  ICO_SIZES.forEach(function (s) { sizeSet[s] = true; });
  Object.keys(EXTRA_PNGS).forEach(function (k) { sizeSet[EXTRA_PNGS[k]] = true; });
  const allSizes = Object.keys(sizeSet).map(Number).sort(function (a, b) { return a - b; });
  console.log('[generate-icons] SVG 母版: ' + SVG_PATH);
  console.log('[generate-icons] 待渲染档位: ' + allSizes.join(' / ') + ' px');

  const renders = new Map();
  for (const size of allSizes) {
    renders.set(size, await renderSize(svg, size));
    console.log('[generate-icons]   ' + size + 'x' + size + ' OK (' + renders.get(size).length + ' B)');
  }

  // 1) 多档 ICO
  const icoEntries = ICO_SIZES.map(function (s) { return { size: s, buf: renders.get(s) }; });
  const icoBuf = buildIco(icoEntries);
  fs.writeFileSync(path.join(ICONS_DIR, 'icon.ico'), icoBuf);
  console.log('[generate-icons] icon.ico 已生成: ' + icoEntries.length + ' 档, ' + icoBuf.length + ' B');

  // 2) 独立 PNG
  for (const name of Object.keys(EXTRA_PNGS)) {
    const buf = renders.get(EXTRA_PNGS[name]);
    fs.writeFileSync(path.join(ICONS_DIR, name), buf);
    console.log('[generate-icons] ' + name + ' 已生成: ' + buf.length + ' B');
  }

  console.log('[generate-icons] 全部完成');
}

app.whenReady().then(async function () {
  try {
    await main();
    app.exit(0);
  } catch (e) {
    console.error('[generate-icons] 失败: ' + ((e && e.stack) || e));
    app.exit(1);
  }
});
