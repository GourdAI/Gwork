#!/usr/bin/env node
/* ============================================================
   Tauri 版安装包一键发布：把构建产物以「固定文件名」复制进官网
   gourd-ai-website/downloads/tauri/，并生成 latest.json。

   ⚠ 为什么是 downloads/tauri/ 而不是 downloads/：
     Electron 版已占用 downloads/ 且其 latest.yml 内写死了 GWork-Setup.exe
     及该文件的 sha512。若 Tauri 包用同名覆盖进同一目录，Electron 老客户端
     下载到的是 Tauri 包、sha512 校验必然失败（更糟的情况是校验通过后
     用 electron-updater 去装一个 Tauri NSIS 包）。两版 appId 不同
     （org.noear.gourd-ai-desktop vs com.gourdwork.desktop），本就不构成
     升级链，必须物理隔离。文件名保持 GWork-* 不变。

   固定名约定（发新版覆盖同名文件即可，官网与 endpoints 零改动）：
     GWork_x.y.z_x64-setup.exe   → GWork-Setup.exe        （Windows 首装 + 更新载荷）
     GWork_x.y.z_x64.dmg         → GWork-x64.dmg          （macOS 首装）
     GWork_x.y.z_aarch64.dmg     → GWork-arm64.dmg        （macOS 首装）
     GWork.app.tar.gz            → GWork-{x64,arm64}.app.tar.gz（macOS 更新载荷）
     GWork_x.y.z_amd64.AppImage  → GWork.AppImage         （Linux 首装 + 更新载荷）
     GWork_x.y.z_amd64.deb       → GWork.deb              （Linux 首装，不支持自更新）

   用法：node cmd/publish-downloads.js [artifactsDir] [downloadsDir]
   默认：artifactsDir = src-tauri/target/release/bundle
        downloadsDir = <repo>/../gourd-ai-website/downloads/tauri
   ============================================================ */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const artifactsDir = path.resolve(
  process.argv[2] || path.join(root, 'src-tauri', 'target', 'release', 'bundle')
);
const dlDir = path.resolve(
  process.argv[3] || path.join(root, '..', 'gourd-ai-website', 'downloads', 'tauri')
);

if (!fs.existsSync(artifactsDir)) {
  console.error('[publish] 产物目录不存在: ' + artifactsDir);
  process.exit(1);
}

function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}
const files = walk(artifactsDir, []);

/* ---- 收集 产物 → 固定名 的映射 ---- */
const jobs = []; // { src(绝对路径), dest }
const seen = new Set();
function add(src, dest) {
  if (seen.has(dest)) return;
  seen.add(dest);
  jobs.push({ src, dest });
}

for (const f of files) {
  const lower = f.toLowerCase();
  const base = path.basename(f).toLowerCase();
  if (base.endsWith('.sig')) continue;
  const isArm = /aarch64|arm64/.test(lower);

  if (base.endsWith('.exe')) add(f, 'GWork-Setup.exe');
  else if (base.endsWith('.app.tar.gz')) add(f, isArm ? 'GWork-arm64.app.tar.gz' : 'GWork-x64.app.tar.gz');
  else if (base.endsWith('.dmg')) add(f, isArm ? 'GWork-arm64.dmg' : 'GWork-x64.dmg');
  else if (base.endsWith('.appimage')) add(f, 'GWork.AppImage');
  else if (base.endsWith('.deb')) add(f, 'GWork.deb');
}

if (jobs.length === 0) {
  console.error('[publish] 未发现任何安装包产物（exe/dmg/app.tar.gz/AppImage/deb），请先执行打包。');
  process.exit(1);
}

fs.mkdirSync(dlDir, { recursive: true });

/* ---- 复制产物；.sig 一并复制（诊断用，客户端只读 latest.json 内的 signature） ---- */
for (const j of jobs) {
  fs.copyFileSync(j.src, path.join(dlDir, j.dest));
  console.log('[publish] ' + path.basename(j.src) + '  →  ' + j.dest);
  const sig = j.src + '.sig';
  if (fs.existsSync(sig)) {
    fs.copyFileSync(sig, path.join(dlDir, j.dest + '.sig'));
    console.log('[publish] ' + path.basename(sig) + '  →  ' + j.dest + '.sig');
  }
}

/* ---- 生成 latest.json（复用同目录生成器，签名逻辑只此一处） ---- */
execFileSync(
  process.execPath,
  [
    path.join(__dirname, 'generate-latest-json.js'),
    '--artifacts', artifactsDir,
    '--out', path.join(dlDir, 'latest.json'),
  ],
  { stdio: 'inherit' }
);

console.log('[publish] 完成，共发布 ' + jobs.length + ' 个文件 → ' + dlDir);
console.log('[publish] 下一步：上传 gourd-ai-website/downloads/tauri/ 覆盖服务器。');
