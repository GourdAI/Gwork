#!/usr/bin/env node
'use strict';

/* ============================================================
   nsis-title-font-contract.js —— 安装器标题字号「DPI 相对映射」契约回归（零依赖、毫秒级）。

   为什么单列这一条：
     2026-09-16 用户反馈安装器 header 标题（维护页「已安装」等）字被遮挡/挤住，全流程每页都出现。
     根因是 hooks.nsh 字体替换逻辑的一个 DPI 阈值缺陷：
       · 旧实现把 lfHeight ≤ -14px 写死为「标题级大字号」→ 套 12pt 字体；
       · 该常数只对 96dpi 成立（9pt=12px、12pt=16px，14px 是二者中点）；
       · 一旦系统 200% 缩放（用户机器 192dpi 实测），9pt 的标题 = 24px > 14px，
         被误判成「大字号」升到 12pt —— 标题字形更大更粗、下缘逼近副标题。
     修法：阈值取 14px@96dpi 的 DPI 等效像素 MulDiv(14, dpi, 96)：
       96dpi→14px、192dpi→28px；9pt(12/24px) → 9pt 粗体，12pt(16/32px) → 12pt。
     对照实测（本机 192dpi，2026-09-16）：
       原始 0.1.0（09-06 构建）标题 lfH=-24，修复前 0.1.3 标题 lfH=-32（被误放大）。

   本脚本钉死的五件事：
     A. hooks.nsh 必须包含 DPI 相对阈值计算（MulDiv(14, dpi, 96) → $GWorkFontTitleMin），
        且变量声明、赋值齐备；
     B. 字体选择比较必须使用 $GWorkFontTitleMin，且不得再出现写死的 "IntCmp $R6 -14"；
     C. 映射逻辑表（纯 JS 镜像，96/144/192dpi × 9pt/12pt）：9pt 级 → 9pt，12pt 级 → 12pt；
        负样本 ①「写死 -14」在 192dpi 下把 9pt 标题误判成 12pt（bug 复现）；
        负样本 ②「对比段回退写死值」「阈值计算漏掉 DPI 缩放」的改写必须被判红；
     D. 12pt/9pt 字体创建与两条分支（wH→$GWorkFontHeader、wB→$GWorkFontBold）仍接线；
     E. 门禁自检：本脚本必须挂在 CI workflow 上（被摘掉即红）。

   用法：node test/nsis-title-font-contract.js
   ============================================================ */

const fs = require('fs');
const path = require('path');

const TAURI_ROOT = path.resolve(__dirname, '..');
const HOOKS = path.join(TAURI_ROOT, 'src-tauri', 'installer', 'hooks.nsh');
const WORKFLOW = path.join(path.resolve(TAURI_ROOT, '..'), '.github', 'workflows', 'build-tauri.yml');

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

/** 提取字体选择段：gwork_ao_chkBig 标签 → gwork_ao_have 标签。 */
function extractFontPickSection(text) {
  const start = text.indexOf('gwork_ao_chkBig:');
  if (start < 0) throw new Error('hooks.nsh 缺少 gwork_ao_chkBig 标签');
  const end = text.indexOf('gwork_ao_have:', start);
  if (end < 0) throw new Error('字体选择段内缺少 gwork_ao_have 标签');
  return text.slice(start, end);
}

/**
 * 对 hooks.nsh 全文跑「标题字号 DPI 相对映射」断言，返回失败原因列表（空数组 = 通过）。
 * 拆成纯函数是为了让负样本能在同一套判据下被检出（见 C 组），避免「改坏无从对照」。
 */
function auditTitleFontLogic(hooksText) {
  const failures = [];

  // 1) 阈值必须是 DPI 相对计算：MulDiv(14, dpi, 96)，写死 px 或漏 DPI 缩放都算坏
  if (!hooksText.includes('MulDiv(i 14, i r1, i 96)')) {
    failures.push('缺少 DPI 相对阈值计算 "MulDiv(i 14, i r1, i 96)"（写死 14px 或漏 DPI 缩放）');
  }

  // 2) 变量声明与赋值必须齐备
  if (!hooksText.includes('Var GWorkFontTitleMin')) {
    failures.push('缺少 "Var GWorkFontTitleMin" 变量声明');
  }
  if (!hooksText.includes('StrCpy $GWorkFontTitleMin')) {
    failures.push('缺少 "StrCpy $GWorkFontTitleMin" 赋值（阈值算完从未写入变量）');
  }

  // 3) 比较段：必须用变量、不得回落写死值
  let pick;
  try {
    pick = extractFontPickSection(hooksText);
  } catch (e) {
    failures.push('无法定位字体选择段：' + e.message);
    return failures;
  }
  if (!pick.includes('IntCmp $R6 $GWorkFontTitleMin')) {
    failures.push('字体选择未使用 "IntCmp $R6 $GWorkFontTitleMin"（DPI 相对阈值）');
  }
  if (pick.includes('IntCmp $R6 -14')) {
    failures.push('仍存在写死的 "IntCmp $R6 -14"（192dpi 下会把 9pt 标题误判为 12pt）');
  }

  // 4) 两条分支与字体创建仍接线
  if (!pick.includes('StrCpy $R7 $GWorkFontHeader')) {
    failures.push('字体选择段缺少 wH → $GWorkFontHeader 分支');
  }
  if (!pick.includes('StrCpy $R7 $GWorkFontBold')) {
    failures.push('字体选择段缺少 wB → $GWorkFontBold 分支');
  }
  if (!hooksText.includes('MulDiv(i 9, i r1, i 72)')) {
    failures.push('缺少 9pt 字体创建（MulDiv(i 9, i r1, i 72)）');
  }
  if (!hooksText.includes('MulDiv(i 12, i r1, i 72)')) {
    failures.push('缺少 12pt 字体创建（MulDiv(i 12, i r1, i 72)）');
  }

  return failures;
}

/** 修复后的映射（与 hooks.nsh 同式）：|lfHeight| ≥ MulDiv(14, dpi, 96) → 12pt，否则 9pt。 */
function tierFixed(dpi, pt) {
  const px = Math.floor((pt * dpi) / 72);
  const threshold = Math.floor((14 * dpi) / 96);
  return px >= threshold ? '12pt' : '9pt';
}

/** 修复前的映射（bug 复现）：|lfHeight| ≥ 14px（写死）→ 12pt，否则 9pt。 */
function tierOldBroken(dpi, pt) {
  const px = Math.floor((pt * dpi) / 72);
  return px >= 14 ? '12pt' : '9pt';
}

function run() {
  const hooks = fs.readFileSync(HOOKS, 'utf8');

  /* ================= A+B+D. hooks.nsh 全文：阈值/比较/分支 ================= */
  section('A. hooks.nsh：DPI 相对阈值 + 变量比较 + 分支接线（一次审完）');

  const failures = auditTitleFontLogic(hooks);
  if (failures.length === 0) {
    ok(true, '契约满足：MulDiv(14, dpi, 96) 计算 → $GWorkFontTitleMin → IntCmp 比较；无写死 -14；wH/wB 分支完整');
  } else {
    for (const f of failures) ok(false, f);
  }

  /* ================= C. 映射逻辑表（纯 JS 镜像 + 负样本） ================= */
  section('C. 映射逻辑表：9pt 级 → 9pt，12pt 级 → 12pt（含 200% 缩放回归点）');

  const cases = [
    [96, 9, '9pt'],
    [96, 12, '12pt'],
    [144, 9, '9pt'],
    [144, 12, '12pt'],
    [192, 9, '9pt'],   // ← 回归点：修复前此处置 '12pt'（标题被误放大）
    [192, 12, '12pt'],
  ];
  for (const [dpi, pt, want] of cases) {
    ok(tierFixed(dpi, pt) === want, dpi + 'dpi × ' + pt + 'pt → ' + want + '（修复后映射）');
  }

  // 负样本 ①：写死 -14px 的旧逻辑在 192dpi 下必然把 9pt 判成 12pt——本 bug 的复现
  ok(tierOldBroken(192, 9) === '12pt' && tierFixed(192, 9) === '9pt',
    'C1 写死阈值在 192dpi 下把 9pt 标题误判为 12pt（bug 复现），修复后回落 9pt');
  // 负样本 ②：96dpi 下两套逻辑一致——说明该 bug 只在高缩放暴露，静态对照拦不住，故必须有本测试
  ok(tierOldBroken(96, 9) === '9pt' && tierOldBroken(96, 12) === '12pt',
    'C2 96dpi 下旧逻辑亦正确——证明 bug 只在高 DPI 暴露（本测试必须在 192dpi 语义下判红）');

  // 负样本 ③④：对真实文本做「坏修复」改写，audit 必须判红（证明断言非恒真）
  const reverted = hooks
    .split('IntCmp $R6 $GWorkFontTitleMin').join('IntCmp $R6 -14');
  ok(auditTitleFontLogic(reverted).length > 0,
    'C3 对比段回退为写死 "IntCmp $R6 -14" 的改写被本契约判红');

  const noScale = hooks
    .split('MulDiv(i 14, i r1, i 96)').join('MulDiv(i 14, i r1, i 72)');
  ok(auditTitleFontLogic(noScale).length > 0,
    'C4 删掉 DPI 缩放（改成 14pt 等效）的改写被本契约判红');

  /* ================= E. 门禁自检 ================= */
  section('E. 门禁自检：本测试必须挂在 CI 上');

  const wf = fs.readFileSync(WORKFLOW, 'utf8');
  ok(wf.includes('node test/nsis-title-font-contract.js'),
    'workflow 引用了本测试（被摘掉即红）');

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
}

run();
