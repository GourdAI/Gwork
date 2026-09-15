#!/usr/bin/env node
'use strict';

/* ============================================================
   nsis-header-asset-contract.js —— 安装器 header 条幅资产契约回归（零依赖、毫秒级）。

   为什么单列这一条：
     2026-09-15 用户反馈「tauri 安装包全流程的文字被遮挡」，截图指向每个带 header 的
     页面（维护页/目录页/安装进度页/卸载确认页/卸载进度页）左上角：GWork 图标紧贴
     甚至压住 header 标题文字。
     根因不是 hooks、也不是模板，而是 **品牌位图的构图**：
       · MUI2 未定义 MUI_HEADERIMAGE_RIGHT 时，header 图被贴在对话框【左】侧
         （Interface.nsh:109-114 → modern_headerbmp.exe）；
       · header 标题/副标题（id 1037/1038）坐标来自该资源，固定在条幅右侧
         157px / 165px 处（96dpi dump 实测：1046=(532,341)150x53、
         1037=(689,348)323x15、1038=(697,365)315x24）；
       · 而旧版 header.bmp 把 logo 画在 150px 条幅的【右】端 x=97..142 ——
         与标题文字只隔 15px，视觉上就是「图标压住文字」。
     修法：logo 挪到条幅【左】端（x=8..53），与标题之间留出 ~100px 空白；
     留白比例与 DPI 无关（条幅与文字坐标同倍缩放），任何缩放下都不会再挤到文字。

   本脚本钉死的四件事：
     A. 磁盘上的 header.bmp / sidebar.bmp 必须与**生成器当前代码**产出的字节逐字相同
        —— 抓「改了生成器但忘了跑 node cmd/generate-nsis-assets.js」。注意 CI 每次
        构建都会重生成资产（beforeBuildCommand），所以只测资产、不测生成器是抓不住的。
     B. header.bmp 的构图契约：150x57 / 24bpp / BI_RGB；logo 墨迹必须落在条幅左端
        （maxX <= 60 ⇒ 距标题文字起点 157px 至少 97px 留白），且竖直居中。
        另有负样本对照：把 logo 按旧版右端位置重画一遍，必须被本契约判红（证明不空转）。
     C. 跨文件单一真源：tauri.conf.json 的 nsis.headerImage 必须仍指向本测试读取的
        那个文件，且卸载器图不得另配（uninstallerHeaderImage 须留空、回退同一张）；
        template.nsi / hooks.nsh 均不得出现 MUI_HEADERIMAGE_RIGHT —— 一旦把 header
        图翻到右侧，B 组「图标在左端」的前提就变了，必须在同一处改测试并重排资产。
        （2026-09-15 复核补强：原仅查 template.nsi 单文件、未管卸载器图。）
     D. 门禁自检：本脚本必须挂在 CI workflow 上（被摘掉即红）。

   用法：node test/nsis-header-asset-contract.js
   ============================================================ */

const fs = require('fs');
const path = require('path');

const TAURI_ROOT = path.resolve(__dirname, '..');
const GENERATOR = path.join(TAURI_ROOT, 'cmd', 'generate-nsis-assets.js');
const INSTALLER_DIR = path.join(TAURI_ROOT, 'src-tauri', 'installer');
const HEADER_BMP = path.join(INSTALLER_DIR, 'header.bmp');
const SIDEBAR_BMP = path.join(INSTALLER_DIR, 'sidebar.bmp');
const TAURI_CONF = path.join(TAURI_ROOT, 'src-tauri', 'tauri.conf.json');
const TEMPLATE = path.join(INSTALLER_DIR, 'template.nsi');
const HOOKS = path.join(INSTALLER_DIR, 'hooks.nsh');
const WORKFLOW = path.join(path.resolve(TAURI_ROOT, '..'), '.github', 'workflows', 'build-tauri.yml');

/* 契约常量：测试侧**独立硬编码**，不复用生成器里的常量 —— 生成器改了数值而这里
   没同步改，就应该红。157 来自 MUI2 header 资源（id 1037 相对条幅左端的 x 偏移，
   96dpi dump 实测：689 - 532 = 157）。 */
const STRIP_W = 150;
const STRIP_H = 57;
const TEXT_OFFSET_X = 157;   // header 标题文字起点（相对条幅左端）
const MIN_CLEARANCE = 60;    // 图标右缘到标题文字的最小留白
const MAX_INK_X = TEXT_OFFSET_X - MIN_CLEARANCE; // 60
const MIN_INK_X = 4;         // 图标左缘距条幅左边界的最小边距
const MARK_MIN = 40;         // 图标尺寸合理区间
const MARK_MAX = 56;

let pass = 0;
let fail = 0;

function ok(cond, msg) {
  if (cond) {
    pass += 1;
    console.log('  PASS  ' + msg);
  } else {
    fail += 1;
    console.error('  FAIL  ' + msg);
  }
}

function section(title) {
  console.log('\n== ' + title + ' ==');
}

/* ────────────────────────── BMP 解码（仅 24bpp BI_RGB bottom-up，够用且零依赖） ────────────────────────── */

function decodeBmp24(buf) {
  if (buf.length < 54 || buf.toString('ascii', 0, 2) !== 'BM') throw new Error('not a BMP');
  const dataOff = buf.readUInt32LE(10);
  const headerSize = buf.readUInt32LE(14);
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const planes = buf.readUInt16LE(26);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  const height = Math.abs(rawHeight);
  const bottomUp = rawHeight > 0;
  if (bpp !== 24 || compression !== 0) throw new Error('expected 24bpp BI_RGB, got bpp=' + bpp + ' comp=' + compression);
  const rowSize = Math.ceil((width * 3) / 4) * 4;

  const lum = (x, y) => {
    const row = bottomUp ? height - 1 - y : y;
    const o = dataOff + row * rowSize + x * 3;
    return (buf[o] + buf[o + 1] + buf[o + 2]) / 3; // B,G,R
  };

  return { width, height, planes, bpp, compression, headerSize, lum };
}

/** 墨迹包围盒：亮度 < 128 视为品牌墨迹（白底 + 单色 logo，阈值足够稳） */
function inkBox(bmp, threshold) {
  const thr = threshold == null ? 128 : threshold;
  let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1, n = 0;
  for (let y = 0; y < bmp.height; y++) {
    for (let x = 0; x < bmp.width; x++) {
      if (bmp.lum(x, y) < thr) {
        n += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, maxX, minY, maxY, n, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/* ────────────────────────────── 跑起来 ────────────────────────────── */

function run() {
  const gen = require(GENERATOR);

  /* ================= A. 资产与生成器逐字一致 ================= */
  section('A. 资产一致性：磁盘上的 BMP 必须等于生成器当前代码的输出');

  const headerOnDisk = fs.readFileSync(HEADER_BMP);
  const headerFresh = gen.encodeBmp(gen.buildHeader());
  ok(headerOnDisk.equals(headerFresh),
    'header.bmp 与生成器输出逐字相同（改了生成器忘重生成即红；磁盘 ' + headerOnDisk.length + 'B / 期望 ' + headerFresh.length + 'B）');

  const sidebarOnDisk = fs.readFileSync(SIDEBAR_BMP);
  const sidebarFresh = gen.encodeBmp(gen.buildSidebar());
  ok(sidebarOnDisk.equals(sidebarFresh), 'sidebar.bmp 与生成器输出逐字相同');

  /* ================= B. header 条幅构图契约 ================= */
  section('B. header 条幅构图：logo 必须在左端，与标题文字留白 >= ' + MIN_CLEARANCE + 'px');

  const bmp = decodeBmp24(headerOnDisk);
  ok(bmp.width === STRIP_W && bmp.height === STRIP_H,
    '条幅尺寸 ' + STRIP_W + 'x' + STRIP_H + '（实测 ' + bmp.width + 'x' + bmp.height + '，MUI 规格硬要求）');
  ok(bmp.bpp === 24 && bmp.compression === 0,
    '24bpp BI_RGB（MUI2 只吃这种；PNG 会报错、带 alpha 会渲染成黑块）');

  const box = inkBox(bmp);
  ok(box.n > 0, '条幅上存在品牌墨迹（未画出图标即红）');

  const clearance = TEXT_OFFSET_X - box.maxX;
  ok(box.maxX <= MAX_INK_X,
    'logo 右缘 x=' + box.maxX + ' <= ' + MAX_INK_X + ' ⇒ 距标题文字(' + TEXT_OFFSET_X + ')留白 ' + clearance + 'px >= ' + MIN_CLEARANCE + 'px');
  ok(box.minX >= MIN_INK_X,
    'logo 左缘 x=' + box.minX + ' >= ' + MIN_INK_X + '（不贴条幅边界）');
  ok(box.width >= MARK_MIN && box.width <= MARK_MAX && box.height >= MARK_MIN && box.height <= MARK_MAX,
    'logo 尺寸合理 ' + box.width + 'x' + box.height + '（区间 ' + MARK_MIN + '..' + MARK_MAX + '）');

  const markCenter = (box.minY + box.maxY) / 2;
  const stripCenter = (STRIP_H - 1) / 2;
  ok(Math.abs(markCenter - stripCenter) <= 4,
    'logo 竖直居中：墨迹中心 ' + markCenter + ' vs 条幅中心 ' + stripCenter + '（容差 4px）');

  // 标题文字区（x >= TEXT_OFFSET_X - 留白，仍落在条幅内的部分）必须干净：
  // 该区间若出现墨迹，说明构图已侵入文字区。
  let dirtyInTextZone = 0;
  for (let y = 0; y < bmp.height; y++) {
    for (let x = MAX_INK_X + 1; x < bmp.width; x++) {
      if (bmp.lum(x, y) < 128) dirtyInTextZone += 1;
    }
  }
  ok(dirtyInTextZone === 0,
    '条幅右段 x>' + MAX_INK_X + ' 全为底色（实测墨迹 ' + dirtyInTextZone + ' 像素）');

  // 负样本对照：用真实生成器原语按【旧版右端构图】重画一遍，必须违反上面的契约，
  // 证明这条断言不是恒真（旧构图 = drawImage(icon, 150-45-8=97, 6, 45, 45)）。
  const iconPng = gen.decodePng(fs.readFileSync(path.join(TAURI_ROOT, 'src-tauri', 'icons', 'icon.png')));
  const legacy = gen.createCanvas(STRIP_W, STRIP_H, { r: 0xff, g: 0xff, b: 0xff });
  const legacySize = STRIP_H - 12;
  gen.drawImage(legacy, iconPng, STRIP_W - legacySize - 8, (STRIP_H - legacySize) >> 1, legacySize, legacySize);
  const legacyBox = inkBox(decodeBmp24(gen.encodeBmp(legacy)));
  ok(legacyBox.maxX > MAX_INK_X,
    '负样本：旧版右端构图 logo 右缘 x=' + legacyBox.maxX + ' 会被本契约拦下（证明断言非恒真）');

  /* ================= C. 跨文件单一真源 ================= */
  section('C. 跨文件单一真源：打包配置与模板必须与本契约同向');

  const conf = JSON.parse(fs.readFileSync(TAURI_CONF, 'utf8'));
  const nsisCfg = (((conf.bundle || {}).windows || {}).nsis) || {};
  ok(nsisCfg.headerImage === 'installer/header.bmp',
    'tauri.conf.json nsis.headerImage 指向本测试读取的资产（实测 ' + JSON.stringify(nsisCfg.headerImage) + '）');

  // 卸载器图：不配置时由 MUI2 回退到安装器同一张（Interface.nsh:68-71 的 UNBITMAP 回退；
  // 打包现场即如此：staged installer.nsi 里 UNINSTALLERHEADERIMAGE = ""）。若将来单独配置了
  // 它，这张新图不会经过 B 组的构图断言 —— 必须在同一处补测，故这里显式拦下。
  ok(nsisCfg.uninstallerHeaderImage == null || nsisCfg.uninstallerHeaderImage === 'installer/header.bmp',
    'nsis.uninstallerHeaderImage 未单独配置（须回退同一资产）（实测 ' + JSON.stringify(nsisCfg.uninstallerHeaderImage) + '）');

  // 两脚本必须存在，否则下面的扫描会静默失效（宁可在这里红，不要假绿）。
  const scriptsPresent = [TEMPLATE, HOOKS].every(f => fs.existsSync(f));
  ok(scriptsPresent, '安装器脚本齐备：template.nsi + hooks.nsh 均存在');

  // 翻到右侧（MUI_HEADERIMAGE_RIGHT）会让 B 组「图标在左端、与标题留白」的前提失效。
  // template.nsi 与 hooks.nsh 是仅有的两个被编译进安装器的项目内脚本，两处都要查。
  const rightHits = [TEMPLATE, HOOKS]
    .filter(f => fs.existsSync(f))
    .filter(f => /MUI_HEADERIMAGE_RIGHT/.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.basename(f));
  ok(rightHits.length === 0,
    '安装器脚本未启用 MUI_HEADERIMAGE_RIGHT（查 template.nsi + hooks.nsh；命中: ' + (rightHits.join(', ') || '无') + '）');

  /* ================= D. 门禁自检 ================= */
  section('D. 门禁自检：本测试必须挂在 CI 上');

  const wf = fs.readFileSync(WORKFLOW, 'utf8');
  ok(wf.includes('node test/nsis-header-asset-contract.js'),
    'workflow 引用了本测试（被摘掉即红）');

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
}

run();
