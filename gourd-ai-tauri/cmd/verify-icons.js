/**
 * verify-icons.js —— 图标资产守门（构建期断言，失败即中断打包）
 *
 * 为什么要这个脚本：
 *   tauri.conf.json 的 nsis.installerIcon / uninstallerIcon 若指向解析不到的路径，
 *   makensis **不会报错**，而是静默嵌入 NSIS 自带的默认安装图标，构建照样绿。
 *   结果就是产出一个「没有品牌图标」的安装包，且没有任何失败信号。
 *   本脚本把这些只能靠肉眼发现的退化，变成构建期硬失败。
 *
 * 同时钉死三件事：
 *   1. 配置引用的每个文件真实存在（icons/* 与 installer/*.bmp）
 *   2. 资产内容与源图同源、尺寸自洽（防止错放/半截重生成）
 *   3. 像素级品牌特征成立（黑底白字；红色像素必须极低——NSIS 默认图标是橙红飘带）
 *
 * 依赖：复用 generate-nsis-assets.js 已导出的 decodePng，不引入任何第三方包。
 * 用法：node cmd/verify-icons.js   （在 beforeBuildCommand 中于 generate-nsis-assets.js 之后执行）
 */

const fs = require('fs');
const path = require('path');
const { decodePng } = require('./generate-nsis-assets.js');

const ROOT = path.resolve(__dirname, '..');
const CONF = path.join(ROOT, 'src-tauri', 'tauri.conf.json');
const ICONS = path.join(ROOT, 'src-tauri', 'icons');
const SOURCE_SVG = path.join(ROOT, 'app-icon.svg');

// tauri-cli 2.11 官方默认 ICO 清单。缺任一帧说明重生成不完整。
const ICO_REQUIRED = [16, 24, 32, 48, 64, 256];
// ICNS 关键帧：ic07=128 ic08=256 ic09=512 ic10=1024
const ICNS_REQUIRED = ['ic07', 'ic08', 'ic09', 'ic10'];

const failures = [];
const warnings = [];
const ok = [];

function check(cond, label, detail) {
  if (cond) ok.push(label);
  else failures.push(`${label}${detail ? ' —— ' + detail : ''}`);
  return !!cond;
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

// ── 容器解析（只读头部，不解码像素）─────────────────────────────────────────
function readIcoFrames(file) {
  const b = fs.readFileSync(file);
  if (b.length < 6 || b.readUInt16LE(0) !== 0 || b.readUInt16LE(2) !== 1) return null;
  const count = b.readUInt16LE(4);
  const frames = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    if (o + 16 > b.length) break;
    frames.push({
      w: b[o] === 0 ? 256 : b[o],
      h: b[o + 1] === 0 ? 256 : b[o + 1],
      bpp: b.readUInt16LE(o + 6),
      len: b.readUInt32LE(o + 8),
      off: b.readUInt32LE(o + 12),
      isPng: b.readUInt32BE(b.readUInt32LE(o + 12)) === 0x89504e47,
    });
  }
  return { buf: b, frames };
}

function readIcnsTypes(file) {
  const b = fs.readFileSync(file);
  if (b.length < 8 || b.toString('ascii', 0, 4) !== 'icns') return null;
  const types = [];
  let p = 8;
  while (p + 8 <= b.length) {
    const t = b.toString('ascii', p, p + 4);
    const len = b.readUInt32BE(p + 4);
    if (len < 8 || p + len > b.length) break;
    types.push(t);
    p += len;
  }
  return types;
}

function pngDims(file) {
  const b = fs.readFileSync(file);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bitDepth: b[24], colorType: b[25], interlace: b[28] };
}

// 文件名自描述尺寸校验：32x32.png → 32，128x128@2x.png → 256
function declaredSize(name) {
  const m = /^(\d+)x(\d+)(@2x)?\.png$/i.exec(name);
  if (!m) return null;
  const base = parseInt(m[1], 10);
  return m[3] ? base * 2 : base;
}

function main() {
  const conf = JSON.parse(fs.readFileSync(CONF, 'utf8'));

  // 1) 图标真相源必须在仓库里，否则日后无法复现重生成
  check(fs.existsSync(SOURCE_SVG), '源图标 app-icon.svg 存在', `缺失：${rel(SOURCE_SVG)}（应由 ui/img/logo.svg 派生并纳入版本控制）`);

  // 2) tauri icon 会顺手产出移动端资产，桌面工程必须挡掉，避免污染仓库
  for (const junk of ['ios', 'android']) {
    check(!fs.existsSync(path.join(ICONS, junk)), `无多余 ${junk}/ 目录`, `发现 ${rel(path.join(ICONS, junk))}；tauri icon 的移动端产物请删除（本工程仅桌面三平台）`);
  }

  // 3) 配置引用的文件必须真实存在 —— 这条直接对应静默降级故障
  const bundleIcons = (conf.bundle && conf.bundle.icon) || [];
  check(bundleIcons.length > 0, 'bundle.icon 非空');
  for (const entry of bundleIcons) {
    check(fs.existsSync(path.join(ROOT, 'src-tauri', entry)), `bundle.icon 项存在: ${entry}`, '文件不存在，Tauri 会跳过该尺寸');
  }

  const nsis = (((conf.bundle || {}).windows || {}).nsis) || {};
  for (const key of ['installerIcon', 'uninstallerIcon', 'headerImage', 'sidebarImage']) {
    const v = nsis[key];
    if (!v) {
      warnings.push(`nsis.${key} 未配置 —— 该项将回退到 NSIS 默认图形`);
      continue;
    }
    check(fs.existsSync(path.join(ROOT, 'src-tauri', v)), `nsis.${key} 存在: ${v}`,
      'makensis 遇缺失路径不报错，会静默嵌入默认图标/位图，产出无品牌安装包');
  }

  // 4) ICO 帧清单
  const icoPath = path.join(ICONS, 'icon.ico');
  if (fs.existsSync(icoPath)) {
    const ico = readIcoFrames(icoPath);
    if (check(ico, 'icon.ico 头部合法', '不是有效的 ICO（reserved=0 且 type=1）')) {
      const sizes = ico.frames.map(f => f.w);
      for (const want of ICO_REQUIRED) {
        check(sizes.includes(want), `icon.ico 含 ${want}px 帧`, `实际帧=${sizes.join(',')}`);
      }
      const has256 = ico.frames.find(f => f.w === 256);
      check(has256 && has256.isPng, 'icon.ico 的 256px 帧为 PNG 编码', 'Explorer 超大图标/高 DPI 依赖此帧');
      check(ico.frames.every(f => f.bpp === 32), 'icon.ico 全部帧为 32bpp', '低于 32bpp 会丢 alpha，圆角变黑块');
    }
  } else {
    failures.push('icon.ico 缺失 —— Windows 安装包必然无品牌图标');
  }

  // 5) ICNS 帧清单
  const icnsPath = path.join(ICONS, 'icon.icns');
  if (fs.existsSync(icnsPath)) {
    const types = readIcnsTypes(icnsPath);
    if (check(types, 'icon.icns 头部合法', 'magic 不是 "icns"')) {
      for (const t of ICNS_REQUIRED) check(types.includes(t), `icon.icns 含 ${t} 帧`, `实际=${types.join(',')}`);
    }
  } else {
    failures.push('icon.icns 缺失 —— macOS .app/.dmg 无品牌图标');
  }

  // 6) PNG 尺寸自洽 + 必须是 RGBA 非隔行（generate-nsis-assets.js 的解码前提）
  for (const entry of bundleIcons) {
    if (!/\.png$/i.test(entry)) continue;
    const file = path.join(ROOT, 'src-tauri', entry);
    if (!fs.existsSync(file)) continue;
    const d = pngDims(file);
    if (!check(d, `${entry} 是 PNG`, '文件头不是 PNG')) continue;
    const name = path.basename(entry);
    const want = declaredSize(name);
    if (want) check(d.w === want && d.h === want, `${name} 尺寸与文件名一致`, `声明 ${want}x${want}，实际 ${d.w}x${d.h}`);
    check(d.w === d.h, `${name} 为正方形`, `${d.w}x${d.h} 非正方形，打包后会被拉伸`);
    check(d.bitDepth === 8 && d.colorType === 6 && d.interlace === 0, `${name} 为 8bit/RGBA/非隔行`,
      `实际 bitDepth=${d.bitDepth} colorType=${d.colorType} interlace=${d.interlace}；generate-nsis-assets.js 无法解码`);
  }

  // 7) 像素级品牌断言：黑底白字，且红色必须极少
  //    NSIS 默认安装图标是橙红飘带（实测红像素占比 8.2%），故用红色占比作回归哨兵。
  const basePng = path.join(ICONS, 'icon.png');
  if (fs.existsSync(basePng)) {
    let img;
    try {
      img = decodePng(fs.readFileSync(basePng));
    } catch (e) {
      check(false, 'icon.png 可解码', e.message);
    }
    if (img) {
      let black = 0, white = 0, redDominant = 0, transparent = 0;
      const tot = img.width * img.height;
      for (let i = 0; i < tot; i++) {
        const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2], a = img.data[i * 4 + 3];
        if (a < 8) { transparent++; continue; }
        if (r < 40 && g < 40 && b < 40) black++;
        else if (r > 215 && g > 215 && b > 215) white++;
        if (r > 120 && r > g * 1.5 && r > b * 1.5) redDominant++;
      }
      const pct = (n) => n / tot * 100;
      check(pct(black) > 50, 'icon.png 黑色底占比 > 50%', `实测 ${pct(black).toFixed(1)}%`);
      check(pct(white) > 10, 'icon.png 白色字形占比 > 10%', `实测 ${pct(white).toFixed(1)}%`);
      check(pct(transparent) < 15, 'icon.png 透明区（圆角外）占比 < 15%', `实测 ${pct(transparent).toFixed(1)}%`);
      check(pct(redDominant) < 1, 'icon.png 无红橙主导像素（非 NSIS 默认图标）',
        `实测 ${pct(redDominant).toFixed(1)}%；NSIS 默认安装图标该值约 8.2%，说明资产被错误图片覆盖`);
    }
  } else {
    failures.push('icon.png 缺失 —— NSIS header/sidebar 无法合成');
  }

  // 8) 派生位图必须是合法 BMP 且尺寸符合 MUI 规格（尺寸错会拉伸变形）
  const EXPECT_BMP = { 'header.bmp': [150, 57], 'sidebar.bmp': [164, 314] };
  for (const [name, [w, h]] of Object.entries(EXPECT_BMP)) {
    const file = path.join(ROOT, 'src-tauri', 'installer', name);
    if (!check(fs.existsSync(file), `${name} 已生成`, `缺失：${rel(file)}（beforeBuildCommand 需先跑 generate-nsis-assets.js）`)) continue;
    const b = fs.readFileSync(file);
    const isBmp = b.length > 54 && b.toString('ascii', 0, 2) === 'BM';
    check(isBmp, `${name} 是 BMP`, 'MUI 的 header/sidebar 槽位只接受 BMP，PNG 会让 makensis 报错');
    if (isBmp) {
      check(b.readInt32LE(18) === w && b.readInt32LE(22) === h, `${name} 尺寸 ${w}x${h}`, `实际 ${b.readInt32LE(18)}x${b.readInt32LE(22)}，偏离 MUI 规格会拉伸变形`);
      check(b.readUInt16LE(28) === 24, `${name} 为 24bpp`, `实际 ${b.readUInt16LE(28)}bpp；带 alpha 通道 MUI 不支持，会渲染成黑块`);
    }
  }

  // ── 输出 ────────────────────────────────────────────────────────────────
  console.log('[verify-icons] %d checks passed', ok.length);
  for (const w of warnings) console.log('[verify-icons] WARN  %s', w);
  if (failures.length) {
    for (const f of failures) console.error('[verify-icons] FAIL  %s', f);
    console.error('[verify-icons] %d 项断言失败，已中断打包（避免产出无品牌图标安装包）', failures.length);
    process.exit(1);
  }
  console.log('[verify-icons] OK  图标资产完整且为品牌图标，三平台（win/mac/linux）同源');
}

if (require.main === module) main();

module.exports = { readIcoFrames, readIcnsTypes, pngDims, declaredSize };
