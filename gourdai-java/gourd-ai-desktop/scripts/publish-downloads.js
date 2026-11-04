#!/usr/bin/env node
/* ============================================================
   安装包一键发布：把构建产物 out/ 以「固定文件名（不含版本号）」
   复制进官网 gourd-ai-website/downloads/，并自动改写 yml 内文件名。

   固定名约定（与官网下载入口一致，发新版覆盖同名文件即可，官网零改动）：
     GWork Setup x.y.z.exe        → GWork-Setup.exe（+ GWork-Setup.exe.blockmap）
     GWork-x.y.z-arm64.dmg        → GWork-arm64.dmg
     GWork-x.y.z.dmg              → GWork-x64.dmg
     GWork-x.y.z.AppImage         → GWork.AppImage
     GWork-x.y.z.deb              → GWork.deb
     latest*.yml                  → 原样文件名，内容里产物名改写为固定名

   用法：node scripts/publish-downloads.js [outDir] [downloadsDir]
   默认：outDir = <repo>/out，downloadsDir = <repo>/../gourd-ai-website/downloads
   ============================================================ */

'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.resolve(process.argv[2] || path.join(root, 'out'));
const dlDir = path.resolve(process.argv[3] || path.join(root, '..', 'gourd-ai-website', 'downloads'));

if (!fs.existsSync(outDir) || !fs.statSync(outDir).isDirectory()) {
  console.error('[publish] out 目录不存在: ' + outDir);
  process.exit(1);
}
fs.mkdirSync(dlDir, { recursive: true });

const entries = fs.readdirSync(outDir).filter(f => fs.statSync(path.join(outDir, f)).isFile());

/* ---- 收集 二进制产物 → 固定名 的映射 ---- */
const jobs = []; // { src, dest }

const exe = entries.find(f => /\.exe$/i.test(f));
if (exe) {
  jobs.push({ src: exe, dest: 'GWork-Setup.exe' });
  const blockmap = entries.find(f => f === exe + '.blockmap');
  if (blockmap) jobs.push({ src: blockmap, dest: 'GWork-Setup.exe.blockmap' });
}

const dmgs = entries.filter(f => /\.dmg$/i.test(f));
for (const d of dmgs) {
  jobs.push({ src: d, dest: /arm64/i.test(d) ? 'GWork-arm64.dmg' : 'GWork-x64.dmg' });
}

for (const f of entries.filter(f => /\.appimage$/i.test(f))) {
  jobs.push({ src: f, dest: 'GWork.AppImage' });
}
for (const f of entries.filter(f => /\.deb$/i.test(f))) {
  jobs.push({ src: f, dest: 'GWork.deb' });
}

if (jobs.length === 0) {
  console.error('[publish] out/ 中未发现任何安装包产物（exe/dmg/AppImage/deb），请先执行打包。');
  process.exit(1);
}

/* ---- 复制二进制产物 ---- */
for (const j of jobs) {
  fs.copyFileSync(path.join(outDir, j.src), path.join(dlDir, j.dest));
  console.log('[publish] ' + j.src + '  →  ' + j.dest);
}

/* ---- 复制并改写 yml（把产物原名替换为固定名） ---- */
const ymls = entries.filter(f => /^latest.*\.yml$/i.test(f));
for (const y of ymls) {
  let text = fs.readFileSync(path.join(outDir, y), 'utf8');
  for (const j of jobs) {
    text = text.split(j.src).join(j.dest);
  }
  fs.writeFileSync(path.join(dlDir, y), text, 'utf8');
  console.log('[publish] ' + y + '  →  ' + y + '（内部文件名已改写为固定名）');
}

console.log('[publish] 完成，共发布 ' + jobs.length + ' 个安装包 → ' + dlDir);
console.log('[publish] 下一步：把 gourd-ai-website/downloads/ 上传覆盖服务器，官网无需改代码。');
