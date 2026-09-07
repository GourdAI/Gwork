#!/usr/bin/env node
/* ============================================================
   生成 Tauri 自动更新清单 latest.json。

   与 Electron 版的本质差异（不要拿 publish-downloads.js 的思路套）：
     - electron-updater 用 latest*.yml + sha512 摘要，每平台一个 yml；
     - tauri-plugin-updater 用**单个** latest.json，内部 platforms 映射覆盖全平台，
       校验的是 minisign 签名（.sig 文件内容原样填进 signature 字段，含
       "untrusted comment:" 头），而不是摘要。

   平台键名由 tauri-plugin-updater 的 `target()` 决定：<os>-<arch>，
   其中 os ∈ {windows, darwin, linux}（macOS 是 darwin 不是 macos），
   arch 取 std::env::consts::ARCH → x86_64 / aarch64。

   各平台的「更新载荷」与安装包不是一回事：
     windows  → NSIS 安装包 .exe 本身即载荷
     darwin   → .app.tar.gz（不是 dmg！dmg 只用于首次安装）
     linux    → .AppImage 本身即载荷（deb 不支持自更新）

   用法：
     node cmd/generate-latest-json.js --artifacts <dir> --out <file> [--version x.y.z] [--notes "..."]

   --artifacts 目录会被递归扫描，按扩展名自动归类；每个载荷必须有同名 .sig 相邻，
   否则该平台条目被跳过（并在末尾汇总告警）——宁可少一个平台，也不能产出
   签名缺失的条目让客户端反复报 "signature not found"。
   ============================================================ */

'use strict';

const fs = require('fs');
const path = require('path');

/* ---- 参数解析 ---- */
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

const artifactsDir = path.resolve(arg('--artifacts', 'artifacts'));
const outFile = path.resolve(arg('--out', 'latest.json'));
const notes = arg('--notes', '');
// 下载基址：latest.json 里的 url 必须是绝对 URL，客户端直接 GET
const baseUrl = (arg('--base-url', 'https://www.gourdwork.com/downloads/tauri/') || '')
  .replace(/\/+$/, '') + '/';

let version = arg('--version', '');
if (!version) {
  // 回落到 tauri.conf.json 的 version（与 set-version.js 写入的是同一处）
  const conf = path.resolve(__dirname, '..', 'src-tauri', 'tauri.conf.json');
  version = JSON.parse(fs.readFileSync(conf, 'utf8')).version;
}
version = String(version).replace(/^v/, '');

if (!fs.existsSync(artifactsDir)) {
  console.error('[latest.json] 产物目录不存在: ' + artifactsDir);
  process.exit(1);
}

/* ---- 递归收集文件（CI 下载的 artifact 会带一层平台子目录） ---- */
function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}
const files = walk(artifactsDir, []);

/* ---- 把一个载荷文件映射到平台键 ---- */
// 注意顺序：.app.tar.gz 必须在 .tar.gz 之前判断；AppImage 要排除 .tar.gz 变体
function classify(file) {
  const n = path.basename(file);
  const lower = n.toLowerCase();
  if (lower.endsWith('.sig')) return null;

  if (lower.endsWith('.app.tar.gz')) {
    // macOS：架构信息在 CI 的目录名或文件名里（x64 / aarch64 / arm64）
    const hay = file.toLowerCase();
    const isArm = /aarch64|arm64/.test(hay);
    return isArm ? 'darwin-aarch64' : 'darwin-x86_64';
  }
  if (lower.endsWith('.appimage')) {
    return /aarch64|arm64/.test(lower) ? 'linux-aarch64' : 'linux-x86_64';
  }
  if (lower.endsWith('.exe')) {
    return /arm64|aarch64/.test(lower) ? 'windows-aarch64' : 'windows-x86_64';
  }
  return null; // dmg / deb 等仅供首装，不进更新清单
}

/* ---- 目标文件名：与 publish-downloads.js 的固定名约定保持一致 ---- */
// 更新载荷用固定名发布，latest.json 的 url 指向固定名；每次发版覆盖同名文件，
// 官网与 endpoints 都无需改动。
const FIXED_NAME = {
  'windows-x86_64': 'GWork-Setup.exe',
  'darwin-x86_64': 'GWork-x64.app.tar.gz',
  'darwin-aarch64': 'GWork-arm64.app.tar.gz',
  'linux-x86_64': 'GWork.AppImage',
};

const platforms = {};
const warnings = [];

for (const f of files) {
  const key = classify(f);
  if (!key) continue;
  if (!FIXED_NAME[key]) {
    warnings.push('未知平台键，已跳过: ' + key + ' (' + path.basename(f) + ')');
    continue;
  }
  const sigPath = f + '.sig';
  if (!fs.existsSync(sigPath)) {
    warnings.push(
      '缺少签名文件，已跳过 ' + key + ': ' + path.basename(f) +
      '（检查 bundle.createUpdaterArtifacts 与 TAURI_SIGNING_PRIVATE_KEY）'
    );
    continue;
  }
  const signature = fs.readFileSync(sigPath, 'utf8').trim();
  if (!signature) {
    warnings.push('签名文件为空，已跳过 ' + key + ': ' + path.basename(sigPath));
    continue;
  }
  if (platforms[key]) {
    warnings.push('平台 ' + key + ' 出现多个载荷，保留先到者: ' + path.basename(f));
    continue;
  }
  platforms[key] = { signature, url: baseUrl + FIXED_NAME[key] };
  console.log('[latest.json] ' + key + '  ←  ' + path.basename(f));
}

if (Object.keys(platforms).length === 0) {
  console.error('[latest.json] 未收集到任何带签名的更新载荷，拒绝生成空清单。');
  for (const w of warnings) console.error('  - ' + w);
  process.exit(1);
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  platforms,
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log('[latest.json] 版本 ' + version + '，共 ' + Object.keys(platforms).length + ' 个平台 → ' + outFile);
for (const w of warnings) console.warn('[latest.json] 警告: ' + w);
