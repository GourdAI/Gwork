'use strict';

/**
 * build-protected.js —— 带前端防反编译保护的完整打包编排（build:win/mac/linux 的真正入口）
 *
 * 步骤：
 *   1. prepare-resources：同步前端到 build/ui/ + 后端产物预检（JAR/JRE）；
 *   2. obfuscate-ui：原位混淆 build/ui/ 下的自有业务脚本；
 *   3. 快照 main/ → main-src-bak/，原位混淆 main/*.js（泄漏点④：asar 里的 Electron 主进程）；
 *   4. electron-builder 打包；
 *   5. finally：无条件还原 main/（源码树绝不能被污染）。
 *
 * 后端 gourd-ai-agent.jar 保持明文原样打包（2026-08-11 起放弃 jar 字节码加密，
 * 防反编译仅覆盖前端：ui 业务脚本 + Electron 主进程混淆）。
 *
 * 失败策略：任何一步失败都走 finally 还原后以非零码退出，绝不留下被污染的源码树。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MAIN_DIR = path.join(ROOT, 'main');
const MAIN_BAK = path.join(ROOT, 'main-src-bak');

const PLATFORM = process.argv[2] || 'win';

function runNode(script, args) {
  const argsAll = [path.join(__dirname, script)].concat(args || []);
  console.log('\n[build-protected] $ node ' + argsAll.join(' '));
  execFileSync(process.execPath, argsAll, { cwd: ROOT, stdio: 'inherit' });
}

// ── 1. 前端同步 ──
runNode('prepare-resources.js');

// ── 2. 前端混淆（对 build/ui 原位处理）──
runNode('obfuscate-ui.js');

// ── 3. main/ 快照 + 原位混淆 ──
let mainBackedUp = false;
try {
  fs.rmSync(MAIN_BAK, { recursive: true, force: true });
  fs.cpSync(MAIN_DIR, MAIN_BAK, { recursive: true });
  mainBackedUp = true;

  let obf;
  try {
    obf = require('javascript-obfuscator');
  } catch (e) {
    throw new Error('缺少依赖 javascript-obfuscator，请先运行 npm install');
  }
  const mainOptions = {
    compact: true,
    target: 'browser', // 只做语法层混淆；Node 全局由 renameGlobals=false 保护
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,        // process/require/__dirname 等一律不动
    stringArray: true,
    stringArrayThreshold: 0.6,
    stringArrayEncoding: ['base64'],
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.4,
    selfDefending: false,
    disableConsoleOutput: false,
    deadCodeInjection: false,
  };
  for (const f of fs.readdirSync(MAIN_DIR)) {
    if (!f.endsWith('.js')) continue;
    const fp = path.join(MAIN_DIR, f);
    const src = fs.readFileSync(fp, 'utf8');
    let code;
    try {
      code = obf.obfuscate(src, mainOptions).getObfuscatedCode();
    } catch (e) {
      throw new Error('混淆 main/' + f + ' 失败: ' + (e && e.message));
    }
    fs.writeFileSync(fp, code, 'utf8');
  }
  console.log('[build-protected] main/ 已原位混淆（源码快照: main-src-bak/）');

  // ── 4. electron-builder 打包 ──
  // 额外参数原样透传给 electron-builder（如 macOS 分架构打包的 --x64 / --arm64，
  // 不透传会导致每次打包都构建全部架构，两次换 JRE 的打包互相覆盖、产出错误 JRE 的包）
  const extraArgs = process.argv.slice(3);
  const bin = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
  const ebArgs = [bin, '--config', path.join(ROOT, 'cmd', 'builder-' + PLATFORM + '.json')].concat(extraArgs);
  console.log('\n[build-protected] $ electron-builder --config cmd/builder-' + PLATFORM + '.json' + (extraArgs.length > 0 ? ' ' + extraArgs.join(' ') : ''));
  execFileSync(process.execPath, ebArgs, { cwd: ROOT, stdio: 'inherit' });
} finally {
  // ── 5. 无条件还原：源码树绝不能被污染 ──
  if (mainBackedUp) {
    try {
      fs.rmSync(MAIN_DIR, { recursive: true, force: true });
      fs.renameSync(MAIN_BAK, MAIN_DIR);
      console.log('[build-protected] main/ 源码已还原');
    } catch (e) {
      console.error('[build-protected] 还原 main/ 失败！请手动从 main-src-bak/ 恢复: ' + e.message);
    }
  }
}

console.log('\n[build-protected] 打包完成，产物位于 ' + path.join(ROOT, 'out'));
