#!/usr/bin/env node
/* ============================================================
   Tauri 版安装包一键发布：把构建产物【保留原文件名】复制进
   gourd-ai-website/downloads/tauri/，并以真实文件名生成：
     - latest.json    客户端自动更新清单（tauri-plugin-updater 读取）
     - downloads.json 官网下载区清单（gourd-ai-website/js/main.js 读取渲染）

   ⚠ 为什么是 downloads/tauri/ 而不是 downloads/：
     Electron 版已占用 downloads/ 且其 latest.yml 内写死了 GWork-Setup.exe
     及该文件的 sha512。若 Tauri 包用同名覆盖进同一目录，Electron 老客户端
     下载到的是 Tauri 包、sha512 校验必然失败（更糟的情况是校验通过后
     用 electron-updater 去装一个 Tauri NSIS 包）。两版 appId 不同
     （org.noear.gourd-ai-desktop vs com.gourdwork.desktop），本就不构成
     升级链，必须物理隔离。

   命名约定（不再做固定名改名 —— 服务器上是什么名字，两份清单就写什么）：
     各平台安装包保留 Tauri 产物原名（含版本号）：
       GWork_x.y.z_x64-setup.exe / GWork_x.y.z_x64.dmg / GWork_x.y.z_aarch64.dmg
       GWork_x.y.z_amd64.AppImage / GWork_x.y.z_amd64.deb
     macOS 更新载荷两个架构同名（GWork.app.tar.gz），统一改名为
       GWork-{x64,arm64}.app.tar.gz（与 CI 构建腿的归集改名一致），防止互相覆盖。

   两份清单都在**暂存目录**（downloadsDir）上生成而非构建目录：保证清单里
   的文件名与最终上传的文件严格一致；目录混有历史版本时会取最新并告警。

   用法：node cmd/publish-downloads.js [artifactsDir] [downloadsDir] [--version x.y.z]
   默认：artifactsDir = src-tauri/target/release/bundle
        downloadsDir = <repo>/../gourd-ai-website/downloads/tauri
   --version 可选；缺省时清单版本取 tauri.conf.json（与构建流程写入的一致）。
   ============================================================ */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
// 先摘下 --version（其余仍按位置参数解析），再转发给生成器；
// 不传时由生成器回落到 tauri.conf.json 的版本（与 set-version.js 同源）。
const rawArgs = process.argv.slice(2);
const vIdx = rawArgs.indexOf('--version');
const versionArg = vIdx >= 0 ? rawArgs.splice(vIdx, 2)[1] || '' : '';
const artifactsDir = path.resolve(
  rawArgs[0] || path.join(root, 'src-tauri', 'target', 'release', 'bundle')
);
const dlDir = path.resolve(
  rawArgs[1] || path.join(root, '..', 'gourd-ai-website', 'downloads', 'tauri')
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

/* ---- 收集 产物 → 目标名（保留原名；仅 macOS 更新载荷按架构改名防覆盖） ---- */
const jobs = []; // { src(绝对路径), dest }
const seen = new Set();
function add(src, dest) {
  if (seen.has(dest)) {
    console.log('[publish] 跳过重复目标名: ' + dest);
    return;
  }
  seen.add(dest);
  jobs.push({ src, dest });
}

for (const f of files) {
  const lower = f.toLowerCase();
  const base = path.basename(f);
  const baseLower = base.toLowerCase();
  if (baseLower.endsWith('.sig')) continue;
  const isArm = /aarch64|arm64/.test(lower);

  if (baseLower.endsWith('.exe')) add(f, base);
  else if (baseLower.endsWith('.app.tar.gz')) {
    // 两个架构的更新载荷同名（GWork.app.tar.gz）：与 CI 构建腿一致，
    // 追加 -x64/-arm64 架构后缀后再归档，防止互相覆盖。
    const renamed = /-(x64|arm64)\.app\.tar\.gz$/i.test(base)
      ? base
      : base.replace(/\.app\.tar\.gz$/i, (isArm ? '-arm64' : '-x64') + '.app.tar.gz');
    add(f, renamed);
  }
  else if (baseLower.endsWith('.dmg')) add(f, base);
  else if (baseLower.endsWith('.appimage')) add(f, base);
  else if (baseLower.endsWith('.deb')) add(f, base);
}

if (jobs.length === 0) {
  console.error('[publish] 未发现任何安装包产物（exe/dmg/app.tar.gz/AppImage/deb），请先执行打包。');
  process.exit(1);
}

fs.mkdirSync(dlDir, { recursive: true });

/* ---- 复制产物与 .sig：生成 latest.json 时会在暂存目录里直接读取 .sig 内容 ---- */
for (const j of jobs) {
  fs.copyFileSync(j.src, path.join(dlDir, j.dest));
  console.log('[publish] ' + path.basename(j.src) + '  →  ' + j.dest);
  const sig = j.src + '.sig';
  if (fs.existsSync(sig)) {
    fs.copyFileSync(sig, path.join(dlDir, j.dest + '.sig'));
    console.log('[publish] ' + path.basename(sig) + '  →  ' + j.dest + '.sig');
  }
}

/* ---- 生成 latest.json（复用同目录生成器，签名逻辑只此一处） ----
   在暂存目录上生成：清单 url 与最终上传的文件名严格一致。 */
const genArgs = [
  path.join(__dirname, 'generate-latest-json.js'),
  '--artifacts', dlDir,
  '--out', path.join(dlDir, 'latest.json'),
  '--site-out', path.join(dlDir, 'downloads.json'),
];
if (versionArg) genArgs.push('--version', versionArg);
execFileSync(process.execPath, genArgs, { stdio: 'inherit' });

console.log('[publish] 完成，共发布 ' + jobs.length + ' 个文件 → ' + dlDir);
console.log('[publish] 已生成 latest.json（自动更新）与 downloads.json（官网下载区）。');
console.log('[publish] 下一步：把 gourd-ai-website/downloads/tauri/ 整体上传服务器（同名覆盖；历史版本按需清理）。');
