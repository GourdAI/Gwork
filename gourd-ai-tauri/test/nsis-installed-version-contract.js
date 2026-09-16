#!/usr/bin/env node
'use strict';

/* ============================================================
   nsis-installed-version-contract.js —— 安装器维护页「已存在版本」文案契约回归（零依赖、毫秒级）。

   为什么单列这一条：
     2026-09-15 用户反馈安装器维护页显示「系统中已存在版本为 旧的 的 GWork」。
     根因既非 hooks 也非语言文件，而是 template.nsi 的 compare_version 段：
       · 官方模板把 $R4 只赋为**定性词**（默认 $(older)=「旧的」、读不到版本号时
         $(unknown)=「未知」），从不写真实版本号；
       · 而中文文案是「系统中已存在版本为 $R4 的 ${PRODUCTNAME}。…」——
         $R4 在文案被 StrCpy 引用时按值展开，于是显示成「版本为 旧的」，
         用户完全看不出已装的是哪个版本。
     修法（GWork 定制第 5 处）：读出 DisplayVersion 后把**真实版本号**写入 $R4，
     $R0 为空时才退 $(unknown)；显示效果为「版本为 0.1.3 的」。
     （已用 makensis 最小 demo 实测过展开时机：$R4 的值必须在
       `StrCpy $R1 "$(olderOrUnknownVersionInstalled)"` 执行前就位。）

   本脚本钉死的四件事：
     A. compare_version 段必须把 $R0（DisplayVersion 读出的真实版本号）写入 $R4，
        并保留 $(unknown) 空值兜底；$(older) 赋值不得落在 $R0 赋值之后
        （落在后面会把真实版本号覆盖回「旧的」）。
     B. 赋值顺序：$R4 的赋值必须发生在文案引用
        （StrCpy $R1 "$(olderOrUnknownVersionInstalled)"）之前 —— 晚于引用就写不进文案。
     C. 负样本对照：官方原逻辑（只写定性词）与「先写 $R0 再被 $(older) 覆盖」
        两种坏法都必须被判红 —— 证明断言非恒真。
     D. 门禁自检：本脚本必须挂在 CI workflow 上（被摘掉即红）。

   用法：node test/nsis-installed-version-contract.js
   ============================================================ */

const fs = require('fs');
const path = require('path');

const TAURI_ROOT = path.resolve(__dirname, '..');
const TEMPLATE = path.join(TAURI_ROOT, 'src-tauri', 'installer', 'template.nsi');
const WORKFLOW = path.join(path.resolve(TAURI_ROOT, '..'), '.github', 'workflows', 'build-tauri.yml');

// 文案引用点：$R4 在这里被按值展开进 olderOrUnknownVersionInstalled。
const LABEL_USE = 'StrCpy $R1 "$(olderOrUnknownVersionInstalled)"';

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

function lineOf(text, idx) {
  return text.slice(0, idx).split('\n').length;
}

/** 提取 compare_version 段：从 `compare_version:` 标签到 SemverCompare 调用为止。 */
function extractCompareVersionSection(text) {
  const start = text.indexOf('compare_version:');
  if (start < 0) throw new Error('输入文本缺少 compare_version 标签');
  const end = text.indexOf('nsis_tauri_utils::SemverCompare', start);
  if (end < 0) throw new Error('compare_version 段内缺少 SemverCompare 调用');
  return text.slice(start, end);
}

/**
 * 对「compare_version 段」跑三条断言，返回失败原因列表（空数组 = 通过）。
 * 拆成纯函数是为了让负样本能在同一套判据下被检出（见 C 组），避免「改坏无从对照」。
 */
function auditCompareVersion(sectionText) {
  const failures = [];

  // 1) 必须把真实版本号（$R0）写入 $R4
  const assignVersion = sectionText.indexOf('StrCpy $R4 $R0');
  if (assignVersion < 0) {
    failures.push('段内没有 "StrCpy $R4 $R0"：未把真实版本号写入 $R4（是否漏了 GWork 定制第 5 处？）');
  }

  // 2) 空值兜底必须保留
  if (!sectionText.includes('StrCpy $R4 "$(unknown)"')) {
    failures.push('段内缺少 "StrCpy $R4 \\"$(unknown)\\"" 空值兜底');
  }

  // 3) $(older) 赋值不得晚于 $R0 赋值（晚到会把真实版本号覆盖回「旧的」）
  const olderIdx = sectionText.indexOf('StrCpy $R4 "$(older)"');
  if (olderIdx >= 0 && assignVersion >= 0 && olderIdx > assignVersion) {
    failures.push('"StrCpy $R4 \\"$(older)\\"" 出现在 "StrCpy $R4 $R0" 之后，会把真实版本号覆盖回「旧的」');
  }

  return failures;
}

function run() {
  const template = fs.readFileSync(TEMPLATE, 'utf8');

  /* ================= A. compare_version 段：真实版本号 + 空值兜底 ================= */
  section('A. compare_version 段必须把真实版本号写入 $R4（GWork 定制第 5 处）');

  const sec = extractCompareVersionSection(template);
  const failures = auditCompareVersion(sec);
  if (failures.length === 0) {
    ok(true, '段内契约满足：StrCpy $R4 $R0（写真实版本号）+ $(unknown) 空值兜底，且无后置 $(older) 覆盖');
  } else {
    for (const f of failures) ok(false, f);
  }

  /* ================= B. 赋值顺序：$R4 先于文案引用 ================= */
  section('B. $R4 的赋值必须发生在文案引用之前');

  const assignIdx = template.indexOf('StrCpy $R4 $R0');
  const useIdx = template.indexOf(LABEL_USE);
  ok(useIdx >= 0, 'template.nsi 含文案引用点 ' + LABEL_USE + '（找不到即红，防扫描静默失效）');
  ok(assignIdx >= 0, 'template.nsi 含 "StrCpy $R4 $R0"（找不到即红）');
  if (assignIdx >= 0 && useIdx >= 0) {
    ok(assignIdx < useIdx,
      '"StrCpy $R4 $R0"(行 ' + lineOf(template, assignIdx) + ') 在文案引用(行 ' + lineOf(template, useIdx) +
      ') 之前（$R4 在引用执行时按值展开，晚于引用就写不进文案）');
  }

  /* ================= C. 负样本对照：坏法必须被判红 ================= */
  section('C. 负样本：两种坏法必须被判红（证明断言非恒真）');

  // C1：官方原逻辑（只写定性词），修复前的原始文本
  const officialOld = [
    'compare_version:',
    '  StrCpy $R4 "$(older)"',
    '  ${If} $WixMode = 1',
    '    ReadRegStr $R0 HKLM "$R6" "DisplayVersion"',
    '  ${Else}',
    '    ReadRegStr $R0 SHCTX "${UNINSTKEY}" "DisplayVersion"',
    '  ${EndIf}',
    '  ${IfThen} $R0 == "" ${|} StrCpy $R4 "$(unknown)" ${|}',
    '  nsis_tauri_utils::SemverCompare "${VERSION}" $R0',
  ].join('\n');
  ok(auditCompareVersion(extractCompareVersionSection(officialOld)).length > 0,
    'C1 官方原逻辑文本被本契约判红（段内缺 "StrCpy $R4 $R0"）');

  // C2：先写 $R0 但被后置 $(older) 覆盖
  const clobbered = [
    'compare_version:',
    '  ${If} $R0 == ""',
    '    StrCpy $R4 "$(unknown)"',
    '  ${Else}',
    '    StrCpy $R4 $R0',
    '  ${EndIf}',
    '  StrCpy $R4 "$(older)"',
    '  nsis_tauri_utils::SemverCompare "${VERSION}" $R0',
  ].join('\n');
  ok(auditCompareVersion(extractCompareVersionSection(clobbered)).length > 0,
    'C2 「$R0 写入后又被 $(older) 覆盖」的坏法被本契约判红');

  /* ================= D. 门禁自检 ================= */
  section('D. 门禁自检：本测试必须挂在 CI 上');

  const wf = fs.readFileSync(WORKFLOW, 'utf8');
  ok(wf.includes('node test/nsis-installed-version-contract.js'),
    'workflow 引用了本测试（被摘掉即红）');

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
}

run();
