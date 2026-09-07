#!/usr/bin/env node
'use strict';

/**
 * set-version.js —— 把版本号同步写入 Tauri 模块的三处声明。
 *
 * 用法：node cmd/set-version.js 1.2.3
 *
 * ## 为什么三处都要改
 * Tauri 的版本号来源与 Electron 不同，三个文件各有各的用途，漂移了很难排查：
 *   - src-tauri/tauri.conf.json  ← **决定产物版本**：NSIS 升级链、dmg/deb 文件名、
 *                                   以及 updater.rs 比对的 `app.package_info().version`
 *   - src-tauri/Cargo.toml       ← crate 版本；未显式配置时 tauri.conf.json 的 version
 *                                   会回落到它，且它决定 exe 的文件属性
 *   - package.json               ← 仅作模块自身标识，保持一致便于人工核对
 *
 * ## Cargo.toml 的改写为什么用「首处匹配」
 * `[package]` 段固定在文件开头，其 version 是全文第一处行首的 `version = "..."`。
 * 依赖项的版本都写成 `tauri = { version = "2" }` 或 `objc2 = "0.5"` 这类形式
 * （前者 version 不在行首，后者键名不是 version），因此非全局的 /^version = "..."/m
 * 只会命中 [package].version，不会误伤依赖。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`[set-version] ${msg}`);
  process.exit(1);
}

function main() {
  const version = process.argv[2];
  if (!version) fail('缺少版本号参数，用法: node cmd/set-version.js <version>');
  // 允许 1.2.3 / 1.2.3-beta.1 这类语义化版本；NSIS 与 msi 对纯数字段有要求，
  // 这里只挡住明显非法值（如误把 "v1.2.3" 或路径传进来）
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`版本号格式非法: ${version}（期望 x.y.z，可带 -beta.1 后缀，不要带前导 v）`);
  }

  for (const rel of ['package.json', 'src-tauri/tauri.conf.json']) {
    const file = path.join(ROOT, rel);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    json.version = version;
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
    console.log(`[set-version] ${rel} -> ${version}`);
  }

  const cargo = path.join(ROOT, 'src-tauri/Cargo.toml');
  const before = fs.readFileSync(cargo, 'utf8');
  const after = before.replace(/^version = "[^"]*"/m, `version = "${version}"`);
  if (after === before) fail('Cargo.toml 中未找到 [package] 段的 version 行');
  fs.writeFileSync(cargo, after);
  console.log(`[set-version] src-tauri/Cargo.toml -> ${version}`);
}

main();
