#!/usr/bin/env node
'use strict';

/* ============================================================
   deb-control-fields-contract.js —— deb control 必填字段契约回归（零依赖、毫秒级）。

   为什么单列这一条：
     2026-09-16 应用商店上传 deb 报错：
       「包文件中，包control控制文件检测失败:缺少必填字段Section」。
     根因是 tauri-bundler 的「按需写出」逻辑（crates/tauri-bundler/src/bundle/
     linux/debian.rs，v2.11.4 与更早版本均为同一形态）：
         if let Some(section) = &settings.deb().section {
           writeln!(file, "Section: {section}")?;
         }
     —— `Section` 行**只在 bundle.linux.deb.section 有配置时写出**，没配就整行
     缺失；对照项 Priority 有 `optional` 兜底，始终存在。
     本仓库此前只配了 `"deb": { "depends": [] }`，故 0.1.x 产物全部缺 Section。
     （Debian 策略中 Section/Priority 属归档必填字段，商店包格式检测按此执行。）

   本脚本钉死的三件事：
     A. src-tauri/tauri.conf.json 的 bundle.linux.deb.section 必须是非空字符串，
        且符合 Debian 段名格式（小写字母开头，后跟小写字母/数字/连字符；
        见 Debian policy §2.4 Sections；商店只查「存在且非空」，格式校验拦住
        "Utility" 这类手滑写法）。
     B. 负样本对照：缺 section / 空串 / null / 非法大小写，四种坏法必须全被判红，
        且合规样本必须通过（证明断言非恒真、也不过度拦截）。
     C. 门禁自检：本脚本必须挂在 CI workflow 上，且 workflow 里必须保留对
        **真实产物**跑 dpkg-deb 校验的 Linux 门禁（两处任一被摘掉即红）。

   用法：node test/deb-control-fields-contract.js
   ============================================================ */

const fs = require('fs');
const path = require('path');

const TAURI_ROOT = path.resolve(__dirname, '..');
const CONF = path.join(TAURI_ROOT, 'src-tauri', 'tauri.conf.json');
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

// Debian 段名格式：小写字母开头，后为小写字母/数字/连字符（policy §2.4，如 utils / web / cli-mono）。
const SECTION_RE = /^[a-z][a-z0-9-]*$/;
// tauri schema 允许的 Priority 取值；不配置时 bundler 默认 optional，属正常。
const PRIORITY_ALLOWED = ['required', 'important', 'standard', 'optional', 'extra'];

/**
 * 对「一份完整的 tauri 配置对象」跑 deb 字段契约断言，返回失败原因列表（空数组 = 通过）。
 * 拆成纯函数是为了让负样本能在同一套判据下被检出（B 组），避免「改坏无从对照」。
 */
function auditDebSection(conf) {
  const failures = [];
  const deb = conf && conf.bundle && conf.bundle.linux && conf.bundle.linux.deb;
  if (!deb || typeof deb !== 'object') {
    failures.push('缺少 bundle.linux.deb 配置块');
    return failures;
  }

  const s = deb.section;
  if (typeof s !== 'string' || s.trim() === '') {
    failures.push('bundle.linux.deb.section 缺失或为空 —— tauri-bundler 不会写出 Section 行，商店包格式检测会拒绝（缺少必填字段Section）');
  } else if (!SECTION_RE.test(s)) {
    failures.push('bundle.linux.deb.section 不符合 Debian 段名格式（小写字母/数字/连字符）: ' + JSON.stringify(s));
  }

  if (deb.priority !== undefined && deb.priority !== null && !PRIORITY_ALLOWED.includes(deb.priority)) {
    failures.push('bundle.linux.deb.priority 不是允许的取值（' + PRIORITY_ALLOWED.join('/') + '）: ' + JSON.stringify(deb.priority));
  }

  return failures;
}

function run() {
  const conf = JSON.parse(fs.readFileSync(CONF, 'utf8'));

  /* ================= A. 真实配置：section 必须存在且合规 ================= */
  section('A. tauri.conf.json 的 bundle.linux.deb.section 必须存在且合规');

  const failures = auditDebSection(conf);
  if (failures.length === 0) {
    ok(true, 'section = ' + JSON.stringify(conf.bundle.linux.deb.section) + '（商店必填字段；缺失则产物 control 整行缺失）');
  } else {
    for (const f of failures) ok(false, f);
  }

  /* ================= B. 负样本对照：坏法必须被判红 ================= */
  section('B. 负样本：四种坏法必须被判红（证明断言非恒真）');

  const badCases = [
    ['B1 修复前的真实形态（无 section 键）', { bundle: { linux: { deb: { depends: [] } } } }],
    ['B2 空字符串', { bundle: { linux: { deb: { section: '' } } } }],
    ['B3 null', { bundle: { linux: { deb: { section: null } } } }],
    ['B4 非法大小写（Utility）', { bundle: { linux: { deb: { section: 'Utility' } } } }],
  ];
  for (const [label, bad] of badCases) {
    ok(auditDebSection(bad).length > 0, label + ' 被本契约判红');
  }

  // 正向样本：合规写法必须通过（防判据过严把好配置拦下）。
  ok(auditDebSection({ bundle: { linux: { deb: { section: 'utils' } } } }).length === 0,
    'B5 合规样本（section: "utils"）通过');

  /* ================= C. 门禁自检 ================= */
  section('C. 门禁自检：契约测试与产物级门禁都必须挂在 CI 上');

  const wf = fs.readFileSync(WORKFLOW, 'utf8');
  ok(wf.includes('node test/deb-control-fields-contract.js'),
    'workflow 引用了本测试（被摘掉即红）');
  ok(wf.includes('id: deb-control-gate'),
    'workflow 保留产物级 dpkg-deb 校验步骤（id: deb-control-gate，被摘掉即红）');

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
}

run();
