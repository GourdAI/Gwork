#!/usr/bin/env node
'use strict';

/**
 * readonly-resource-repro.js —— 复现并验证 CI 上的
 * `build.rs:89 failed to run tauri-build: Permission denied (os error 13)`。
 *
 * ## 被验证的因果链（三条独立事实，缺一不可）
 *  1. jlink 把 `legal/**` 设为只读（0444）。该逻辑在 JDK 的
 *     `DefaultImageBuilder.storeFiles()` 里被
 *     `Files.getFileStore(root).supportsFileAttributeView(PosixFileAttributeView.class)`
 *     包着 —— **只在 POSIX 生效**，所以 Windows 开发机永远复现不了。
 *  2. Unix 的 `std::fs::copy` 会把**源文件的权限位**一并复制给目标。
 *  3. tauri-build 的 `copy_file` 是裸 `fs::copy(from, to)`，**不**像同文件的
 *     `copy_binaries` 那样先 `remove_file(dest)`。于是第二次构建以 `O_TRUNC`
 *     打开已存在的 0444 目标 → EACCES(13)。
 *
 * 本脚本用 Node 复刻第 2、3 步的语义（`fs.copyFileSync` 与 Rust 的 `fs::copy` 在
 * Unix 上同为 open(O_WRONLY|O_CREAT|O_TRUNC) + fchmod 源 mode），以此证明：
 *   - 未修复时：第二轮必然抛 EACCES/EPERM；
 *   - 修复后（unlockTree 排雷）：两轮都通过，且幂等。
 *
 * ## 平台说明（重要，别被绿色骗了）
 * Windows 上 chmod 只映射「只读属性」，不区分 u/g/o。故本脚本在 Windows 用 0o444
 * 制造只读、断言同样成立；真正的 POSIX 位语义由 CI 的 Linux/macOS 腿覆盖。
 * `--require-posix` 用于在 POSIX 上强制要求「未修复版本确实失败」，防止在某些
 * 文件系统（如以 root 运行、或挂了 no-perm 的 FS）上出现假绿。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_POSIX = process.platform !== 'win32';
const REQUIRE_POSIX = process.argv.includes('--require-posix');

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

/** 造一棵最小 JRE：bin/java(0755) + legal/java.base/LICENSE(0444) —— 与 jlink 产物同形 */
function makeJreLike(root) {
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'legal', 'java.base'), { recursive: true });
  fs.mkdirSync(path.join(root, 'legal', 'java.net.http'), { recursive: true });

  fs.writeFileSync(path.join(root, 'bin', 'java'), 'ELF-ish', { mode: 0o755 });
  for (const m of ['java.base', 'java.net.http']) {
    const p = path.join(root, 'legal', m, 'LICENSE');
    fs.writeFileSync(p, 'license text');
    fs.chmodSync(p, 0o444); // jlink 的 setReadOnly
  }
  return root;
}

/** 复刻 tauri-build 的 copy_file：裸 copy，不先删目标；Unix 上连源权限一起带过去 */
function tauriCopyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  fs.chmodSync(to, fs.statSync(from).mode & 0o777); // fs::copy 的 mode 克隆语义
}

/** 复刻 copy_resources：walk 源树逐个 copy 到 target */
function tauriCopyResources(srcRoot, destRoot) {
  for (const entry of fs.readdirSync(srcRoot, { withFileTypes: true })) {
    const s = path.join(srcRoot, entry.name);
    const d = path.join(destRoot, entry.name);
    if (entry.isDirectory()) tauriCopyResources(s, d);
    else tauriCopyFile(s, d);
  }
}

/** 与 cmd/sync-backend.js / src-tauri/build.rs 同款排雷逻辑 */
function unlockTree(dir) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;
  try {
    const want = st.isDirectory() ? 0o300 : 0o200;
    if ((st.mode & want) !== want) fs.chmodSync(dir, st.mode | want);
  } catch {
    /* 排雷失败不阻断 */
  }
  if (st.isDirectory()) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) unlockTree(path.join(dir, name));
  }
}

function isPermError(e) {
  return e && (e.code === 'EACCES' || e.code === 'EPERM');
}

function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gwork-ro-repro-'));
  console.log('沙盒: ' + tmp);

  // ── A. 证明只读位确实被造出来了（前提成立性检查）────────────────────────
  section('A. 前提：jlink 式只读 legal/**');
  const srcA = makeJreLike(path.join(tmp, 'A', 'jre'));
  const licA = path.join(srcA, 'legal', 'java.base', 'LICENSE');
  const modeA = fs.statSync(licA).mode & 0o777;
  ok((modeA & 0o200) === 0, `LICENSE 无属主写权限 (mode=${modeA.toString(8)})`);

  // ── B. 未修复：第二轮构建必炸 ───────────────────────────────────────────
  section('B. 未修复复现：两轮 copy_resources');
  const srcB = makeJreLike(path.join(tmp, 'B', 'src', 'jre'));
  const dstB = path.join(tmp, 'B', 'target', 'extraResources', 'jre');

  let firstOk = true;
  try {
    tauriCopyResources(srcB, dstB);
  } catch (e) {
    firstOk = false;
    console.error('    第一轮意外失败: ' + e.code + ' ' + e.message);
  }
  ok(firstOk, '第一轮构建成功（全新 target/，与 CI 现象一致）');

  let secondErr = null;
  try {
    tauriCopyResources(srcB, dstB);
  } catch (e) {
    secondErr = e;
  }
  if (IS_POSIX || process.platform === 'win32') {
    ok(
      secondErr !== null && isPermError(secondErr),
      '第二轮构建抛权限错' +
        (secondErr ? ` (${secondErr.code}, 文件 ${path.basename(secondErr.path || '?')})` : '（未抛错！）')
    );
    if (secondErr) {
      ok(
        /legal/.test(String(secondErr.path || '')),
        '出错文件位于 legal/ 下 —— 与 CI 日志最后一行 jre/legal/java.net.http/LICENSE 吻合'
      );
    }
  }

  // ── C. 修复后：两轮都过，且可重复 ──────────────────────────────────────
  section('C. 修复后：源头 unlockTree + 每轮排雷');
  const srcC = makeJreLike(path.join(tmp, 'C', 'src', 'jre'));
  const dstC = path.join(tmp, 'C', 'target', 'extraResources', 'jre');

  unlockTree(srcC); // 对应 sync-backend.js / workflow 的 chmod -R u+w
  const modeC = fs.statSync(path.join(srcC, 'legal', 'java.base', 'LICENSE')).mode & 0o777;
  ok((modeC & 0o200) !== 0, `排雷后源文件属主可写 (mode=${modeC.toString(8)})`);

  let roundErr = null;
  for (let i = 1; i <= 3; i += 1) {
    try {
      unlockTree(dstC); // 对应 build.rs 的 unlock_copied_resources
      tauriCopyResources(srcC, dstC);
    } catch (e) {
      roundErr = e;
      console.error(`    第 ${i} 轮失败: ${e.code} ${e.message}`);
      break;
    }
  }
  ok(roundErr === null, '连续 3 轮构建全部成功（证明修复且幂等）');

  // ── D. 只修 target 侧也够（build.rs 单独生效，不依赖 workflow 改动）─────
  section('D. 只有 build.rs 那层排雷（源头仍是只读）时也能自愈');
  const srcD = makeJreLike(path.join(tmp, 'D', 'src', 'jre'));
  const dstD = path.join(tmp, 'D', 'target', 'extraResources', 'jre');
  let dErr = null;
  for (let i = 1; i <= 3; i += 1) {
    try {
      unlockTree(dstD); // 仅 target 侧，源头保持 0444
      tauriCopyResources(srcD, dstD);
    } catch (e) {
      dErr = e;
      console.error(`    第 ${i} 轮失败: ${e.code} ${e.message}`);
      break;
    }
  }
  ok(dErr === null, '仅 build.rs 层排雷即可让重复构建通过（两层互不依赖）');

  // ── E. 排雷不跟随符号链接（macOS Framework 里大量 symlink）──────────────
  section('E. unlockTree 不跟随符号链接');
  const eRoot = path.join(tmp, 'E');
  fs.mkdirSync(path.join(eRoot, 'inside'), { recursive: true });
  const outsideFile = path.join(eRoot, 'outside.txt');
  fs.writeFileSync(outsideFile, 'x');
  fs.chmodSync(outsideFile, 0o444);
  let symlinkMade = true;
  try {
    fs.symlinkSync(outsideFile, path.join(eRoot, 'inside', 'link.txt'), 'file');
  } catch {
    symlinkMade = false; // Windows 无开发者模式时不允许建符号链接
  }
  if (symlinkMade) {
    unlockTree(path.join(eRoot, 'inside'));
    const outMode = fs.statSync(outsideFile).mode & 0o777;
    ok((outMode & 0o200) === 0, '符号链接指向的目标树外文件未被改权限');
  } else {
    console.log('  SKIP  当前环境不允许创建符号链接');
  }

  // ── 收尾 ────────────────────────────────────────────────────────────────
  unlockTree(tmp); // 否则只读文件会让 rmSync 自己也失败（同一枚地雷）
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  if (!IS_POSIX) {
    console.log(
      '注意: 当前是 Windows，chmod 仅映射只读属性；POSIX 位语义由 CI 的 Linux/macOS 腿覆盖。'
    );
  }
  if (REQUIRE_POSIX && !IS_POSIX) {
    console.error('已指定 --require-posix，但当前非 POSIX 平台');
    process.exit(2);
  }
  process.exit(fail === 0 ? 0 : 1);
}

run();
