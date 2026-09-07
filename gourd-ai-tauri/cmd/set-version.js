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
 * ## Cargo.toml 的改写为什么按「段」定位，而不是取全文首处 version
 * 旧写法 /^version = "..."/m 取全文第一处行首 version，靠的是「[package] 在文件开头、
 * 依赖都写成 `tauri = { version = "2" }`（version 不在行首）或 `objc2 = "0.5"`（键名不是
 * version）」这个约定。它能用，但一旦 [package] 省略 version（改走 workspace 继承），
 * 首个行首 version 就会落到别的段上——改错地方且不报错。故改为先界定 [package] 段
 * （段头 → 下一个 [xxx] 段头），只在段内改写，段内没有 version 行时明确报错。
 *
 * ## 必须幂等（2026-09-07 CI 事故的根因）
 * 传入的版本号与当前值相同是**正常情况**，不是错误：workflow_dispatch 手填 0.1.0、
 * 而仓库里三处本就是 0.1.0 时，旧代码用 `after === before` 判断「有没有匹配到」，
 * no-op 替换让两者相等，于是抛出「未找到 version 行」并 exit 1，三个平台的打包
 * 全部卡在第一步。现在「已是目标值」一律按成功处理，并且不落盘。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// [package] 段头。容忍行尾空格与 CRLF（Windows 下 checkout 出来常是 CRLF）。
const PACKAGE_SECTION = /^\[package\][ \t]*\r?$/m;
// 下一个段头，用来界定 [package] 段的结束位置。TOML 里以 `[` 开头的行只有段头
// （多行数组的首行总以键名开头，例如 authors = [），因此不会误判。
const NEXT_SECTION = /^\[[^\]\r\n]+\]/m;
// version = "x.y.z"，容忍等号两侧空白差异（version="1.0.0" 也能命中）。
// 只匹配到右引号为止，行尾的 \r 原样保留。
const VERSION_LINE = /^version[ \t]*=[ \t]*"[^"]*"/m;

/**
 * 定位 Cargo.toml 中 [package] 段的 version 行。
 * @returns {{kind:'no-section'} | {kind:'no-version-line'} |
 *           {kind:'ok', version:string, absStart:number, absEnd:number}}
 */
function locatePackageVersion(text) {
  const head = PACKAGE_SECTION.exec(text);
  if (!head) return { kind: 'no-section' };
  const bodyStart = head.index + head[0].length;
  const next = NEXT_SECTION.exec(text.slice(bodyStart));
  const bodyEnd = next ? bodyStart + next.index : text.length;
  const line = VERSION_LINE.exec(text.slice(bodyStart, bodyEnd));
  if (!line) return { kind: 'no-version-line' };
  return {
    kind: 'ok',
    version: /"([^"]*)"/.exec(line[0])[1],
    absStart: bodyStart + line.index,
    absEnd: bodyStart + line.index + line[0].length,
  };
}

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

  // 三处都遵循「已是目标值就不落盘」：既保证幂等，也避免把 JSON 重新序列化后
  // 产生与版本号无关的格式 diff。
  for (const rel of ['package.json', 'src-tauri/tauri.conf.json']) {
    const file = path.join(ROOT, rel);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (json.version === version) {
      console.log(`[set-version] ${rel} 已是 ${version}，跳过写入`);
      continue;
    }
    const from = json.version;
    json.version = version;
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
    console.log(`[set-version] ${rel}: ${from} -> ${version}`);
  }

  const cargo = path.join(ROOT, 'src-tauri/Cargo.toml');
  const before = fs.readFileSync(cargo, 'utf8');
  const located = locatePackageVersion(before);
  if (located.kind === 'no-section') fail('Cargo.toml 中没有 [package] 段');
  if (located.kind === 'no-version-line') {
    fail('Cargo.toml 的 [package] 段内没有 version = "..." 行（若改用 workspace 继承，请显式写回）');
  }
  if (located.version === version) {
    console.log(`[set-version] src-tauri/Cargo.toml 已是 ${version}，跳过写入`);
  } else {
    const after = before.slice(0, located.absStart)
      + `version = "${version}"`
      + before.slice(located.absEnd);
    fs.writeFileSync(cargo, after);
    console.log(`[set-version] src-tauri/Cargo.toml: ${located.version} -> ${version}`);
  }

  // 终检：任何一处没写进去都在这里以明确信息失败，CI 日志不必再猜是哪一步出的问题。
  const stale = [];
  for (const rel of ['package.json', 'src-tauri/tauri.conf.json']) {
    const actual = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')).version;
    if (actual !== version) stale.push(`${rel} 仍是 ${actual}`);
  }
  const recheck = locatePackageVersion(fs.readFileSync(cargo, 'utf8'));
  if (recheck.kind !== 'ok' || recheck.version !== version) {
    stale.push(`src-tauri/Cargo.toml 仍是 ${recheck.kind === 'ok' ? recheck.version : recheck.kind}`);
  }
  if (stale.length) fail(`版本写入未完成：${stale.join('；')}`);
  console.log(`[set-version] 三处版本已一致：${version}`);
}

main();
