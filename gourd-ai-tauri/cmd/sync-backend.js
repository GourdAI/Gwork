#!/usr/bin/env node
'use strict';

/**
 * sync-backend.js —— 把后端产物同步到 Tauri 自己的 `gourd-ai-tauri/build/extraResources/`。
 *
 * ## 为什么要有这个脚本（2026-09-06 修正）
 * 之前 `src-tauri/tauri.conf.json` 的 bundle.resources 直接跨模块引用
 * `../../gourd-ai-desktop/build/extraResources/`，也就是**打 Tauri 包要先打 Electron 包**。
 * 三个问题：
 *   1. 语义错位：jar 的唯一来源是 `gourd-ai-agent/target/`，绕道 Electron 的暂存目录
 *      只是历史巧合，Tauri 对那份文件的新旧毫无控制权；
 *   2. 本地断链：`beforeBuildCommand` 里没有任何一步生成那份 jar，CI 靠 workflow 显式
 *      补了 Maven + cp，本地 `npm run build:win` 却没有 —— 于是本地要么打出陈旧 jar，
 *      要么被 gen-build-manifest 的同源校验拦下（实测 CLI_EXIT=1）；
 *   3. 卸载 Electron 模块即会连带打断 Tauri 打包。
 *
 * 现在 Tauri 有自己的暂存目录，jar **直接取自 Maven 产物**，与 Electron 完全解耦。
 *
 * ## 同步内容
 *   - `gourd-ai-agent/target/gourd-ai-agent.jar` → `build/extraResources/gourd-ai-agent.jar`
 *   - 内置 JRE：`build/extraResources/jre/`（缺失时用 jlink 现生成；模块清单与
 *     build.ps1 / build.sh / 两条 workflow 保持一致，改动必须四处同步）
 *
 * ## 用法
 *   node cmd/sync-backend.js              # 同步 jar，JRE 缺失则 jlink 生成
 *   node cmd/sync-backend.js --skip-jre   # 同步 jar + 校验 JRE 已存在（不生成）
 *   node cmd/sync-backend.js --jar-only   # 只同步 jar，完全不管 JRE
 *   GWORK_SKIP_JRE=1 node cmd/sync-backend.js   # 等同 --skip-jre
 *
 * 三者的差别在 CI 里很关键：流水线是「Maven → 同步 jar → jlink 出 JRE」，
 * 同步 jar 那一刻 JRE 还不存在，只能用 --jar-only；用 --skip-jre 会因「JRE 缺失」而失败。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(ROOT, '..');
const JAR_SOURCE = path.join(REPO_ROOT, 'gourd-ai-agent', 'target', 'gourd-ai-agent.jar');
const EXTRA_DIR = path.join(ROOT, 'build', 'extraResources');
const JAR_DEST = path.join(EXTRA_DIR, 'gourd-ai-agent.jar');
const JRE_DIR = path.join(EXTRA_DIR, 'jre');

// 与 gourd-ai-desktop/generate-jre.js、build.ps1、build.sh、两条 workflow 完全一致。
// 少一个模块的典型症状是运行期才抛 ClassNotFoundException，构建期完全看不出来。
const JLINK_MODULES = [
  'java.base',
  'java.logging',
  'java.sql',
  'java.naming',
  'java.management',
  'java.instrument',
  'java.net.http',
  'jdk.crypto.ec',
  'jdk.zipfs',
  'jdk.unsupported',
].join(',');

// 编译目标为 Java 17，内置 JRE 必须 >= 17，否则运行时 UnsupportedClassVersionError
const MIN_MAJOR = 17;

function fail(msg) {
  console.error('[sync-backend] 错误: ' + msg);
  process.exit(1);
}

function log(msg) {
  console.log('[sync-backend] ' + msg);
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// ── JAR 同步 ────────────────────────────────────────────────────────────────

function syncJar() {
  if (!fs.existsSync(JAR_SOURCE)) {
    fail(
      '未找到后端 JAR: ' + JAR_SOURCE
      + '\n  请先在仓库根执行 Maven 打包：'
      + '\n    mvn -B -ntp -pl gourd-ai-agent -am package -DskipTests'
    );
  }

  fs.mkdirSync(EXTRA_DIR, { recursive: true });
  // copyFileSync 是整文件覆盖写；目标被占用（如打包中）时会抛错并由上层 fail，
  // 不会留下半截文件。
  fs.copyFileSync(JAR_SOURCE, JAR_DEST);
  log('JAR 已同步: ' + JAR_DEST + ' (' + mb(fs.statSync(JAR_DEST).size) + ')');
}

// ── 内置 JRE ────────────────────────────────────────────────────────────────

/** 该目录下是否已有可用的 JRE（判据与 src/paths.rs::has_bundled_jre 对齐）。 */
function hasUsableJre(dir) {
  const names = process.platform === 'win32' ? ['javaw.exe', 'java.exe'] : ['java'];
  return names.some((n) => fs.existsSync(path.join(dir, 'bin', n)));
}

/** 从 <home>/release 解析主版本号；失败返回 0。 */
function readJdkMajor(home) {
  try {
    const m = fs.readFileSync(path.join(home, 'release'), 'utf8').match(/JAVA_VERSION="?(\d+)/);
    if (m) return parseInt(m[1], 10);
  } catch (e) { /* 无 release 文件视为不可用 */ }
  return 0;
}

function isUsableJdk(home) {
  if (!home) return false;
  const jlink = path.join(home, 'bin', process.platform === 'win32' ? 'jlink.exe' : 'jlink');
  return fs.existsSync(jlink) && readJdkMajor(home) >= MIN_MAJOR;
}

/** 在基目录下挑主版本号最高的可用 JDK。 */
function pickBestInDir(base) {
  if (!fs.existsSync(base)) return null;
  let best = null;
  let bestMajor = 0;
  let entries;
  try {
    entries = fs.readdirSync(base);
  } catch (e) {
    return null; // 无权限的目录直接跳过，不能让探测本身中断构建
  }
  for (const entry of entries) {
    const home = path.join(base, entry);
    if (!isUsableJdk(home)) continue;
    const major = readJdkMajor(home);
    if (major > bestMajor) {
      bestMajor = major;
      best = home;
    }
  }
  return best;
}

/** 查找可用 JDK（顺序与 gourd-ai-desktop/generate-jre.js 一致）。 */
function findJavaHome() {
  if (isUsableJdk(process.env.JAVA_HOME)) return process.env.JAVA_HOME;

  const fromIdea = pickBestInDir(path.join(os.homedir(), '.jdks'));
  if (fromIdea) return fromIdea;

  const commonPaths = process.platform === 'win32'
    ? [
        'C:\\Apps\\Java',
        'D:\\Apps\\Java',
        'C:\\Program Files\\Eclipse Adoptium',
        'C:\\Program Files\\Java',
        'C:\\Program Files\\Microsoft',
        'C:\\Program Files\\Zulu',
        'C:\\Program Files\\Amazon Corretto',
      ]
    : ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines'];

  for (const base of commonPaths) {
    const found = pickBestInDir(base);
    if (found) return found;
  }
  return null;
}

function ensureJre() {
  if (hasUsableJre(JRE_DIR)) {
    log('内置 JRE 已就位: ' + JRE_DIR);
    return;
  }

  const javaHome = findJavaHome();
  if (!javaHome) {
    fail(
      '缺少内置 JRE 且未找到可用 JDK（需要 JDK ' + MIN_MAJOR + '+，含 jlink）: ' + JRE_DIR
      + '\n  请设置 JAVA_HOME 指向 JDK ' + MIN_MAJOR + '+ 后重试，或用 --skip-jre 跳过'
      + '（跳过时必须自行保证该目录下有完整 JRE，否则打出的包无法启动后端）。'
    );
  }

  const jmods = path.join(javaHome, 'jmods');
  if (!fs.existsSync(jmods)) {
    fail('jmods 目录不存在（这可能是 JRE 而非 JDK）: ' + jmods);
  }

  log('未找到内置 JRE，用 jlink 生成中（JAVA_HOME=' + javaHome + '）...');
  // jlink 要求输出目录不存在
  fs.rmSync(JRE_DIR, { recursive: true, force: true });
  fs.mkdirSync(EXTRA_DIR, { recursive: true });

  const jlink = path.join(javaHome, 'bin', process.platform === 'win32' ? 'jlink.exe' : 'jlink');
  try {
    execFileSync(
      jlink,
      [
        '--module-path', jmods,
        '--add-modules', JLINK_MODULES,
        '--output', JRE_DIR,
        '--strip-debug', '--compress', '2', '--no-header-files', '--no-man-pages',
      ],
      { stdio: 'inherit' }
    );
  } catch (e) {
    fail('jlink 执行失败: ' + (e && e.message));
  }

  if (!hasUsableJre(JRE_DIR)) {
    fail('jlink 已执行但产物缺少 java 可执行文件: ' + path.join(JRE_DIR, 'bin'));
  }
  log('内置 JRE 生成完成: ' + JRE_DIR);
}

// ── 入口 ────────────────────────────────────────────────────────────────────

function main() {
  const jarOnly = process.argv.includes('--jar-only');
  const skipJre = process.argv.includes('--skip-jre') || process.env.GWORK_SKIP_JRE === '1';

  syncJar();

  if (jarOnly) {
    // CI 在 jlink 之前调用：此时 JRE 尚未生成，任何校验都会误报。
    log('仅同步 JAR（--jar-only），JRE 由调用方自行生成');
  } else if (skipJre) {
    // 调用方声称 JRE 已就绪（如 CI 的 jlink 步骤、macOS 按架构换入），这里只验证：
    // 缺 JRE 时 tauri bundler 会报一句晦涩的 resource 路径错误，不如在此点明。
    if (!hasUsableJre(JRE_DIR)) {
      fail(
        '--skip-jre 已指定，但 ' + JRE_DIR + ' 下没有可用的 java 可执行文件。'
        + '\n  请先用 jlink 生成内置 JRE 再打包，或改用 --jar-only 只同步 jar。'
      );
    }
    log('已跳过 JRE 生成（--skip-jre），现有 JRE 通过检查');
  } else {
    ensureJre();
  }
  log('后端产物同步完成: ' + EXTRA_DIR);
}

main();
