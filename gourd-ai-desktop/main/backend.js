'use strict';

/**
 * backend.js - gourd-ai-agent JAR 子进程管理
 *
 * 参考 electron-egg 的 CrossProcess 设计：
 * - 通过 child_process.spawn 启动外部可执行程序（此处为 java -jar）
 * - 轮询 HTTP 健康检查等待后端就绪
 * - 应用退出时通过 tree-kill 清理子进程树
 */

const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const tkill = require('tree-kill');
const { migrateGlobalData } = require('./migration');
const { app } = require('electron');

// 子进程句柄
let child = null;
let childPid = 0;

/**
 * 获取内置资源目录（extraResources）
 * - 开发环境：项目根目录下的 build/extraResources/
 * - 打包后：process.resourcesPath/extraResources/（electron-builder extraResources 目标）
 */
function getResourcesDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'extraResources');
  }
  return path.join(__dirname, '..', 'build', 'extraResources');
}

/**
 * 运行时数据<b>基目录</b>：即 Java 侧 -Dgwork.home 的取值语义——
 * <b>不含</b> `.gwork` 子目录（AgentFlags.getHarnessBase() 拿到后自己再拼
 * harnessHome=".gwork/"，Node 侧绝不能预先拼，否则全局区会嵌套成 .gwork/.gwork，
 * 表现为重装后"配置被清空"——2026-08-08 复发事故的根因）。
 *
 * All platforms use the OS user home as the base; the resource directory is
 * only used for migration and bundled runtime assets.
 */
const { getRuntimeHomeDirFor, resolveUserHome } = require('./runtime-paths');

function getRuntimeHomeDir() {
  // 解析顺序集中在 runtime-paths.resolveUserHome，保证与 cli-provision 完全一致。
  return getRuntimeHomeDirFor({ userHome: resolveUserHome() });
}

/**
 * Windows/macOS/Linux development and packaged builds all use the OS user home
 * as the -Dgwork.home base. The resource directory is only a migration source
 * and the location of the bundled JRE/JAR.
 */
function migrateLegacyHarnessDirs() {
  try {
    const legacyRoots = [];
    if (process.platform === 'darwin') {
      const macAppData = app.getPath('appData');
      legacyRoots.push(path.join(macAppData, 'Gourd AI', '.gwork'));
      legacyRoots.push(path.join(macAppData, 'Gourd AI', '.gourdai'));
    }
    return migrateGlobalData({
      homeDir: getRuntimeHomeDir(),
      resourcesDir: getResourcesDir(),
      legacyRoots,
    });
  } catch (e) {
    console.warn('[gourd-ai-desktop] 全局目录迁移失败（保留 staging，不影响启动）:', e && e.message);
    return null;
  }
}

// 旧名兼容别名（历史测试脚本/外部引用可能仍用旧名）
const migrateNestedHarnessDir = migrateLegacyHarnessDirs;

/**
 * 定位 Java 可执行文件
 * 查找顺序：
 * 1. 内置 JRE（build/extraResources/jre/bin/java）——必须是「完整」的 JRE（含 bin/java）
 * 2. 环境变量 JAVA_EXEC（直接指定 java 路径）
 * 3. 环境变量 JAVA_HOME/bin/java
 * 4. 系统 PATH 中的 java
 * 5. 常见回退位置：IntelliJ 下载的 JDK（~/.jdks）、常见安装目录
 *
 * 注意：内置 JRE 若生成不完整（只有 legal/，缺 bin/），必须继续往后找，
 * 否则打包版找不到 Java → 后端不启动 → 所有 /web/** 接口失败。
 */
function findJava() {
  const fs = require('fs');
  const os = require('os');
  // Windows 用 javaw.exe（无控制台窗口），其他平台用 java
  const javaName = process.platform === 'win32' ? 'javaw.exe' : 'java';
  const javaConsole = process.platform === 'win32' ? 'java.exe' : 'java';

  // 在某个 java home 下找可执行文件（优先无窗口的 javaw，回退到 java）
  const javaInHome = (home) => {
    if (!home) return null;
    const a = path.join(home, 'bin', javaName);
    if (fs.existsSync(a)) return a;
    const b = path.join(home, 'bin', javaConsole);
    if (fs.existsSync(b)) return b;
    return null;
  };

  // 1. 内置 JRE（打包首选）
  const resDir = getResourcesDir();
  const bundledJava = javaInHome(path.join(resDir, 'jre'));
  if (bundledJava) {
    // macOS 产出 x64/arm64 双架构包，而 jlink 只生成构建机架构的 JRE：
    // 架构不符时 spawn 会报 EBADEXEC。这里快速验证可执行性，不可运行则回退系统 Java。
    if (process.platform !== 'darwin' || canExecuteJava(bundledJava)) {
      return bundledJava;
    }
    console.warn('[gourd-ai-desktop] 内置 JRE 无法在当前机器运行（架构不匹配？），回退系统 Java…');
  } else {
    console.warn('[gourd-ai-desktop] 内置 JRE 不可用（缺 bin/java），尝试系统 Java…');
  }

  // 2. JAVA_EXEC 环境变量
  if (process.env.JAVA_EXEC && fs.existsSync(process.env.JAVA_EXEC)) {
    return process.env.JAVA_EXEC;
  }

  // 3. JAVA_HOME/bin/java
  const jhJava = javaInHome(process.env.JAVA_HOME);
  if (jhJava) {
    return jhJava;
  }

  // 4. 系统 PATH 搜索
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidate = path.join(dir, javaName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const candidate2 = path.join(dir, javaConsole);
    if (fs.existsSync(candidate2)) {
      return candidate2;
    }
  }

  // 5. 常见回退位置（含 IntelliJ 下载的 JDK/JBR）
  const searchRoots = [];
  searchRoots.push(path.join(os.homedir(), '.jdks')); // IntelliJ
  if (process.platform === 'win32') {
    searchRoots.push('C:\\Program Files\\Eclipse Adoptium');
    searchRoots.push('C:\\Program Files\\Java');
    searchRoots.push('C:\\Program Files\\Microsoft');
    searchRoots.push('C:\\Program Files\\Zulu');
    searchRoots.push('C:\\Program Files\\Amazon Corretto');
  } else if (process.platform === 'darwin') {
    searchRoots.push('/Library/Java/JavaVirtualMachines');
  } else {
    searchRoots.push('/usr/lib/jvm');
  }

  for (const root of searchRoots) {
    if (!fs.existsSync(root)) continue;
    let entries;
    try {
      entries = fs.readdirSync(root).sort().reverse(); // 高版本优先
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      const home = path.join(root, entry);
      // macOS 的 .jdk 常见结构：<home>/Contents/Home/bin/java
      const found = javaInHome(home)
        || javaInHome(path.join(home, 'Contents', 'Home'));
      if (found) {
        console.log(`[gourd-ai-desktop] 使用系统 Java: ${found}`);
        return found;
      }
    }
  }

  return null;
}

/**
 * 快速验证 java 可执行文件能否在当前机器运行（macOS 架构不匹配时 exec 会抛 EBADEXEC）。
 */
function canExecuteJava(javaPath) {
  try {
    execFileSync(javaPath, ['-version'], { timeout: 3000, stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 定位内置 gourd-ai-agent.jar
 */
function findJar() {
  const resDir = getResourcesDir();
  const jarPath = path.join(resDir, 'gourd-ai-agent.jar');

  const fs = require('fs');
  if (fs.existsSync(jarPath)) {
    return jarPath;
  }
  return null;
}

/**
 * 在 127.0.0.1 随机分配一个可用端口（绑定 :0 后立即释放）
 * @returns {Promise<number>}
 */
function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/**
 * 轮询 GET /web/chat/meta 等待后端 HTTP 服务就绪
 * @param {number} port
 * @param {number} timeoutMs - 最大等待毫秒数
 * @returns {Promise<void>}
 */
function waitForBackend(port, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const intervalMs = 300;

    function check() {
      if (Date.now() > deadline) {
        return reject(new Error(`后端启动超时（${timeoutMs / 1000}秒）`));
      }

      const req = http.get(`http://127.0.0.1:${port}/web/chat/meta`, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          setTimeout(check, intervalMs);
        }
        // 消费掉响应体，避免 socket hang
        res.resume();
      });

      req.on('error', () => setTimeout(check, intervalMs));
      req.setTimeout(500, () => {
        req.destroy();
        setTimeout(check, intervalMs);
      });
    }

    check();
  });
}

/**
 * 启动 gourd-ai-agent JAR 子进程
 * @param {number} port
 * @returns {Promise<{pid: number, port: number}>}
 */
async function startBackend(port) {
  // 若已有存活进程，直接复用
  if (child && childPid > 0) {
    return { pid: childPid, port };
  }

  // 修正历史嵌套全局区 / 品牌升级旧目录（须在 Java 子进程启动前完成，避免新旧目录并发读写）
  migrateLegacyHarnessDirs();

  const java = findJava();
  const jar = findJar();

  if (!java) {
    throw new Error(
      `未找到可用的 Java 运行时\n` +
      `已尝试：内置 JRE(${path.join(getResourcesDir(), 'jre', 'bin')})、JAVA_EXEC、JAVA_HOME、系统 PATH、~/.jdks 及常见安装目录\n` +
      `请重新运行构建脚本生成内置 JRE（npm run generate-jre），或在系统安装 Java 17+ 并加入 PATH`
    );
  }
  if (!jar) {
    throw new Error(
      `未找到 gourd-ai-agent.jar\n预期路径: ${getResourcesDir()}\n` +
      `请先运行构建脚本复制 JAR 文件`
    );
  }

  // 文件日志级别：打包版仅输出 ERROR（DEBUG 日志量约百兆/天，配合 7 天滚动上限会膨胀到 ~700MB 撑爆磁盘）；
  // 开发版保持 app.yml 的 DEBUG 默认值便于排障；GWORK_LOG_LEVEL 环境变量可临时覆盖（如 GWORK_LOG_LEVEL=DEBUG）。
  // -D 系统属性优先级高于 app.yml（Solon 配置覆盖规则）。
  const fileLogLevel = process.env.GWORK_LOG_LEVEL || (app.isPackaged ? 'ERROR' : null);

  // JVM 内存参数：不设置时 JDK 按物理内存推导（32G 机器上 InitialHeap=528M / MaxHeap=8.4G，
  // GC 线程按核心数扩到 13 条），桌面单用户场景严重浪费。且 G1 默认只做 young/mixed GC，
  // 峰值后堆 committed 不会归还 OS —— 实测空闲 RSS 长期卡在 300-400M。
  // 改用 SerialGC + FreeRatio：无并发 GC 线程（空闲不烧 CPU），每次 GC 后按比例收缩并归还 OS。
  // 实测（真实 jar 启动后静置 20s）：RSS 232M -> 203M，线程 73 -> 42，峰值 250M 释放后可回落至 ~83M。
  // 注意：仅设 -Xms/-Xmx 而不配 MinHeapFreeRatio/MaxHeapFreeRatio 是负优化（实测反升至 341M）。
  const args = [
    '-Xms48m',
    '-Xmx512m',
    '-Xss512k',
    '-XX:+UseSerialGC',
    '-XX:MinHeapFreeRatio=10',
    '-XX:MaxHeapFreeRatio=25',
    '-XX:MaxMetaspaceSize=192m',
    '-XX:CompressedClassSpaceSize=64m',
    '-XX:ReservedCodeCacheSize=96m',
    '-XX:InitialCodeCacheSize=4m',
    '-XX:-UsePerfData',
    '-Dfile.encoding=UTF-8',
    '-Dsolon.boot.openBrowser=false',  // 禁止自动打开浏览器
    '-Dgwork.home=' + getRuntimeHomeDir(),  // 全局配置区根（与 ACP 子进程一致，保证读同一份全局配置）
  ];
  if (fileLogLevel) {
    args.push('-Dsolon.logging.appender.file.level=' + fileLogLevel);
  }
  if (process.env.GWORK_USAGE_ENDPOINT) {
    args.push('-Dgwork.usage.endpoint=' + process.env.GWORK_USAGE_ENDPOINT);
  }
  if (process.env.GWORK_USAGE_CLIENT_TOKEN) {
    args.push('-Dgwork.usage.client-token=' + process.env.GWORK_USAGE_CLIENT_TOKEN);
  }

  args.push('-jar', jar, 'web', String(port));

  // 日志文件：<基目录>/.gwork/logs/gwork-desktop-server.log（mac 上基目录为包外用户目录，避免写签名包）
  const logPath = getServerLogPath();
  const fs = require('fs');
  // 确保子进程工作目录存在（macOS 打包版基目录在用户目录，首次启动时可能尚不存在；
  // spawn 的 cwd 不存在会直接 ENOENT 失败）
  fs.mkdirSync(getRuntimeHomeDir(), { recursive: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  // 使用 fs.openSync 获取文件描述符，可直接传给 stdio
  const logFd = fs.openSync(logPath, 'a');

  const stdio = ['ignore', logFd, logFd];

  const safeArgs = args.map((arg) => {
    const token = process.env.GWORK_USAGE_CLIENT_TOKEN;
    if (token && arg === '-Dgwork.usage.client-token=' + token) {
      return '-Dgwork.usage.client-token=<redacted>';
    }
    return arg;
  });
  console.log(`[gourd-ai-desktop] 启动后端: ${java} ${safeArgs.join(' ')}`);

  // 显式清除可能影响 JVM classloader 的环境变量
  const cleanEnv = { ...process.env };
  delete cleanEnv.JAVA_TOOL_OPTIONS;

  child = spawn(java, args, {
    stdio,
    detached: false,
    windowsHide: true,
    cwd: getRuntimeHomeDir(),
    env: cleanEnv,
  });

  // 子进程启动后即可关闭父进程的 fd 副本（子进程已继承）
  try { fs.closeSync(logFd); } catch (e) { /* ignore */ }

  childPid = child.pid;
  console.log(`[gourd-ai-desktop] 后端进程 PID=${childPid}`);

  child.on('exit', (code, signal) => {
    console.log(`[gourd-ai-desktop] 后端进程退出 code=${code} signal=${signal}`);
    child = null;
    childPid = 0;
  });

  child.on('error', (err) => {
    console.error(`[gourd-ai-desktop] 后端进程错误: ${err.message}`);
    child = null;
    childPid = 0;
  });

  // spawn 错误（EACCES/EBADEXEC/ENOENT 等）快速失败：不等 60 秒健康检查超时，
  // 把真实原因（如 JRE 架构不符、权限丢失）直接抛给引导层展示。300ms 内无错误视为启动成功。
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener('error', onSpawnError);
      resolve();
    }, 300);
    function onSpawnError(err) {
      clearTimeout(timer);
      reject(new Error(`后端进程启动失败 (${java}): ${err.message}`));
    }
    child.once('error', onSpawnError);
  });

  return { pid: childPid, port };
}

/**
 * 停止后端进程（通过 tree-kill 清理整个进程树）
 * 等待进程真正退出后再 resolve，避免重启时资源冲突
 * @returns {Promise<void>}
 */
function stopBackend() {
  return new Promise((resolve) => {
    if (!child || childPid === 0) {
      return resolve();
    }

    const pid = childPid;
    const proc = child;
    child = null;
    childPid = 0;

    console.log(`[gourd-ai-desktop] 停止后端进程 PID=${pid}`);

    // 等待进程真正退出
    let exited = false;
    const onExit = () => {
      exited = true;
      resolve();
    };
    proc.once('exit', onExit);

    // 先发 SIGTERM
    tkill(pid, 'SIGTERM', (err) => {
      if (err) {
        tkill(pid, 'SIGKILL', () => {});
      }
    });

    // 最多等 3 秒，超时强制 SIGKILL 并继续
    setTimeout(() => {
      if (!exited) {
        proc.removeListener('exit', onExit);
        tkill(pid, 'SIGKILL', () => {});
        setTimeout(resolve, 500);
      }
    }, 3000);
  });
}

/**
 * 服务端日志路径
 * 服务端日志路径统一落用户全局区（基目录 + .gwork）；Windows packaged
 * 的基目录为用户主目录，因此日志位于 ~/.gwork/logs。
 */
function getServerLogPath() {
  return path.join(getRuntimeHomeDir(), '.gwork', 'logs', 'gwork-desktop-server.log');
}

module.exports = {
  findAvailablePort,
  startBackend,
  waitForBackend,
  stopBackend,
  getServerLogPath,
  getResourcesDir,
  getRuntimeHomeDir,
  migrateLegacyHarnessDirs,
  migrateNestedHarnessDir, // 旧名兼容别名
};
