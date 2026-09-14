#!/usr/bin/env node
'use strict';

/* ============================================================
   release-manifest-contract.js —— 发布清单契约回归（零依赖、毫秒级）。

   为什么单列这一条：
     2026-09-13 修掉的「清单里的文件名 ≠ 服务器上的真实文件名」类 404 bug，
     根因是生成器曾经做**固定名映射**（GWork-Setup.exe / GWork.app.tar.gz），
     而 CI 产出的其实是带版本号的真实产物名。现在的契约是「服务器上叫什么，
     清单就写什么」。本脚本把这条契约连同字段契约一并钉死，防止回退。

   被钉死的四件事：
     A. latest.json：platforms[*].url = baseUrl + **产物真实文件名**；signature
        原样透传；只有更新载荷（exe / AppImage / .app.tar.gz）进清单，dmg / deb
        （仅供首装）不进；平台键名 os 段用 darwin 而非 macos。
     B. downloads.json：顶层 {version,pub_date,files}，每项 {name,os,arch,kind,size}；
        os ∈ {windows,macos,linux}、arch ∈ {x64,arm64}、kind ∈ {exe,dmg,appimage,deb}；
        只收首装包（.sig 与更新载荷 .app.tar.gz 不进），按 os → arch → kind 稳定排序。
     C. 跨文件单一真源：downloads.json 的字段取值必须与官网 gourd-ai-website/js/main.js
        的 DOWNLOAD_PLATFORMS 展示映射**逐字对上** —— 这里直接把官网用到的
        {os,arch,kind} 三元组喂给**真实生成器**，能产出同名条目才算通过。当初
        「改了生成器字段、官网照旧映射」的单边改动就是这么漏过去的，两边都要拦。
     D. 失败语义：两份清单**解耦**（见生成器头注释「退出码」段）。缺签名载荷时
        latest.json 拒绝生成，但 downloads.json 照常产出；反之亦然；任一被请求
        却没产出 → 退出码非零，CI 才能当场红。

   做法：以**行为验证**为主 —— 造真实产物目录 → spawn 真实生成器 → 断言磁盘上
   的清单文件；源码只在「跨文件契约」（官网映射、发布脚本路径）与「CI 门禁自检」
   处读取。这样字段改名、映射漂移、固定名映射回归三类问题都会红。

   用法：node test/release-manifest-contract.js
   ============================================================ */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const TAURI_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(TAURI_ROOT, '..');
const GENERATOR = path.join(TAURI_ROOT, 'cmd', 'generate-latest-json.js');
const PUBLISHER = path.join(TAURI_ROOT, 'cmd', 'publish-downloads.js');
const WEBSITE_JS = path.join(REPO_ROOT, 'gourd-ai-website', 'js', 'main.js');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'build-tauri.yml');

/* 字段枚举：测试侧**独立硬编码**，不复用生成器常量 —— 生成器改了枚举而这里
   没同步改，就应该红。这是契约测试应有的耦合方式。 */
const OS_ENUM = ['windows', 'macos', 'linux'];
const ARCH_ENUM = ['x64', 'arm64'];
const KIND_ENUM = ['exe', 'dmg', 'appimage', 'deb'];

// 刻意用非默认 base-url：url 若来自硬编码常量而非 --base-url 参数，A 组必红
const BASE_URL = 'https://example.test/downloads/tauri/';

// 与 minisign 真实 .sig 同形：首行是 untrusted comment 头，且末尾带换行（生成器须 trim）
const SIG = 'untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i53tsomebase64payload==\n';

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

/* ────────────────────────── 夹具与工具 ────────────────────────── */

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gwork-manifest-contract-'));

function writeFile(dir, rel, data) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data == null ? '' : data);
  return p;
}

/** 造产物目录。每项 { file, text?, sig? }：sig 省略 → 不产 .sig；sig: true → 产合规 .sig */
function makeArtifacts(entries) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'artifacts-'));
  for (const e of entries) {
    writeFile(dir, e.file, e.text == null ? 'bin:' + e.file : e.text);
    if (e.sig) writeFile(dir, e.file + '.sig', e.sig === true ? SIG : e.sig);
  }
  return dir;
}

function runGenerator(opt) {
  const args = [GENERATOR, '--artifacts', opt.artifacts];
  if (opt.out) args.push('--out', opt.out);
  if (opt.siteOut) args.push('--site-out', opt.siteOut);
  if (opt.version) args.push('--version', opt.version);
  if (opt.baseUrl) args.push('--base-url', opt.baseUrl);
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** 按 basename 在夹具树里找真实路径（windows 腿刻意放在子目录，模拟 CI 的层级） */
function findInTree(root, name) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      const hit = findInTree(p, name);
      if (hit) return hit;
    } else if (e.name === name) {
      return p;
    }
  }
  return null;
}

function keysOf(o) {
  return Object.keys(o).sort().join(', ');
}

/** 真实产物命名（CI 构建腿 / publish-downloads.js 的约定，含版本号） */
const CANONICAL_NAME = {
  'windows/x64/exe': 'GWork_1.2.3_x64-setup.exe',
  'windows/arm64/exe': 'GWork_1.2.3_arm64-setup.exe',
  'macos/x64/dmg': 'GWork_1.2.3_x64.dmg',
  'macos/arm64/dmg': 'GWork_1.2.3_aarch64.dmg',
  'linux/x64/appimage': 'GWork_1.2.3_amd64.AppImage',
  'linux/arm64/appimage': 'GWork_1.2.3_aarch64.AppImage',
  'linux/x64/deb': 'GWork_1.2.3_amd64.deb',
  'linux/arm64/deb': 'GWork_1.2.3_aarch64.deb',
};

function nameOf(m) {
  return CANONICAL_NAME[m.os + '/' + m.arch + '/' + m.kind];
}

/* ────────────────────── 读官网展示映射（跨文件契约） ────────────────────── */

/** 剥掉注释后再抽取数组字面量，避免注释里的引号/方括号干扰括号配对 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function extractArrayLiteral(src, varName) {
  const head = src.indexOf('const ' + varName);
  if (head < 0) return null;
  const open = src.indexOf('[', head);
  if (open < 0) return null;
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          return vm.runInNewContext('(' + src.slice(open, i + 1) + ')', {});
        } catch (e) {
          return null;
        }
      }
    }
  }
  return null;
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

function run() {
  const websiteSrc = stripComments(fs.readFileSync(WEBSITE_JS, 'utf8'));
  const websitePlatforms = extractArrayLiteral(websiteSrc, 'DOWNLOAD_PLATFORMS');
  const baseMatch = /const\s+DOWNLOADS_BASE\s*=\s*'([^']*)'/.exec(websiteSrc);
  const websiteBase = baseMatch ? baseMatch[1] : null;

  /* ================= A. latest.json：真实文件名 + 更新载荷集合 ================= */
  section('A. latest.json：url 引用产物真实文件名（固定名映射回归即红）');

  const aDir = makeArtifacts([
    // windows 腿刻意放子目录：CI 的 artifacts/ 在拍平前就是这种层级，walk 必须递归
    { file: 'windows-raw/GWork_1.2.3_x64-setup.exe', sig: true },
    { file: 'GWork_1.2.3_x64.dmg' },
    { file: 'GWork_1.2.3_aarch64.dmg' },
    { file: 'GWork_1.2.3_amd64.AppImage', sig: true },
    { file: 'GWork_1.2.3_amd64.deb' },
    { file: 'GWork-x64.app.tar.gz', sig: true },
    { file: 'GWork-arm64.app.tar.gz', sig: true },
  ]);
  const aLatestPath = path.join(TMP_ROOT, 'a-latest.json');
  const aSitePath = path.join(TMP_ROOT, 'a-downloads.json');
  const aRun = runGenerator({
    artifacts: aDir, out: aLatestPath, siteOut: aSitePath, version: 'v1.2.3', baseUrl: BASE_URL,
  });
  const aLatest = fs.existsSync(aLatestPath) ? readJson(aLatestPath) : null;

  ok(aRun.status === 0 && aLatest, '生成器退出码 0 且 latest.json 落盘');
  ok(aLatest && keysOf(aLatest) === 'notes, platforms, pub_date, version',
    '顶层键恰为 version/notes/pub_date/platforms（实际: ' + (aLatest ? keysOf(aLatest) : '无') + '）');
  ok(aLatest && keysOf(aLatest.platforms) === 'darwin-aarch64, darwin-x86_64, linux-x86_64, windows-x86_64',
    '平台键：darwin（不是 macos） + 三平台，dmg/deb 不入更新清单（实际: ' +
      (aLatest ? keysOf(aLatest.platforms) : '无') + '）');
  ok(aLatest && aLatest.platforms['windows-x86_64'] &&
    aLatest.platforms['windows-x86_64'].url === BASE_URL + 'GWork_1.2.3_x64-setup.exe',
    'Windows url = baseUrl + 真实 exe 名（含版本号）: ' +
      (aLatest ? aLatest.platforms['windows-x86_64'].url : '无'));
  ok(aLatest && aLatest.platforms['linux-x86_64'] &&
    aLatest.platforms['linux-x86_64'].url === BASE_URL + 'GWork_1.2.3_amd64.AppImage',
    'Linux url = baseUrl + 真实 AppImage 名: ' +
      (aLatest ? aLatest.platforms['linux-x86_64'].url : '无'));
  ok(aLatest && aLatest.platforms['darwin-x86_64'] &&
    aLatest.platforms['darwin-x86_64'].url === BASE_URL + 'GWork-x64.app.tar.gz',
    'macOS x64 url = baseUrl + 构建腿改名后的真实载荷名: ' +
      (aLatest ? aLatest.platforms['darwin-x86_64'].url : '无'));
  ok(aLatest && aLatest.platforms['darwin-aarch64'] &&
    aLatest.platforms['darwin-aarch64'].url === BASE_URL + 'GWork-arm64.app.tar.gz',
    'macOS arm64 url 与 x64 不重名（防止两架构互相覆盖）: ' +
      (aLatest ? aLatest.platforms['darwin-aarch64'].url : '无'));
  ok(aLatest && aLatest.version === '1.2.3', '版本号去 v 前缀: ' +
    (aLatest ? aLatest.version : '无'));
  ok(aLatest && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(aLatest.pub_date),
    'pub_date 为秒级 ISO（无毫秒）: ' + (aLatest ? aLatest.pub_date : '无'));

  const aUrls = aLatest ? Object.keys(aLatest.platforms).map(k => aLatest.platforms[k].url) : [];
  ok(aUrls.length === 4 && !aUrls.some(u => /\.(dmg|deb)$/i.test(u)),
    '更新清单里没有 dmg / deb（它们只用于首装）');
  ok(aUrls.every(u => !u.replace(/^https:\/\//, '').includes('//')),
    'url 拼接无双斜杠（base-url 末尾斜杠已归一）: ' + JSON.stringify(aUrls));
  ok(aLatest && aLatest.platforms['windows-x86_64'].signature === SIG.trim() &&
    aLatest.platforms['windows-x86_64'].signature.startsWith('untrusted comment:'),
    '.sig 内容原样透传（保留 minisign 头、仅去首尾空白）');

  /* ================= B. downloads.json：字段契约 + 排序 ================= */
  section('B. downloads.json：字段契约、枚举、排序、只收首装包');

  const bSite = fs.existsSync(aSitePath) ? readJson(aSitePath) : null;
  const bFiles = bSite ? bSite.files : [];
  const bExpectedOrder = [
    'GWork_1.2.3_x64-setup.exe',   // windows
    'GWork_1.2.3_x64.dmg',         // macos x64
    'GWork_1.2.3_aarch64.dmg',     // macos arm64
    'GWork_1.2.3_amd64.AppImage',  // linux x64
    'GWork_1.2.3_amd64.deb',       // linux x64
  ];

  ok(!!bSite && keysOf(bSite) === 'files, pub_date, version',
    '顶层键恰为 version/pub_date/files（实际: ' + (bSite ? keysOf(bSite) : '无') + '）');
  ok(bFiles.length === 5, '只收 5 个首装包（.sig 与 .app.tar.gz 已排除，实际 ' + bFiles.length + '）');
  ok(bFiles.every(f => keysOf(f) === 'arch, kind, name, os, size'),
    '每项键恰为 name/os/arch/kind/size' +
      (bFiles[0] ? '（实际: ' + keysOf(bFiles[0]) + '）' : ''));
  ok(bFiles.every(f => OS_ENUM.includes(f.os)), 'os 取值 ∈ ' + OS_ENUM.join('|'));
  ok(bFiles.every(f => ARCH_ENUM.includes(f.arch)), 'arch 取值 ∈ ' + ARCH_ENUM.join('|'));
  ok(bFiles.every(f => KIND_ENUM.includes(f.kind)), 'kind 取值 ∈ ' + KIND_ENUM.join('|'));
  ok(JSON.stringify(bFiles.map(f => f.name)) === JSON.stringify(bExpectedOrder),
    'name 逐字等于磁盘真实文件名，且按 os→arch→kind 稳定排序: ' +
      JSON.stringify(bFiles.map(f => f.name)));
  const sizeOk = bFiles.every(f => {
    const real = findInTree(aDir, f.name);
    return !!real && f.size === fs.statSync(real).size;
  });
  ok(sizeOk, 'size 等于真实文件字节数（逐项回到磁盘核对）');
  ok(!bFiles.some(f => f.name.endsWith('.sig')) && !bFiles.some(f => /\.app\.tar\.gz$/.test(f.name)),
    '.sig 与 .app.tar.gz 均未混入官网清单');

  /* ================= C. 跨文件单一真源：官网映射 ↔ 生成器 ================= */
  section('C. 官网 js/main.js 展示映射与生成器字段同一契约（单边改动即红）');

  ok(websiteBase === 'downloads/tauri/',
    "官网 DOWNLOADS_BASE 为 'downloads/tauri/': " + websiteBase);
  ok(Array.isArray(websitePlatforms) && websitePlatforms.length > 0,
    '可从官网源码解析出 DOWNLOAD_PLATFORMS（4-6 行展示映射）');

  const rows = [];
  for (const p of websitePlatforms || []) {
    for (const r of (p.rows || [])) rows.push(r.match || {});
  }
  ok(rows.length >= 5, '官网展示行数 ' + rows.length + ' 条（Windows 1 + macOS 2 + Linux 2）');
  ok(rows.every(m => OS_ENUM.includes(m.os)) &&
    rows.every(m => ARCH_ENUM.includes(m.arch)) &&
    rows.every(m => KIND_ENUM.includes(m.kind)),
    '官网 match 的 os/arch/kind 全部落在生成器枚举内');

  // 端到端：把官网用到的三元组造成真实文件，嗂给真实生成器
  // （先筛掉无命名约定的组合，避免 path.join(undefined) 抛栈——让「映射写错」
  //   表现为一条可读的 FAIL，而不是一屏 stack trace）
  const unmapped = rows.filter(m => !nameOf(m));
  ok(unmapped.length === 0,
    '官网每组 {os,arch,kind} 都有对应的产物命名约定' +
      (unmapped.length ? '（无约定: ' + JSON.stringify(unmapped) + '）' : ''));
  const cDir = makeArtifacts(rows.filter(m => nameOf(m)).map(m => ({ file: nameOf(m) })));
  const cSitePath = path.join(TMP_ROOT, 'c-downloads.json');
  const cRun = runGenerator({
    artifacts: cDir, out: path.join(TMP_ROOT, 'c-latest.json'), siteOut: cSitePath, version: '1.2.3',
  });
  const cSite = fs.existsSync(cSitePath) ? readJson(cSitePath) : null;
  const cNames = cSite ? cSite.files.map(f => f.name) : [];
  // 注意：c 夹具只有首装包（无更新载荷签名），latest.json 会被拒绝 —— 这里只关心
  // downloads.json，它是「官网上看得见什么」的真源，与签名无关。
  ok(!!cSite && cSite.files.length === rows.length,
    '官网每条展示行都能被生成器产出条目（' + cNames.length + '/' + rows.length + '）');
  ok(JSON.stringify(cNames) === JSON.stringify(bExpectedOrder),
    '两条路径产出同一批文件名与同一顺序: ' + JSON.stringify(cNames));

  const publisherSrc = fs.readFileSync(PUBLISHER, 'utf8');
  const baseSegs = (websiteBase || 'downloads/tauri/').replace(/\/+$/, '').split('/');
  ok(publisherSrc.includes("'" + baseSegs[0] + "'") && publisherSrc.includes("'" + baseSegs[1] + "'"),
    '发布脚本的上传目录与官网读取路径同源（…/' + baseSegs.join('/') + '）');

  /* ================= D. 失败语义：两份清单解耦 ================= */
  section('D. 失败语义：缺签名只挡 latest.json；缺安装包只挡 downloads.json');

  // D1 无任何 .sig：latest.json 拒绝生成（退出码非零），downloads.json 照常产出
  const d1Dir = makeArtifacts([
    { file: 'GWork_1.2.3_x64-setup.exe' },
    { file: 'GWork_1.2.3_aarch64.dmg' },
  ]);
  const d1Latest = path.join(TMP_ROOT, 'd1-latest.json');
  const d1Site = path.join(TMP_ROOT, 'd1-downloads.json');
  const d1Run = runGenerator({ artifacts: d1Dir, out: d1Latest, siteOut: d1Site, version: '1.2.3' });
  ok(d1Run.status !== 0 && !fs.existsSync(d1Latest),
    '缺签名载荷 → latest.json 不生成且退出码非零（status=' + d1Run.status + '）');
  ok(fs.existsSync(d1Site), '同一次运行里 downloads.json 照常产出（两清单一硬一软，互不牵连）');
  ok(d1Run.stderr.includes('缺少签名文件'), 'stderr 指明真因（缺少签名文件），不是一句笼统失败');
  ok(fs.existsSync(d1Site) && readJson(d1Site).files.length === 2,
    'downloads.json 内容完整（2 个安装包，不需要签名）');

  // D2 只有更新载荷、无首装包：latest.json 产出，downloads.json 拒绝出空清单
  const d2Dir = makeArtifacts([{ file: 'GWork-arm64.app.tar.gz', sig: true }]);
  const d2Latest = path.join(TMP_ROOT, 'd2-latest.json');
  const d2Site = path.join(TMP_ROOT, 'd2-downloads.json');
  const d2Run = runGenerator({ artifacts: d2Dir, out: d2Latest, siteOut: d2Site, version: '1.2.3' });
  ok(d2Run.status !== 0 && !fs.existsSync(d2Site),
    '无安装包 → downloads.json 不产出空清单且退出码非零（status=' + d2Run.status + '）');
  ok(fs.existsSync(d2Latest) &&
    keysOf(readJson(d2Latest).platforms) === 'darwin-aarch64',
    '同一次运行里 latest.json 照常产出（macOS 载荷不以 dmg 形式进更新链）');

  // D3 空 .sig：该平台跳过，其它平台不受影响
  const d3Dir = makeArtifacts([
    { file: 'GWork_1.2.3_x64-setup.exe', sig: '\n' },
    { file: 'GWork_1.2.3_amd64.AppImage', sig: true },
  ]);
  const d3Latest = path.join(TMP_ROOT, 'd3-latest.json');
  const d3Run = runGenerator({ artifacts: d3Dir, out: d3Latest, version: '1.2.3' });
  ok(d3Run.status === 0 && fs.existsSync(d3Latest) &&
    keysOf(readJson(d3Latest).platforms) === 'linux-x86_64',
    '空 .sig 的平台被跳过，其余平台照常入选');
  ok(d3Run.stderr.includes('签名文件为空'), 'stderr 给出可操作告警（签名文件为空）');

  // D4 混有历史版本：取 mtime 最新者，避免清单指向旧包
  const d4Dir = makeArtifacts([
    { file: 'GWork_1.0.0_x64-setup.exe', sig: true },
    { file: 'GWork_1.1.0_x64-setup.exe', sig: true },
  ]);
  const oldT = new Date('2026-01-01T00:00:00Z');
  const newT = new Date('2026-06-01T00:00:00Z');
  fs.utimesSync(path.join(d4Dir, 'GWork_1.0.0_x64-setup.exe'), oldT, oldT);
  fs.utimesSync(path.join(d4Dir, 'GWork_1.1.0_x64-setup.exe'), newT, newT);
  const d4Latest = path.join(TMP_ROOT, 'd4-latest.json');
  const d4Run = runGenerator({ artifacts: d4Dir, out: d4Latest, version: '1.1.0' });
  const d4Url = fs.existsSync(d4Latest)
    ? readJson(d4Latest).platforms['windows-x86_64'].url : '无';
  ok(d4Url.endsWith('GWork_1.1.0_x64-setup.exe'),
    '多候选时取 mtime 最新者（清单不得指向旧包）: ' + d4Url);
  ok(d4Run.stderr.includes('有多个载荷'), '混版本情况有告警提示清理历史产物');

  /* ================= E. CI 门禁自检 ================= */
  section('E. 门禁自检：workflow 引用的测试文件必须真的存在');

  const workflowSrc = fs.readFileSync(WORKFLOW, 'utf8');
  const gated = [];
  const gateRe = /node\s+(test\/[A-Za-z0-9._-]+\.js)/g;
  let m;
  while ((m = gateRe.exec(workflowSrc)) !== null) gated.push(m[1]);
  ok(gated.length >= 2, 'CI 至少保留两条回归门禁（实际 ' + gated.length + ' 条）');
  const missing = gated.filter(rel => !fs.existsSync(path.join(TAURI_ROOT, rel)));
  ok(missing.length === 0,
    'workflow 引用的测试文件全部存在' + (missing.length ? '（缺失: ' + missing.join(', ') + '）' : ''));
  ok(gated.some(rel => rel.endsWith('release-manifest-contract.js')),
    '本契约测试确实挂在 CI 上（被摘掉即红）');

  /* ────────────────────────────── 收尾 ────────────────────────────── */
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
}

run();
