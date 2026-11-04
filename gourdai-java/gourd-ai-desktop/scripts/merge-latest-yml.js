#!/usr/bin/env node
'use strict';
/* ============================================================
   merge-latest-yml.js —— 合并 electron-builder 生成的 latest*.yml。

   用于 macOS 分架构打包：x64 与 arm64 分两次打包，各自生成
   latest-mac.yml（后者覆盖前者）。本脚本把两份 yml 的 files
   数组按 url 去重拼接，使最终 latest-mac.yml 同时包含 x64 与
   arm64 两个更新条目。

   用法：node scripts/merge-latest-yml.js <in1.yml> <in2.yml> <out.yml>
   依赖：js-yaml（electron-builder 的传递依赖，随 npm install 安装）
   ============================================================ */

const fs = require('fs');
const yaml = require('js-yaml');

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error('用法: node merge-latest-yml.js <in1.yml> <in2.yml> <out.yml>');
  process.exit(1);
}
const in1 = args[0];
const in2 = args[1];
const out = args[2];

function collectEntries(doc) {
  if (!doc || typeof doc !== 'object') return [];
  if (Array.isArray(doc.files)) {
    return doc.files.filter(f => f && (f.url || f.path));
  }
  // 兜底：无 files 数组时退化为顶层 path/sha512 描述的单条目
  if (doc.path) {
    const entry = { url: doc.path, sha512: doc.sha512 };
    if (doc.size != null) entry.size = doc.size;
    return [entry];
  }
  return [];
}

const a = yaml.load(fs.readFileSync(in1, 'utf8'));
const b = yaml.load(fs.readFileSync(in2, 'utf8'));

const files = [];
const seen = new Set();
for (const entry of collectEntries(a).concat(collectEntries(b))) {
  const key = entry.url || entry.path;
  if (seen.has(key)) continue;
  seen.add(key);
  files.push(entry);
}

if (files.length === 0) {
  console.error('[merge-yml] ' + in1 + ' 与 ' + in2 + ' 中均无有效 file 条目，无法合并');
  process.exit(1);
}

// version/releaseDate 沿用第二份（较新的）yml；顶层 path/sha512 指向首个条目（兼容旧版 electron-updater）
const merged = Object.assign({}, b || {}, {
  files: files,
  path: files[0].url || files[0].path,
  sha512: files[0].sha512,
});
delete merged.size;

fs.writeFileSync(out, yaml.dump(merged, { lineWidth: -1, noRefs: true }), 'utf8');
console.log('[merge-yml] ' + in1 + ' + ' + in2 + ' -> ' + out + '（共 ' + files.length + ' 个条目）');
