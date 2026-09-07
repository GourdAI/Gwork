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

// ─── 诊断状态（2026-09-06 去双盲改造）───────────────────────────────────────
// 覆盖安装后「接口一直不通」的故障之所以查不动，是因为：探针只认 200、
// 非 200 一律静默重试到超时，最终只留下一句「后端启动超时（60秒）」——
// 既看不出是 404（jar 与 UI 跨代）/ 503（被别的进程占了）/ 连接被拒（进程已死），
// 也看不出 java 是从哪个候选路径找到的。以下三项把这段黑盒变成可自证的现场。

/** 最近一次健康检查探针结果：{ ok, status, error } */
let lastProbe = null;
/** findJava 全链路探测明细（命中/落空逐条记录），失败时随错误文本一起上报 */
const javaProbeTried = [];
/** 后端子进程退出监听器（index.js 注册：状态复位 + 通知前端 + 自动重启） */
const exitHandlers = [];
/** 主动停止标记：stopBackend 引发的退出不触发自动重启 */
let stopping = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 当前后端进程 PID（0 表示无存活进程）。 */
function getBackendPid() {
  return childPid;
}

/** 后端 HTTP 服务进程是否存活。 */
function isBackendAlive() {
  return childPid > 0;
}

/** 最近一次探针结果（供状态详情展示；未探测过时为 null）。 */
function getLastProbe() {
  return lastProbe;
}

/**
 * 注册子进程退出回调：(info) => void
 * info = { pid, code, signal, expected }，expected=true 表示由 stopBackend 主动停止。
 */
function onBackendExit(handler) {
  if (typeof handler === 'function') exitHandlers.push(handler);
}

function fireBackendExit(info) {
  for (const h of exitHandlers) {
    try {
      h(info);
    } catch (e) {
      console.error('[gourd-ai-desktop] 后端退出回调异常:', e && e.message);
    }
  }
}

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

  javaProbeTried.length = 0;

  // 1. 内置 JRE（打包首选）
  const resDir = getResourcesDir();
  const bundledJava = javaInHome(path.join(resDir, 'jre'));
  if (bundledJava) {
    javaProbeTried.push(`内置 JRE: ${bundledJava} [命中]`);
    // macOS 产出 x64/arm64 双架构包，而 jlink 只生成构建机架构的 JRE：
    // 架构不符时 spawn 会报 EBADEXEC。这里快速验证可执行性，不可运行则回退系统 Java。
    if (process.platform !== 'darwin' || canExecuteJava(bundledJava)) {
      return bundledJava;
    }
    javaProbeTried[javaProbeTried.length - 1] = `内置 JRE: ${bundledJava} [不可执行，疑架构不匹配]`;
    console.warn('[gourd-ai-desktop] 内置 JRE 无法在当前机器运行（架构不匹配？），回退系统 Java…');
  } else {
    javaProbeTried.push(`内置 JRE: ${path.join(resDir, 'jre', 'bin')} [缺 bin/java]`);
    console.warn('[gourd-ai-desktop] 内置 JRE 不可用（缺 bin/java），尝试系统 Java…');
  }

  // 2. JAVA_EXEC 环境变量
  if (process.env.JAVA_EXEC) {
    if (fs.existsSync(process.env.JAVA_EXEC)) return process.env.JAVA_EXEC;
    javaProbeTried.push(`JAVA_EXEC: ${process.env.JAVA_EXEC} [路径不存在]`);
  } else {
    javaProbeTried.push('JAVA_EXEC: [未设置]');
  }

  // 3. JAVA_HOME/bin/java
  const jhJava = javaInHome(process.env.JAVA_HOME);
  if (jhJava) {
    return jhJava;
  }
  javaProbeTried.push(`JAVA_HOME: ${process.env.JAVA_HOME || '[未设置]'} [无 bin/java]`);

  // 4. 系统 PATH 搜索
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  let pathScanned = 0;
  for (const dir of pathDirs) {
    if (!dir) continue;
    pathScanned += 1;
    const candidate = path.join(dir, javaName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const candidate2 = path.join(dir, javaConsole);
    if (fs.existsSync(candidate2)) {
      return candidate2;
    }
  }
  javaProbeTried.push(`系统 PATH: 扫描 ${pathScanned} 个目录，未见 ${javaName}`);

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
    if (!fs.existsSync(root)) {
      javaProbeTried.push(`回退目录: ${root} [不存在]`);
      continue;
    }
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
    javaProbeTried.push(`回退目录: ${root} [${entries.length} 个子项均无 bin/java]`);
  }

  // 全链路落空：把逐条探测痕迹留下来，随错误文本一并透传到前端与日志。
  // 这是安装版「后端静默不启动」唯一的自证入口（对齐 Tauri 侧 backend.rs 的做法）。
  javaProbeTried.push(`extraResources = ${getResourcesDir()}`);
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
 * 单次健康检查探针。
 *
 * 关键修正：把「为什么没就绪」如实带回来（HTTP 状态码 / 网络错误码），
 * 而不是和以一样把所有非 200 一律折叠成「继续重试」。状态码本身就是诊断结论：
 *   0（连不上）= 端口没人监听（进程未起/已死/只绑了另一栈）
 *   404        = jar 与 UI 跳代（部分覆盖的典型痕迹）
 *   401/403    = 命了鉴权配置
 *   503        = 被另一个本地服务挡住
 * @param {number} port
 * @returns {Promise<{ok:boolean, status:number, error:string}>}
 */
function probeBackend(port) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (done) return; done = true; resolve(r); };

    const req = http.get(`http://127.0.0.1:${port}/web/chat/meta`, (res) => {
      const status = res.statusCode || 0;
      res.resume(); // 消费掉响应体，避免 socket hang
      finish({ ok: status === 200, status, error: '' });
    });

    req.on('error', (err) => finish({ ok: false, status: 0, error: err.code || err.message || String(err) }));
    req.setTimeout(500, () => {
      req.destroy();
      finish({ ok: false, status: 0, error: 'ETIMEDOUT(500ms)' });
    });
  });
}

/** 探针结果的人读描述（写日志与透传给前端横幅）。 */
function describeProbe(p) {
  if (!p) return '未探测';
  return p.status ? `HTTP ${p.status}` : `连接失败 ${p.error || 'unknown'}`;
}

/**
 * 轮询 GET /web/chat/meta 等待后端 HTTP 服务就绪
 * @param {number} port
 * @param {number} timeoutMs - 最大等待毫秒数
 * @returns {Promise<{status:number, attempts:number}>}
 */
async function waitForBackend(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  const intervalMs = 300;
  let attempts = 0;
  let last = null;

  for (;;) {
    // 进程已退出→立即失败。旧实现会对着一个死端口白等满 60 秒，
    // 期间界面所有接口固定 503，用户体感就是「彻底不通」。
    if (childPid === 0) {
      lastProbe = last;
      throw new Error(`后端进程未存活（启动后已退出）。最后探针结果: ${describeProbe(last)}；详见日志 ${getServerLogPath()}`);
    }

    last = await probeBackend(port);
    attempts += 1;
    lastProbe = last;

    if (last.ok) {
      console.log(`[gourd-ai-desktop] 健康检查通过: ${describeProbe(last)}（轮询 ${attempts} 次）`);
      return { status: last.status, attempts };
    }

    if (Date.now() > deadline) {
      throw new Error(
        `后端启动超时（${Math.round(timeoutMs / 1000)} 秒，轮询 ${attempts} 次）。` +
        `最后结果: ${describeProbe(last)}；端口: 127.0.0.1:${port}；PID=${childPid}。` +
        (last && last.status === 404
          ? '【诊断】探针返回 404：jar 与前端 UI 版本不一致，典型原因是覆盖安装时旧 jar 被占用未能替换，请卸载后重装。'
          : '')
      );
    }

    // 每 ~3 秒留一行进度，事后从日志能看出到底卡在哪个状态码
    if (attempts % 10 === 1) {
      console.log(`[gourd-ai-desktop] 等待后端就绪… ${describeProbe(last)}（第 ${attempts} 次）`);
    }
    await sleep(intervalMs);
  }
}

/**
 * 读取打包时生成的安装指纹清单 `extraResources/build-manifest.json`。
 * 缺失/损坏返回 null（老包无此件，不能因此误报）。
 */
function readBuildManifest() {
  const fs = require('fs');
  const p = path.join(getResourcesDir(), 'build-manifest.json');
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!obj || typeof obj.buildId !== 'string') return null;
    return obj;
  } catch (e) {
    return null;
  }
}

/** GET 一个 JSON 接口（仅用于启动期自检，不走代理）。 */
function httpGetJson(port, pathname, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${pathname}`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (e) {
          reject(new Error(`响应不是合法 JSON (${pathname}): ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`请求超时 (${pathname}, ${timeoutMs}ms)`));
    });
  });
}

/**
 * 安装一致性自检：把「jar 自报的 buildId」与「装包那一刻的快照」对一下。
 *
 * 为什么能抓到部分覆盖：覆盖安装时旧 javaw.exe 若仍持有 jre 映像，NSIS 删不掉旧
 * jar，升级「成功」但 jar 仍是上一个代的。表现就是接口莫名不通或行为错乱。
 * jar 内部带 buildId（构建期 filtering 写入），而清单在打包时拍快照，
 * 两者不等就只可能是「jar 没被真正替换」或「jar 与本壳不同源」。
 *
 * 刻意只报不阅：自检失败时后端其实是可用的，不能因此把状态置为 failed。
 * @returns {Promise<{ok:boolean, skipped?:string, expected?:string, actual?:string, reason?:string}>}
 */
async function verifyBuildIdentity(port) {
  const manifest = readBuildManifest();
  if (!manifest) {
    return { ok: true, skipped: 'no-manifest' };
  }

  let res;
  try {
    res = await httpGetJson(port, '/web/chat/meta');
  } catch (e) {
    return { ok: true, skipped: 'meta-unreachable: ' + (e && e.message) };
  }

  const data = (res.json && res.json.data) ? res.json.data : (res.json || {});
  const actual = typeof data.buildId === 'string' ? data.buildId : '';

  if (!actual) {
    // 旧 jar 根本不携带指纹——这就是「jar 比本安装包老」的铁证
    return {
      ok: false,
      expected: manifest.buildId,
      actual: '',
      reason: '运行中的后端 jar 不携带 buildId（早于构建指纹机制），说明它不是本安装包里的 jar。',
    };
  }
  if (actual !== manifest.buildId) {
    return {
      ok: false,
      expected: manifest.buildId,
      actual,
      reason: '运行中的后端与本安装包记录的构建指纹不一致，典型原因是覆盖安装时旧 jar 被占用未能替换。',
    };
  }
  return { ok: true, expected: manifest.buildId, actual };
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
      `探测明细：\n  ${javaProbeTried.join('\n  ')}\n` +
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
  const myPid = child.pid || 0;
  const thisChild = child;
  let exitFired = false;
  const fireOnce = (info) => {
    if (exitFired) return;
    exitFired = true;
    fireBackendExit(info);
  };
  console.log(`[gourd-ai-desktop] 后端进程 PID=${childPid}，java=${java}，jar=${jar}`);

  child.on('exit', (code, signal) => {
    console.log(`[gourd-ai-desktop] 后端进程退出 code=${code} signal=${signal}`);
    // 只清理自己的句柄：重启场景下旧进程的 exit 可能迟到，此时 child 已指向新进程
    if (child === thisChild) {
      child = null;
      childPid = 0;
    }
    fireOnce({ pid: myPid, code, signal, expected: !!thisChild.__expectedExit });
  });

  child.on('error', (err) => {
    console.error(`[gourd-ai-desktop] 后端进程错误: ${err.message}`);
    if (child === thisChild) {
      child = null;
      childPid = 0;
    }
    // spawn 失败（EACCES/ENOENT/EBADEXEC）不一定会伴随 exit 事件，这里必须也上报
    fireOnce({ pid: myPid, code: null, signal: null, expected: !!thisChild.__expectedExit, error: err.message });
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
    // 打上主动退出标记：退出监听器据此不触发自动重启（否则退出应用会被当作故障反复拉起后端）
    proc.__expectedExit = true;
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
  probeBackend,
  describeProbe,
  readBuildManifest,
  verifyBuildIdentity,
  getServerLogPath,
  getResourcesDir,
  getRuntimeHomeDir,
  getBackendPid,
  isBackendAlive,
  getLastProbe,
  onBackendExit,
  migrateLegacyHarnessDirs,
  migrateNestedHarnessDir, // 旧名兼容别名
};
