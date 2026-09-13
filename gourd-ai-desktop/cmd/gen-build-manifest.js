'use strict';

/**
 * gen-build-manifest.js —— 生成安装指纹清单 `extraResources/build-manifest.json`
 *
 * 为什么需要：覆盖安装时若残留的 javaw.exe 仍持有 `jre\bin\javaw.exe` 进程映像，
 * NSIS 既不能删除也不能改名 → 旧 jar 没被替换就「升级完成」，形成 jar/jre/ui
 * 新旧混合的**部分覆盖**。它不报错，只让接口莫名不通（2026-09-06 故障主链）。
 * 桌面端启动后把「jar 自报的 buildId」与本清单（装包那一刻的快照）比对，
 * 就能把这种隐性问题变成一句明确的「安装不完整，请卸载后重装」。
 *
 * 两种用法：
 *   1. 作为模块：`require('./gen-build-manifest').generate({ ... })`
 *      —— Electron 的 cmd/prepare-resources.js 走这条路。
 *   2. 作为 CLI：`node cmd/gen-build-manifest.js [--extra-dir <目录>]`
 *
 * 【Tauri 侧已拆分（2026-09-12）】Tauri 原先也执行本文件（跨模块写成
 * `node ../gourd-ai-desktop/cmd/gen-build-manifest.js --extra-dir ...`），现已在
 * gourd-ai-tauri/cmd/ 下另立自有副本（2026-09-06 起两端就各自持有暂存目录，并不共用）。
 * 本文件此后只服务 Electron：--extra-dir 的跨模块用法随之消失，默认值即本模块目录。
 *
 * buildId 取自 `gourd-ai-agent/target/classes/build-info.properties`：它与 jar 出自
 * 同一次 mvn 产物（会被复制进 jar 内 BOOT-INF/classes/），因此无需在 Node 侧解 zip。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_EXTRA = path.join(__dirname, '..', 'build', 'extraResources');
const BUILD_INFO_PROPS = path.join(REPO_ROOT, 'gourd-ai-agent', 'target', 'classes', 'build-info.properties');
const TARGET_JAR = path.join(REPO_ROOT, 'gourd-ai-agent', 'target', 'gourd-ai-agent.jar');
const JAR_NAME = 'gourd-ai-agent.jar';

/**
 * 确认「即将进包的 jar」就是「本次 mvn 产物」。不同源时直接失败。
 *
 * 这条校验是现场踩出来的：若只拿 target/classes 的 buildId 去描述
 * build/extraResources 里那份可老 jar，清单本身就会变成“新旧混合”的假凭证
 * （实测发生过：extraResources 里的 jar 早于指纹机制，内部根本无 build-info.properties）。
 * 宁可打包失败，也不能交出一份自相矛盾的指纹。
 *
 * 【判据必须是内容而不是时间戳】早先用的是 `size 相同 && |mtime 差| <= 2s`，
 * 但两条流水线复制 jar 用的都是 `cp -f`（见 .github/workflows/build.yml 与
 * build-tauri.yml），而 cp **不保留 mtime**（要保留得写 `cp -p`）。于是目标文件的
 * mtime 是「复制那一刻」，与 Maven 产物相差整个打包耗时，远超 2 秒 —— 同一份 jar 会被
 * 判成「不同源」并 throw，prepare-resources.js 捕获后 process.exit(1)，直接打断打包。
 * 改用 sha256 逐字节比对：既消除误报，又比 size+mtime 更严格（size 相同但内容不同也能抓出）。
 * @returns {string} 进包 jar 的 sha256（顺带复用，避免重复读取整个 jar）
 */
function assertJarSameSource(jarPath) {
  const packedBuf = fs.readFileSync(jarPath);
  const packedSha = crypto.createHash('sha256').update(packedBuf).digest('hex');

  if (!fs.existsSync(TARGET_JAR)) {
    console.warn('[gen-build-manifest] 未找到 ' + TARGET_JAR + '，跳过同源性校验（CI 已清理 target 时属正常）');
    return packedSha;
  }

  const builtSha = crypto.createHash('sha256').update(fs.readFileSync(TARGET_JAR)).digest('hex');
  if (packedSha !== builtSha) {
    throw new Error(
      '进包 jar 与本次 Maven 产物不同源，拒绝生成指纹清单：\n'
      + `  ${jarPath}\n    size=${packedBuf.length} sha256=${packedSha}\n`
      + `  ${TARGET_JAR}\n    size=${fs.statSync(TARGET_JAR).size} sha256=${builtSha}\n`
      + '  请先执行 Maven 打包再复制 jar（Windows: gourd-ai-desktop/build.ps1；Unix: build.sh）。'
    );
  }
  return packedSha;
}

/** 极简 .properties 解析（只需 key=value，忽略注释与空行）。 */
function parseSimpleProps(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function readBuildInfo() {
  try {
    return parseSimpleProps(fs.readFileSync(BUILD_INFO_PROPS, 'utf8'));
  } catch (e) {
    return {};
  }
}

/**
 * 生成清单。
 * @param {object} [opts]
 * @param {string} [opts.extraDir]  extraResources 目录
 * @param {string} [opts.desktopVersion]  桌面壳版本（仅记录，不参与运行期比对）
 * @param {(msg:string)=>void} [opts.log]  日志回调，默认 console
 * @returns {{manifest:object, file:string}}
 */
function generate(opts = {}) {
  const extraDir = opts.extraDir || DEFAULT_EXTRA;
  const log = opts.log || ((msg) => console.log(msg));
  const jarPath = path.join(extraDir, JAR_NAME);

  if (!fs.existsSync(jarPath)) {
    throw new Error(`未找到后端 JAR: ${jarPath}`);
  }
  // 先验同源性：否则清单里的 buildId 与 sha256 会描述两份不同的 jar
  const jarSha256 = assertJarSameSource(jarPath);

  const build = readBuildInfo();
  // 读不到（未开 filtering 的老构建 / 纯 UI 重打包）时记为 unknown：
  // 运行期会把「jar 不携带 buildId」本身当成旧版信号，比静默跳过更有用。
  const buildId = build['build.id'] || 'unknown';
  if (buildId === 'unknown') {
    log('[gen-build-manifest] 警告: 未能从 ' + BUILD_INFO_PROPS + ' 读到 build-info.properties，'
      + '清单 buildId=unknown。请先执行 Maven 打包（solon-maven-plugin 会带出被 filtering 的资源）。');
  }

  let desktopVersion = opts.desktopVersion || 'unknown';
  if (!opts.desktopVersion) {
    try {
      desktopVersion = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
      ).version || 'unknown';
    } catch (e) { /* 保留 unknown */ }
  }

  const manifest = {
    schema: 1,
    buildId,
    buildTime: build['build.time'] || 'unknown',
    buildVersion: build['build.version'] || 'unknown',
    buildRevision: build['build.revision'] || 'unknown',
    jarFile: JAR_NAME,
    jarSize: fs.statSync(jarPath).size,
    // 复用同源校验里已经算过的摘要，避免把整个 jar 再读一遍
    jarSha256,
    desktopVersion,
    generatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(extraDir, { recursive: true });
  const file = path.join(extraDir, 'build-manifest.json');
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  log('[gen-build-manifest] 安装指纹清单已生成: ' + file
    + ` (buildId=${manifest.buildId}, jarSize=${manifest.jarSize})`);

  return { manifest, file };
}

module.exports = { generate, parseSimpleProps, BUILD_INFO_PROPS, JAR_NAME };

// ── CLI 入口 ─────────────────────────────────────────────────────────────────
if (require.main === module) {
  try {
    // --extra-dir：让调用方指定 extraResources 目录（Tauri 传自己的，不再写 Electron 的）。
    // 相对路径按**进程 cwd** 解析：beforeBuildCommand 的 cwd 是 gourd-ai-tauri/，
    // 写 `--extra-dir build/extraResources` 才能如字面所期。
    const i = process.argv.indexOf('--extra-dir');
    if (i !== -1 && !process.argv[i + 1]) {
      throw new Error('--extra-dir 缺少参数值');
    }
    const extraDir = i === -1 ? undefined : path.resolve(process.cwd(), process.argv[i + 1]);
    generate(extraDir ? { extraDir } : {});
  } catch (e) {
    console.error('[gen-build-manifest] 错误: ' + (e && e.message));
    process.exit(1);
  }
}
