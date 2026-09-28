#!/usr/bin/env node
'use strict';

/* ============================================================
   nsis-template-cli-version-contract.js —— NSIS 冻结模板与 @tauri-apps/cli 版本对齐契约（零依赖、毫秒级）。

   为什么单列这一条（2026-09-28 事故复盘）：
     src-tauri/installer/template.nsi 是对 @tauri-apps/cli 内置 NSIS 模板的【整份覆盖】
     （tauri.conf.json → bundle.windows.nsis.template），基线冻结在 2.11.4。
     而 package.json 的 devDependencies 曾写浮动范围 "^2"、package-lock.json 不入库，
     CI 的 npm install 因此装到了刚发布的 2.12.0：其 bundler 的 utils.nsh 把
     CheckIfAppIsRunning 改用 Windows Restart Manager 宏（上游 PR #14479），宏体里
     `!insertmacro RestartManager_StartSession` 依赖 NSIS 自带 Include\Win\RestartManager.nsh，
     官方 2.12.0 模板在头部 include 群新增了 `!include "Win\RestartManager.nsh"`，
     冻结模板没有这一行 → makensis 直接报
       !insertmacro: macro named "RestartManager_StartSession" not found
       Error in script .../installer.nsi on line 680 -- aborting creation process
     Windows 腿整条红（macOS/Linux 不走 NSIS 所以照常绿）。
     同批差异还有：CheckIfAppIsRunning 首参由【进程名】改为【可执行文件全路径】
     （Restart Manager 按路径登记锁文件；传进程名不报错但检查静默失效）。

   本脚本钉死的事：
     A. package.json 的 @tauri-apps/cli 必须是【精确版本】（x.y.z），禁止 ^/~/>= 等浮动写法
        —— 浮动范围是本次事故的直接引信。
     B. template.nsi 头部「对应版本」标记行的版本号 == package.json 钉的版本
        （防止「改了依赖忘了同步模板」或反之）。
     C. 模板内容特征（与钉住版本配套的最低要求，均从源码正则派生，不硬编码行号）：
        C1. 头部 include 群恰好含一行 !include "Win\RestartManager.nsh"；
        C2. 全部（恰好 2 处）!insertmacro CheckIfAppIsRunning 的首参都是全路径
            "$INSTDIR\${MAINBINARYNAME}.exe"（2.12.0 语义；进程名写法判红）；
        C3. 该 include 必须出现在首个 CheckIfAppIsRunning 与 installer_hooks 条件
            include 块之前（宏定义先于使用/先于 hooks 展开）。
     D. 若 node_modules/@tauri-apps/cli 已安装（本地或 CI 的 npm install 之后），
        其实际版本必须 == 钉的版本；未安装则跳过本条并显式打印 SKIP（CI 早期批次
        跑本脚本时 node_modules 尚不存在，npm install 后会再跑一次激活本条）。
     E. 负样本对照：删 include / 首参退回进程名 / 浮动范围 / 头部标记漂移，四种坏法
        都必须被判红 —— 证明断言非恒真。
     F. 门禁自检：本脚本必须挂在 CI workflow 上（被摘掉即红）。

   用法：node test/nsis-template-cli-version-contract.js
   ============================================================ */

const fs = require('fs');
const path = require('path');

const TAURI_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(TAURI_ROOT, '..');
const TEMPLATE = path.join(TAURI_ROOT, 'src-tauri', 'installer', 'template.nsi');
const PKG = path.join(TAURI_ROOT, 'package.json');
const INSTALLED_CLI_PKG = path.join(TAURI_ROOT, 'node_modules', '@tauri-apps', 'cli', 'package.json');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'build-tauri.yml');

const RESTART_MANAGER_INCLUDE = '!include "Win\\RestartManager.nsh"';
// 2.12.0 语义：首参必须是安装目录下的可执行文件全路径。
const CHECK_CALL_RE = /!insertmacro CheckIfAppIsRunning "\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe" "\$\{PRODUCTNAME\}"/g;
const CHECK_ANY_RE = /!insertmacro CheckIfAppIsRunning[^\n]*/g;
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+$/;

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

/** 对模板文本跑 C 组断言，返回失败原因列表（空数组 = 通过）。拆成纯函数以便负样本复用同一判据。 */
function auditTemplate(text) {
  const failures = [];

  const includeCount = text.split(RESTART_MANAGER_INCLUDE).length - 1;
  if (includeCount !== 1) {
    failures.push('Win\\RestartManager.nsh 的 include 应恰好 1 行，实际 ' + includeCount + ' 行');
  }

  const calls = text.match(CHECK_ANY_RE) || [];
  if (calls.length !== 2) {
    failures.push('CheckIfAppIsRunning 调用点应恰好 2 处（Install/Uninstall 各一），实际 ' + calls.length + ' 处');
  }
  const fullpathCalls = text.match(CHECK_CALL_RE) || [];
  if (fullpathCalls.length !== calls.length || calls.length !== 2) {
    failures.push('CheckIfAppIsRunning 首参必须全为全路径 "$INSTDIR\\${MAINBINARYNAME}.exe"（2.12.0 Restart Manager 语义），全路径 ' + fullpathCalls.length + ' / 总 ' + calls.length);
  }

  const includeIdx = text.indexOf(RESTART_MANAGER_INCLUDE);
  const firstCallCheckIdx = text.search(CHECK_ANY_RE);
  const hooksIdx = text.indexOf('{{#if installer_hooks}}');
  if (includeIdx < 0) {
    failures.push('缺少 ' + RESTART_MANAGER_INCLUDE);
  } else {
    if (firstCallCheckIdx >= 0 && includeIdx > firstCallCheckIdx) {
      failures.push('RestartManager include 必须早于首个 CheckIfAppIsRunning（宏定义先于使用）');
    }
    if (hooksIdx >= 0 && includeIdx > hooksIdx) {
      failures.push('RestartManager include 必须早于 installer_hooks 条件 include 块（与官方模板顺序一致）');
    }
  }
  return failures;
}

/** 从 package.json 文本提取钉住的版本；浮动写法返回 null。 */
function pinnedVersionFromPackageText(pkgText) {
  const m = pkgText.match(/"@tauri-apps\/cli"\s*:\s*"([^"]+)"/);
  if (!m) return { raw: null, exact: null };
  return { raw: m[1], exact: EXACT_VERSION_RE.test(m[1]) ? m[1] : null };
}

/** 从模板头部「对应版本」标记行提取版本号。 */
function headerVersion(text) {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (/^;\s*对应版本\s*:/.test(line)) {
      const m = line.match(/@tauri-apps\/cli\s+(\d+\.\d+\.\d+)/);
      return m ? m[1] : null;
    }
  }
  return null;
}

const templateText = fs.readFileSync(TEMPLATE, 'utf8');
const pkgText = fs.readFileSync(PKG, 'utf8');
const pin = pinnedVersionFromPackageText(pkgText);

section('A. package.json 钉精确版本');
ok(pin.raw !== null, 'package.json 存在 @tauri-apps/cli 依赖声明（raw=' + pin.raw + '）');
ok(pin.exact !== null, '依赖写法为精确版本 x.y.z（禁止 ^/~/>= 浮动；本次事故引信即浮动 ^2），实际 raw=' + pin.raw);

section('B. 模板头部标记与钉版一致');
const hv = headerVersion(templateText);
ok(hv !== null, 'template.nsi 头部存在「对应版本 : @tauri-apps/cli x.y.z」标记行（读到 ' + hv + '）');
ok(pin.exact !== null && hv === pin.exact, '头部标记版本 == package.json 钉版（header=' + hv + ', pin=' + pin.exact + '）');

section('C. 模板内容特征（RestartManager include + 全路径参数 + 顺序）');
const realFailures = auditTemplate(templateText);
ok(realFailures.length === 0, '真实模板通过 C 组断言' + (realFailures.length ? '：' + realFailures.join('；') : ''));

section('D. 已安装 CLI 版本与钉版一致（未安装则 SKIP）');
if (fs.existsSync(INSTALLED_CLI_PKG)) {
  const installed = JSON.parse(fs.readFileSync(INSTALLED_CLI_PKG, 'utf8')).version;
  ok(installed === pin.exact, 'node_modules/@tauri-apps/cli 实际版本 == 钉版（installed=' + installed + ', pin=' + pin.exact + '）');
} else {
  console.log('  SKIP  node_modules/@tauri-apps/cli 不存在（CI 早期批次正常；npm install 后的复跑会激活本条）');
}

section('E. 负样本对照（四种坏法必须判红）');
const n1 = auditTemplate(templateText.split('\r\n' + RESTART_MANAGER_INCLUDE).join('\r\n').split('\n' + RESTART_MANAGER_INCLUDE).join('\n'));
ok(n1.length > 0, 'N1 删掉 RestartManager include → 判红');
const n2 = auditTemplate(templateText.replace(CHECK_CALL_RE, '!insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"'));
ok(n2.length > 0, 'N2 首参退回进程名（2.11.4 旧写法）→ 判红');
ok(pinnedVersionFromPackageText(pkgText.replace('"@tauri-apps/cli": "' + pin.raw + '"', '"@tauri-apps/cli": "^2"')).exact === null, 'N3 依赖改回浮动 ^2 → 判红');
ok((hv === null ? false : headerVersion(templateText.replace('@tauri-apps/cli ' + hv, '@tauri-apps/cli 2.11.4')) !== pin.exact), 'N4 头部标记漂移回旧版本 → 与钉版不一致判红');

section('F. CI 门禁自检');
const wf = fs.readFileSync(WORKFLOW, 'utf8');
ok(wf.includes('nsis-template-cli-version-contract.js'), 'build-tauri.yml 挂接了本契约测试（被摘掉即红）');

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
