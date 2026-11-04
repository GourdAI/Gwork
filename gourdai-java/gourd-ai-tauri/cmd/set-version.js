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
 * ## 另两个锁文件也要同步（2026-10 补齐，别以为只有三处）
 * 两个 lock 文件里各自还嵌着一份本包版本：
 *   - src-tauri/Cargo.lock       ← name = "gourd-ai-tauri" 段内的 version
 *   - package-lock.json          ← 顶层 version 与 packages[""].version
 * 它们不参与依赖求解，所以漏改**不会让构建报错**，但 `cargo build` / `npm ci`
 * 会把它当成「本地改动」重写回去，每次构建都凭空多出一份与版本无关的脏 diff。
 * 两个 lock 在不同模块的 .gitignore 里（不入库），因此漏改的代价会落在
 * 每个开发者自己的本地工作区上——比入库文件漏改更难发现。
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

/**
 * 同步 Cargo.lock 里本 crate 的 version（只改 name = "gourd-ai-tauri" 那一段）。
 *
 * 不能全文替换 version 行：Cargo.lock 里有几百个包的 version = "x.y.z"，
 * 全文替换会把所有依赖的锁定版本一起改掉，依赖树直接崩。
 *
 * 文件不存在时静默跳过：新人拉仓尚未 cargo build 时本就没有 Cargo.lock，
 * 那不是错误，不值得阻断发版。
 */
function syncCargoLock(version) {
  const file = path.join(ROOT, 'src-tauri/Cargo.lock');
  if (!fs.existsSync(file)) {
    console.log('[set-version] src-tauri/Cargo.lock 不存在（尚未 cargo build），跳过');
    return;
  }
  const text = fs.readFileSync(file, 'utf8');
  const marker = 'name = "gourd-ai-tauri"';
  const idx = text.indexOf(marker);
  if (idx < 0) {
    console.log('[set-version] src-tauri/Cargo.lock 中未找到本 crate 段，跳过');
    return;
  }
  // 段尾 = 下一个 [[package]]
  const nextIdx = text.indexOf('[[package]]', idx);
  const segEnd = nextIdx < 0 ? text.length : nextIdx;
  const seg = text.slice(idx, segEnd);
  const m = /(^|\r?\n)version = "([^"]*)"/.exec(seg);
  if (!m) {
    fail('src-tauri/Cargo.lock 的本 crate 段内没有 version 行');
  }
  if (m[2] === version) {
    console.log(`[set-version] src-tauri/Cargo.lock 已是 ${version}，跳过写入`);
    return;
  }
  const newSeg = seg.replace(/(^|\r?\n)version = "[^"]*"/, `$1version = "${version}"`);
  fs.writeFileSync(file, text.slice(0, idx) + newSeg + text.slice(segEnd));
  console.log(`[set-version] src-tauri/Cargo.lock: ${m[2]} -> ${version}`);
}

/**
 * 同步 package-lock.json 里本包的两处 version（顶层 + packages[""].version）。
 *
 * 只改这两处：依赖项的 version 在 packages["node_modules/xxx"] 里，不能动。
 * 文件不存在时静默跳过（原因同 Cargo.lock）。
 */
function syncNpmLock(version) {
  const file = path.join(ROOT, 'package-lock.json');
  if (!fs.existsSync(file)) {
    console.log('[set-version] package-lock.json 不存在（尚未 npm install），跳过');
    return;
  }
  const raw = fs.readFileSync(file, 'utf8');
  const json = JSON.parse(raw);
  const changes = [];
  if (json.version !== undefined && json.version !== version) {
    changes.push(`version ${json.version} -> ${version}`);
    json.version = version;
  }
  if (json.packages && json.packages[''] && json.packages[''].version !== version) {
    changes.push(`packages[""].version ${json.packages[''].version} -> ${version}`);
    json.packages[''].version = version;
  }
  if (!changes.length) {
    console.log(`[set-version] package-lock.json 已是 ${version}，跳过写入`);
    return;
  }
  // 保持 npm 自己的风格：2 空格缩进 + 行尾换行
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  console.log(`[set-version] package-lock.json: ${changes.join('; ')}`);
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

  syncCargoLock(version);
  syncNpmLock(version);

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
  // 锁文件终检：它们不入库、且漏改不报错，所以必须靠这里拦住
  const lockPath = path.join(ROOT, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (lock.version !== undefined && lock.version !== version) {
      stale.push(`package-lock.json 仍是 ${lock.version}`);
    }
    if (lock.packages && lock.packages[''] && lock.packages[''].version !== version) {
      stale.push(`package-lock.json 的 packages[""].version 仍是 ${lock.packages[''].version}`);
    }
  }
  const cargoLockPath = path.join(ROOT, 'src-tauri/Cargo.lock');
  if (fs.existsSync(cargoLockPath)) {
    const cargoLock = fs.readFileSync(cargoLockPath, 'utf8');
    const m = /name = "gourd-ai-tauri"[\s\S]{0,200}?version = "([^"]*)"/.exec(cargoLock);
    if (m && m[1] !== version) stale.push(`src-tauri/Cargo.lock 仍是 ${m[1]}`);
  }
  if (stale.length) fail(`版本写入未完成：${stale.join('；')}`);
  console.log(`[set-version] 全部版本已一致：${version}`);
}

main();
