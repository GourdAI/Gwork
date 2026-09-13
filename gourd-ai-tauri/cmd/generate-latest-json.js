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

   url 命名：platforms[*].url = baseUrl + 载荷在 --artifacts 里的**真实文件名**
   （含版本号的原样产物名），不再做固定名映射 —— 上传服务器 / Release 时
   文件叫什么，清单就写什么，从根上杜绝「清单名 ≠ 实际文件名」导致的 404。
   macOS 双架构同名（GWork.app.tar.gz）的改名由构建腿 / publish-downloads.js 负责。

   --site-out 额外产出**官网下载清单 downloads.json**（与 latest.json 同一次扫描）：
   只收「首次安装」的安装包（exe / dmg / AppImage / deb），.sig 与 .app.tar.gz
   等更新载荷不进清单。官网 js/main.js 读取它渲染下载区 —— 发新版只要把产物
   上传到 downloads/tauri/ 即生效，官网代码零改动。字段契约（改字段必须同步
   改 main.js 的展示映射，test/release-manifest-contract.js 会拦住单边改动）：
     { version, pub_date, files: [ { name, os, arch, kind, size } ] }
     os ∈ windows|macos|linux，arch ∈ x64|arm64，kind ∈ exe|dmg|appimage|deb

   用法：
     node cmd/generate-latest-json.js --artifacts <dir> --out <file> [--site-out <file>] [--version x.y.z] [--notes "..."]

   --artifacts 目录会被递归扫描，按扩展名自动归类；每个载荷必须有同名 .sig 相邻，
   否则该平台条目被跳过（并在末尾汇总告警）——宁可少一个平台，也不能产出
   签名缺失的条目让客户端反复报 "signature not found"。
   同一平台出现多个候选（目录里混有历史版本文件）时，取 mtime 最新者并告警，
   避免清单指向旧包；历史文件请自行清理。
   退出码：任一份被请求的清单无法产出即非零（latest.json 缺签名载荷、
   --site-out 时缺安装包均算）；CI 将其降级为告警，产物有无以文件本身为准。
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
// 官网下载清单输出路径（可选）：不传则只出 latest.json（保持旧行为）
const siteOutArg = arg('--site-out', '');
const siteOut = siteOutArg ? path.resolve(siteOutArg) : '';
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

/* ---- 平台白名单：url 直接引用载荷的真实文件名，不再做固定名映射 ---- */
// 更新载荷以「产物原名（含版本号）」上传，清单如实引用；macOS 的
// GWork-{x64,arm64}.app.tar.gz 命名由构建腿 / publish-downloads.js 保证一致。
const KNOWN_PLATFORMS = new Set([
  'windows-x86_64',
  'windows-aarch64',
  'darwin-x86_64',
  'darwin-aarch64',
  'linux-x86_64',
  'linux-aarch64',
]);

const platforms = {};
const picked = {}; // key → { mtimeMs, name }，多候选时用于取最新
const warnings = [];

for (const f of files) {
  const key = classify(f);
  if (!key) continue;
  if (!KNOWN_PLATFORMS.has(key)) {
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
  const name = path.basename(f);
  const mtimeMs = fs.statSync(f).mtimeMs;
  if (platforms[key]) {
    // 目录里混有历史版本时（发新版文件累积在同一目录），取 mtime 最新者，
    // 避免清单指向旧包；被忽略的候选提示清理。
    if (mtimeMs > picked[key].mtimeMs) {
      warnings.push('平台 ' + key + ' 有多个载荷，改用最新: ' + name + '（取代 ' + picked[key].name + '）');
      platforms[key] = { signature, url: baseUrl + name };
      picked[key] = { mtimeMs, name };
    } else {
      warnings.push('平台 ' + key + ' 有多个载荷，保留较新者: ' + picked[key].name + '（忽略较旧的 ' + name + '）');
    }
    continue;
  }
  platforms[key] = { signature, url: baseUrl + name };
  picked[key] = { mtimeMs, name };
  console.log('[latest.json] ' + key + '  ←  ' + name);
}

/* ---- 官网下载清单素材（--site-out）：面向首装的安装包，不含 .sig / 更新载荷 ---- */
// 字段契约见文件头；os/arch/kind 的取值必须与 gourd-ai-website/js/main.js 的
// 展示映射一致（test/release-manifest-contract.js 会验证）。
function classifyInstaller(file) {
  const lower = path.basename(file).toLowerCase();
  if (lower.endsWith('.sig')) return null;
  const arch = /aarch64|arm64/.test(lower) ? 'arm64' : 'x64';
  if (lower.endsWith('.exe')) return { os: 'windows', arch, kind: 'exe' };
  if (lower.endsWith('.dmg')) return { os: 'macos', arch, kind: 'dmg' };
  if (lower.endsWith('.appimage')) return { os: 'linux', arch, kind: 'appimage' };
  if (lower.endsWith('.deb')) return { os: 'linux', arch, kind: 'deb' };
  return null;
}

const OS_ORDER = ['windows', 'macos', 'linux'];
const ARCH_ORDER = ['x64', 'arm64'];
const KIND_ORDER = ['exe', 'dmg', 'appimage', 'deb'];

const siteFiles = new Map(); // `os/arch/kind` → { name, os, arch, kind, size, mtimeMs }
const siteWarnings = [];
for (const f of files) {
  const cls = classifyInstaller(f);
  if (!cls) continue;
  const key = cls.os + '/' + cls.arch + '/' + cls.kind;
  const st = fs.statSync(f);
  const name = path.basename(f);
  const prev = siteFiles.get(key);
  if (prev) {
    // 与 latest.json 同策略：混有历史版本时取 mtime 最新者，并提示清理。
    if (st.mtimeMs > prev.mtimeMs) {
      siteWarnings.push('安装包 ' + key + ' 有多个候选，改用最新: ' + name + '（取代 ' + prev.name + '）');
      siteFiles.set(key, { name, os: cls.os, arch: cls.arch, kind: cls.kind, size: st.size, mtimeMs: st.mtimeMs });
    } else {
      siteWarnings.push('安装包 ' + key + ' 有多个候选，保留较新者: ' + prev.name + '（忽略较旧的 ' + name + '）');
    }
    continue;
  }
  siteFiles.set(key, { name, os: cls.os, arch: cls.arch, kind: cls.kind, size: st.size, mtimeMs: st.mtimeMs });
}

const siteList = Array.from(siteFiles.values())
  .sort((a, b) =>
    (OS_ORDER.indexOf(a.os) - OS_ORDER.indexOf(b.os)) ||
    (ARCH_ORDER.indexOf(a.arch) - ARCH_ORDER.indexOf(b.arch)) ||
    (KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)))
  .map(f => ({ name: f.name, os: f.os, arch: f.arch, kind: f.kind, size: f.size }));

const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/* ---- 写 latest.json：无带签名载荷时拒绝生成（但继续尝试 downloads.json） ---- */
let latestOk = false;
if (Object.keys(platforms).length === 0) {
  console.error('[latest.json] 未收集到任何带签名的更新载荷，拒绝生成空清单。');
  for (const w of warnings) console.error('  - ' + w);
} else {
  const manifest = {
    version,
    notes,
    pub_date: now,
    platforms,
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log('[latest.json] 版本 ' + version + '，共 ' + Object.keys(platforms).length + ' 个平台 → ' + outFile);
  for (const w of warnings) console.warn('[latest.json] 警告: ' + w);
  latestOk = true;
}

/* ---- 写 downloads.json：仅 --site-out 时产出；缺安装包同样拒绝出空清单 ---- */
let siteOk = !siteOut;
if (siteOut) {
  if (siteList.length === 0) {
    console.error('[downloads.json] 未发现任何安装包（exe/dmg/AppImage/deb），拒绝生成空清单。');
    for (const w of siteWarnings) console.error('  - ' + w);
  } else {
    const siteManifest = { version, pub_date: now, files: siteList };
    fs.mkdirSync(path.dirname(siteOut), { recursive: true });
    fs.writeFileSync(siteOut, JSON.stringify(siteManifest, null, 2) + '\n', 'utf8');
    console.log('[downloads.json] 版本 ' + version + '，共 ' + siteList.length + ' 个安装包 → ' + siteOut);
    for (const w of siteWarnings) console.warn('[downloads.json] 警告: ' + w);
    siteOk = true;
  }
}

if (!latestOk || !siteOk) process.exit(1);
