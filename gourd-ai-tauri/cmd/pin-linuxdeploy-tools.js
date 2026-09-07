#!/usr/bin/env node
/* ============================================================
   Linux 打包前置：把 tauri-bundler 会「临时联网下载」的 AppImage 输出插件
   预先钉到固定版本，消除「同一条命令上周能过、这周挂」的随机性。

   ── 为什么需要这一步 ──
   tauri-bundler 的 prepare_tools() 在打 AppImage 前会往工具目录放 5 个文件，
   全部遵循「文件不存在才下载」（`if !xxx.exists()`）：

     AppRun-<arch>                        tauri-apps/binary-releases @apprun-old   固定 tag
     linuxdeploy-<arch>.AppImage          tauri-apps/binary-releases @linuxdeploy  固定 tag（2024-07-26 构建）
     linuxdeploy-plugin-gtk.sh            2.11.x 起 include_bytes! 内联，不再联网
     linuxdeploy-plugin-gstreamer.sh      同上
     linuxdeploy-plugin-appimage.AppImage linuxdeploy/... @continuous  ★滚动 tag，会漂移★

   只有最后一个是 `continuous`：上游每次重建，所有 Tauri 项目当天就换了一份新二进制。
   而 Tauri 自带的 linuxdeploy 是 2024 年的老构建，新插件一旦与它不兼容，linuxdeploy
   就非零退出。更糟的是 tauri-bundler 在**非 verbose** 模式下走的是：

       if !cmd.output()?.status.success() {
           return Err(GenericError("failed to run linuxdeploy"));   // stderr 整份丢弃
       }

   即把 linuxdeploy 的输出捕获后直接扔掉，CI 只剩一句毫无内容的
   `failed to run linuxdeploy`，无从定位。（verbose 模式下走 output_ok()，
   会流式打印，且报错文案变成 `failed to run /path/to/linuxdeploy-x86_64.AppImage`
   ——带路径。所以「有没有路径」本身就能判断日志是否被吞。）

   预置固定版本后，`if !appimage.exists()` 判定为「已存在」→ 跳过下载 →
   用的就是我们钉住的那份，构建结果不再随上游漂移。

   ── 文件名陷阱（照抄 URL 会白钉）──
   下载 URL 带架构后缀：linuxdeploy-plugin-appimage-x86_64.AppImage
   落盘文件名**不带**：   linuxdeploy-plugin-appimage.AppImage
   钉错名字 tauri 认不出，照样去下 continuous。

   ── 失败策略：本脚本的任何故障都不允许阻断打包 ──
   两层含义，第二层是 2026-09-07 的事故换来的：
     1. 下载失败只告警不阻断 —— tauri 自己就把这个插件当可选项
        （"linuxdeploy will fall back to its built-in version if the download failed"），
        钉版失败时退回原行为（让 tauri 去下 continuous）比整个构建挂掉更可取。
     2. **脚本自身的 bug 也只告警不阻断**。上一版把「下载失败降级」写在循环内的
        try/catch 里，而顶层 main().catch() 仍是 exit 1 —— 于是一个 resolveToolsDir()
        的 TypeError 直接把 Linux job 干红，连 deb 都出不来。现在整个执行体被包住，
        非 --self-test / --plan 模式下一律降级为 ::warning:: 并 exit 0。
        自检模式（--self-test / --plan）相反：必须响亮失败，那是给人排查用的。

   ── 事故记录（2026-09-07，务必读懂再改这个文件）──
   原写法：
       function resolveToolsDir({ ..., homedir = os.homedir() }) {   // ← 带括号，求值成字符串
           ... path.join(homedir(), '.cache');                       // ← 却当函数调 → TypeError
   它躲过了两道防线：
     · 本机是 Windows，resolveArch() 返回 null，main() 提前 return，**这行代码从未被执行**；
     · 单测里每个用例都显式注入了 homedir 覆写，**默认分支一次都没走到**。
   两条防线同时失效 → 24 项断言全绿，CI 第一行就崩。
   因此本文件现在自带 --self-test，且其中第一条断言**明令禁止注入 homedir**，
   同时用 --platform/--arch 让 Linux-only 路径能在任意平台真实跑通。
   该自检挂在三条平台腿的公共步骤上（见 .github/workflows/build-tauri.yml），
   Windows / macOS runner 也会执行 —— 谁再写出「只在 Linux 崩」的代码，当场就红。

    用法：
      node cmd/pin-linuxdeploy-tools.js                实际下载并落盘
      node cmd/pin-linuxdeploy-tools.js --plan         只打印计划，不联网不落盘
      node cmd/pin-linuxdeploy-tools.js --force        已存在也重新下载覆盖
      node cmd/pin-linuxdeploy-tools.js --self-test    跑内置断言（任意平台，不联网）
    退出码约定：
      0  成功，或打包路径上降级（降级会打 ::warning::）
      1  --self-test / --plan 模式下失败
      2  参数用法错误（任何模式下都响亮失败，不降级）
   可组合（在非 Linux 机器上验证 Linux 逻辑）：
     node cmd/pin-linuxdeploy-tools.js --plan --platform=linux --arch=x64
   环境变量：
     GWORK_LINUXDEPLOY_PLUGIN_APPIMAGE_VERSION    覆盖钉住的 tag（排查上游回归时用来 A/B）
   ============================================================ */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const MODULE_DIR = path.resolve(__dirname, '..');
const SRC_TAURI_DIR = path.join(MODULE_DIR, 'src-tauri');

/** 架构名映射：Node 的 process.arch → AppImage 生态用的 uname -m 风格名 */
const ARCH_MAP = { x64: 'x86_64', arm64: 'aarch64', ia32: 'i386' };

/**
 * 钉住的版本。
 * `continuous` 是滚动 tag（实测 2026-06-07 刚重建过）；下面这个是上游最近的一个
 * 不可变 tag，时间上与 tauri 自带的 2024-07 linuxdeploy 更接近，兼容性风险最低。
 */
const DEFAULT_PLUGIN_VERSION = '1-alpha-20250213-1';

/** 布尔开关型参数 */
const BOOL_FLAGS = ['--plan', '--force', '--self-test'];
/** 取值型参数（--key=value） */
const VALUE_FLAGS = ['--platform', '--arch'];

function resolvePinned(env = process.env) {
  return {
    appimagePlugin: (env.GWORK_LINUXDEPLOY_PLUGIN_APPIMAGE_VERSION || DEFAULT_PLUGIN_VERSION).trim(),
  };
}

/** 非 Linux 平台返回 null —— 这些工具只在 Linux 打 AppImage 时才需要 */
function resolveArch(platform = process.platform, nodeArch = process.arch) {
  if (platform !== 'linux') return null;
  const arch = ARCH_MAP[nodeArch];
  if (!arch) {
    throw new Error(`不支持的 Node 架构: ${nodeArch}（无法映射到 AppImage 架构名）`);
  }
  return arch;
}

/**
 * 把 homedir 归一成字符串。
 * 函数引用、字符串都接受 —— 这是刻意的宽容：上一版事故的形态正是「默认值是字符串、
 * 调用点当函数用」。两个方向都容错，就不会再因为传错形态而崩。
 */
function normalizeHomedir(value) {
  if (typeof value === 'function') return value();
  if (typeof value === 'string' && value.trim() !== '') return value;
  return os.homedir();
}

/**
 * tauri-bundler 的工具目录：
 *   bundle.useLocalToolsDir = true → <src-tauri>/target/.tauri
 *   否则（默认）                   → ${XDG_CACHE_HOME:-~/.cache}/tauri
 *
 * 注意默认值必须是【函数引用】os.homedir，不是 os.homedir()。
 */
function resolveToolsDir({ srcTauriDir = SRC_TAURI_DIR, useLocalToolsDir = false, env = process.env, homedir = os.homedir } = {}) {
  if (useLocalToolsDir) return path.join(srcTauriDir, 'target', '.tauri');
  const cache = env && typeof env.XDG_CACHE_HOME === 'string' && env.XDG_CACHE_HOME.trim() !== ''
    ? env.XDG_CACHE_HOME.trim()
    : path.join(normalizeHomedir(homedir), '.cache');
  return path.join(cache, 'tauri');
}

/** 从 tauri.conf.json 读 useLocalToolsDir（缺省 false），读不到就当 false 并告警 */
function readUseLocalToolsDir(srcTauriDir = SRC_TAURI_DIR) {
  const confPath = path.join(srcTauriDir, 'tauri.conf.json');
  try {
    const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
    return !!(conf.bundle && conf.bundle.useLocalToolsDir);
  } catch (err) {
    console.error(`[pin-tools] 警告：读不到 ${confPath}（${err.message}），按默认 useLocalToolsDir=false 处理`);
    return false;
  }
}

/**
 * 生成钉版计划。
 * 目前只钉 appimage 输出插件这一个漂移源；linuxdeploy 本体与 AppRun 都来自
 * tauri 自己仓库的固定 tag，gtk/gstreamer 插件脚本在 2.11.x 已内联，均无需处理。
 */
function planFor({ arch, toolsDir, pinned = resolvePinned() }) {
  return [
    {
      key: 'linuxdeploy-plugin-appimage',
      dest: path.join(toolsDir, 'linuxdeploy-plugin-appimage.AppImage'),
      url:
        `https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/` +
        `${pinned.appimagePlugin}/linuxdeploy-plugin-appimage-${arch}.AppImage`,
      version: pinned.appimagePlugin,
      optional: true,
      why: '上游用滚动 tag continuous，与 tauri 自带的 2024 版 linuxdeploy 不兼容时会让 AppImage 打包直接失败',
    },
  ];
}

/**
 * 解析出本次要用的完整上下文（不联网、不落盘）。
 * 单独抽出来是为了让 Linux-only 的整条解析链能在任意平台被真实执行 —— 这正是
 * 上一版事故里缺失的能力：本机跑不到，就等于没测过。
 */
function collectContext({ platform = process.platform, nodeArch = process.arch, env = process.env, srcTauriDir = SRC_TAURI_DIR } = {}) {
  const arch = resolveArch(platform, nodeArch);
  if (!arch) return null;
  const useLocalToolsDir = readUseLocalToolsDir(srcTauriDir);
  const toolsDir = resolveToolsDir({ srcTauriDir, useLocalToolsDir, env });
  return { arch, toolsDir, useLocalToolsDir, plan: planFor({ arch, toolsDir, pinned: resolvePinned(env) }) };
}

/** 跟随重定向的下载（GitHub release 资产会 302 到 objects.githubusercontent.com） */
function download(url, { redirectsLeft = 5 } = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'gwork-pin-linuxdeploy-tools' } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`重定向次数过多: ${url}`));
          return;
        }
        const next = new URL(res.headers.location, url).toString();
        download(next, { redirectsLeft: redirectsLeft - 1 }).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status}: ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** 与 tauri-bundler 的 write_and_make_executable 等价：落盘 + 加可执行位 */
function writeExecutable(dest, data) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, data);
  fs.chmodSync(dest, 0o755);
}

/* ============================================================
   内置自检：任意平台可跑，不联网、不落盘到仓库
   ============================================================ */

function runSelfTest() {
  const failures = [];
  let passed = 0;

  const eq = (actual, expected, what) => {
    if (actual !== expected) {
      throw new Error(`${what || '值'} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
    }
  };
  const check = (name, fn) => {
    try {
      fn();
      passed += 1;
      console.log(`  ok   ${name}`);
    } catch (err) {
      failures.push(`${name} → ${err.message}`);
      console.log(`  FAIL ${name} → ${err.message}`);
    }
  };
  const throws = (fn, needle, what) => {
    let msg = null;
    try { fn(); } catch (err) { msg = err.message; }
    if (msg === null) throw new Error(`${what || '该调用'} 应当抛错，但没有`);
    if (needle && !msg.includes(needle)) {
      throw new Error(`${what || '错误信息'} 应含 ${JSON.stringify(needle)}，实际 ${JSON.stringify(msg)}`);
    }
  };

  console.log(`[pin-tools] 自检开始（宿主平台 ${process.platform}/${process.arch}）`);

  /* ---- 1. ★回归守卫：绝对不注入 homedir★ ---- */
  // 上一版事故的唯一形态就是「默认分支未被执行」。这三条断言刻意不传 homedir，
  // 甚至第三条连参数对象都不传，把所有默认值（含 os.homedir）全部走一遍。
  check('resolveToolsDir 默认分支：不注入 homedir（事故复现点）', () => {
    const got = resolveToolsDir({ srcTauriDir: SRC_TAURI_DIR, useLocalToolsDir: false, env: {} });
    if (typeof got !== 'string') throw new Error(`应返回字符串，实际 ${typeof got}`);
    if (!path.isAbsolute(got)) throw new Error(`应返回绝对路径，实际 ${got}`);
    eq(path.basename(got), 'tauri', '末级目录名');
    if (!got.includes('.cache')) throw new Error(`未设 XDG_CACHE_HOME 时应落在 .cache 下，实际 ${got}`);
  });

  check('resolveToolsDir 零参数调用（所有默认值都要能求值）', () => {
    const got = resolveToolsDir();
    if (!path.isAbsolute(got)) throw new Error(`应返回绝对路径，实际 ${got}`);
    eq(path.basename(got), 'tauri', '末级目录名');
  });

  /* ---- 2. homedir 的两种形态都接受（防御性宽容） ---- */
  check('resolveToolsDir：homedir 传函数引用', () => {
    const got = resolveToolsDir({ srcTauriDir: '/st', useLocalToolsDir: false, env: {}, homedir: () => '/home/fn' });
    eq(got, path.join('/home/fn', '.cache', 'tauri'), '工具目录');
  });

  check('resolveToolsDir：homedir 传字符串（不再当函数调）', () => {
    const got = resolveToolsDir({ srcTauriDir: '/st', useLocalToolsDir: false, env: {}, homedir: '/home/str' });
    eq(got, path.join('/home/str', '.cache', 'tauri'), '工具目录');
  });

  check('resolveToolsDir：homedir 传空串/空白 → 回落 os.homedir 而不是产出畸形路径', () => {
    const got = resolveToolsDir({ srcTauriDir: '/st', useLocalToolsDir: false, env: {}, homedir: '   ' });
    if (!path.isAbsolute(got)) throw new Error(`应回落为绝对路径，实际 ${got}`);
    if (!got.includes('.cache')) throw new Error(`应含 .cache，实际 ${got}`);
  });

  /* ---- 3. XDG_CACHE_HOME 优先级与 useLocalToolsDir ---- */
  check('resolveToolsDir：XDG_CACHE_HOME 优先于 homedir', () => {
    const got = resolveToolsDir({
      srcTauriDir: '/st', useLocalToolsDir: false,
      env: { XDG_CACHE_HOME: '/xdg/cache' }, homedir: () => '/home/ignored',
    });
    eq(got, path.join('/xdg/cache', 'tauri'), '工具目录');
  });

  check('resolveToolsDir：XDG_CACHE_HOME 为空白串时回落 homedir', () => {
    const got = resolveToolsDir({
      srcTauriDir: '/st', useLocalToolsDir: false,
      env: { XDG_CACHE_HOME: '  ' }, homedir: () => '/home/fallback',
    });
    eq(got, path.join('/home/fallback', '.cache', 'tauri'), '工具目录');
  });

  check('resolveToolsDir：useLocalToolsDir → <src-tauri>/target/.tauri', () => {
    const got = resolveToolsDir({ srcTauriDir: '/st', useLocalToolsDir: true, env: { XDG_CACHE_HOME: '/xdg' } });
    eq(got, path.join('/st', 'target', '.tauri'), '工具目录');
  });

  /* ---- 4. 架构映射 ---- */
  check('resolveArch：linux/x64 → x86_64', () => eq(resolveArch('linux', 'x64'), 'x86_64', 'arch'));
  check('resolveArch：linux/arm64 → aarch64', () => eq(resolveArch('linux', 'arm64'), 'aarch64', 'arch'));
  check('resolveArch：linux/ia32 → i386', () => eq(resolveArch('linux', 'ia32'), 'i386', 'arch'));
  check('resolveArch：win32 / darwin → null（不需要这些工具）', () => {
    eq(resolveArch('win32', 'x64'), null, 'win32');
    eq(resolveArch('darwin', 'arm64'), null, 'darwin');
  });
  check('resolveArch：linux + 未知架构必须抛错（不能静默钉错包）', () => {
    throws(() => resolveArch('linux', 'ppc64'), '不支持的 Node 架构', '未知架构');
  });

  /* ---- 5. 计划内容：文件名陷阱 + 绝不出现 continuous ---- */
  check('planFor：落盘名不带架构后缀、URL 带架构后缀', () => {
    const [item] = planFor({ arch: 'x86_64', toolsDir: '/tools' });
    eq(path.basename(item.dest), 'linuxdeploy-plugin-appimage.AppImage', '落盘文件名');
    if (item.dest.includes('x86_64')) throw new Error(`落盘名不应含架构后缀：${item.dest}`);
    if (!item.url.endsWith('/linuxdeploy-plugin-appimage-x86_64.AppImage')) {
      throw new Error(`URL 应以带架构后缀的资产名结尾：${item.url}`);
    }
  });

  check('planFor：URL 绝不出现滚动 tag continuous', () => {
    for (const arch of ['x86_64', 'aarch64', 'i386']) {
      const [item] = planFor({ arch, toolsDir: '/tools' });
      if (item.url.includes('continuous')) throw new Error(`${arch}: URL 含 continuous → ${item.url}`);
      if (item.url.includes(DEFAULT_PLUGIN_VERSION) === false) {
        throw new Error(`${arch}: URL 未含钉住的版本 ${DEFAULT_PLUGIN_VERSION} → ${item.url}`);
      }
    }
  });

  check('planFor：插件标记为 optional（失败可降级）', () => {
    const [item] = planFor({ arch: 'x86_64', toolsDir: '/tools' });
    eq(item.optional, true, 'optional');
    if (!item.why || item.why.length < 10) throw new Error('缺少 why 说明，排查时无法理解为何钉版');
  });

  check('resolvePinned：env 可覆盖且去空白', () => {
    eq(resolvePinned({}).appimagePlugin, DEFAULT_PLUGIN_VERSION, '默认 tag');
    eq(resolvePinned({ GWORK_LINUXDEPLOY_PLUGIN_APPIMAGE_VERSION: '  v9  ' }).appimagePlugin, 'v9', '覆盖后');
  });

  /* ---- 6. readUseLocalToolsDir 的容错 ---- */
  check('readUseLocalToolsDir：目录不存在时不抛错，回落 false', () => {
    const missing = path.join(os.tmpdir(), `pin-tools-missing-${process.pid}-${Date.now()}`);
    eq(readUseLocalToolsDir(missing), false, '缺失时');
  });

  check('readUseLocalToolsDir：真实 src-tauri/tauri.conf.json 可读且不抛错', () => {
    const got = readUseLocalToolsDir(SRC_TAURI_DIR);
    eq(typeof got, 'boolean', '返回类型');
  });

  /* ---- 7. ★整条 Linux 解析链在任意平台真实跑通（不联网）★ ---- */
  // 这是上一版最缺的能力：Windows 上 main() 提前 return，Linux 逻辑等于零覆盖。
  check('collectContext：在宿主平台上模拟 linux/x64，整条链可跑通', () => {
    const fakeCache = path.join(os.tmpdir(), `pin-tools-selftest-${process.pid}`);
    const ctx = collectContext({
      platform: 'linux', nodeArch: 'x64',
      env: { XDG_CACHE_HOME: fakeCache },
      srcTauriDir: SRC_TAURI_DIR,
    });
    if (!ctx) throw new Error('模拟 linux 时不应返回 null');
    eq(ctx.arch, 'x86_64', 'arch');
    eq(ctx.toolsDir, path.join(fakeCache, 'tauri'), 'toolsDir');
    eq(ctx.plan.length, 1, '计划条数');
    if (!ctx.plan[0].dest.startsWith(path.join(fakeCache, 'tauri'))) {
      throw new Error(`落盘路径应位于模拟的缓存目录下：${ctx.plan[0].dest}`);
    }
  });

  check('collectContext：宿主非 Linux 时返回 null（不误钉）', () => {
    eq(collectContext({ platform: 'win32', nodeArch: 'x64' }), null, 'win32');
    eq(collectContext({ platform: 'darwin', nodeArch: 'arm64' }), null, 'darwin');
  });

  /* ---- 8. 参数解析 ---- */
  check('parseArgv：布尔开关、--key=value、未知参数拒绝', () => {
    const a = parseArgv(['--plan', '--platform=linux', '--arch=x64']);
    eq(a.planOnly, true, 'planOnly');
    eq(a.platform, 'linux', 'platform');
    eq(a.nodeArch, 'x64', 'nodeArch');
    throws(() => parseArgv(['--oops']), '未知参数', '未知参数');
    throws(() => parseArgv(['--platform']), '缺少取值', '--platform 无值');
  });

  console.log(`[pin-tools] 自检结束：${passed} 通过，${failures.length} 失败`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`[pin-tools]   ✗ ${f}`);
    return 1;
  }
  console.log('[pin-tools] 全部断言通过');
  return 0;
}

/* ============================================================
   入口
   ============================================================ */

function parseArgv(argv) {
  const out = { planOnly: false, force: false, selfTest: false, platform: null, nodeArch: null };
  for (const raw of argv) {
    const [name, value] = raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, null];
    if (BOOL_FLAGS.includes(name)) {
      if (value !== null) throw new Error(`${name} 是开关型参数，不接受取值`);
      if (name === '--plan') out.planOnly = true;
      if (name === '--force') out.force = true;
      if (name === '--self-test') out.selfTest = true;
      continue;
    }
    if (VALUE_FLAGS.includes(name)) {
      if (!value || value.trim() === '') throw new Error(`${name} 缺少取值，应写成 ${name}=<value>`);
      if (name === '--platform') out.platform = value.trim();
      if (name === '--arch') out.nodeArch = value.trim();
      continue;
    }
    throw new Error(`未知参数: ${raw}（可用: ${BOOL_FLAGS.join(' ')} ${VALUE_FLAGS.map((f) => `${f}=<v>`).join(' ')}）`);
  }
  return out;
}

/**
 * @param {ReturnType<typeof parseArgv>} opts 已解析的参数。
 *   刻意不在这里 parse：用法错误必须走 exit 2 的响亮失败，不能被下面的降级逻辑吞掉。
 */
async function run(opts) {
  if (opts.selfTest) return runSelfTest();

  // --platform / --arch 只是让 Linux-only 路径能在别处被验证；不传就用宿主真实值。
  const platform = opts.platform || process.platform;
  const nodeArch = opts.nodeArch || process.arch;
  const simulated = !!(opts.platform || opts.nodeArch);

  const ctx = collectContext({ platform, nodeArch });
  if (!ctx) {
    console.log(`[pin-tools] 当前平台 ${platform} 不需要 AppImage 工具，跳过。`);
    return 0;
  }

  console.log(`[pin-tools] 架构: ${ctx.arch}${simulated ? `（由 --platform/--arch 模拟，宿主 ${process.platform}/${process.arch}）` : ''}`);
  console.log(`[pin-tools] 工具目录: ${ctx.toolsDir}${ctx.useLocalToolsDir ? '（useLocalToolsDir=true）' : ''}`);

  if (opts.planOnly) {
    for (const item of ctx.plan) {
      console.log(`[pin-tools] 计划 ${item.key}@${item.version}`);
      console.log(`[pin-tools]   ← ${item.url}`);
      console.log(`[pin-tools]   → ${item.dest}`);
      console.log(`[pin-tools]   理由: ${item.why}`);
    }
    console.log('[pin-tools] --plan 模式：未联网、未落盘');
    return 0;
  }

  let pinned = 0;
  let reused = 0;
  let degraded = 0;

  for (const item of ctx.plan) {
    if (!opts.force && fs.existsSync(item.dest)) {
      const size = fs.statSync(item.dest).size;
      console.log(`[pin-tools] ${item.key}: 已存在（${size} 字节），复用，不重复下载`);
      reused += 1;
      continue;
    }
    try {
      console.log(`[pin-tools] ${item.key}: 下载 ${item.version}`);
      console.log(`[pin-tools]   ← ${item.url}`);
      const data = await download(item.url);
      // AppImage 是自带 squashfs 的 ELF，正常至少几 MB；太小说明拿到的是错误页
      if (data.length < 1024 * 100) {
        throw new Error(`下载内容仅 ${data.length} 字节，疑似不是有效的 AppImage`);
      }
      const magic = data.subarray(0, 4).toString('hex');
      if (magic !== '7f454c46') {
        throw new Error(`文件头不是 ELF（${magic}），下载到的不是可执行 AppImage`);
      }
      writeExecutable(item.dest, data);
      console.log(`[pin-tools]   → ${item.dest}（${data.length} 字节，ELF 校验通过，已加可执行位）`);
      pinned += 1;
    } catch (err) {
      degraded += 1;
      // GitHub Actions 注解，让日志里显眼但不红
      console.log(`::warning::[pin-tools] ${item.key} 钉版失败：${err.message}`);
      console.log(`[pin-tools] ${item.key}: 退回 tauri 默认行为（下载 continuous 或用它自带的插件）`);
      if (!item.optional) {
        console.error(`[pin-tools] ${item.key} 不是可选项，终止。`);
        return 1;
      }
    }
  }

  console.log(`[pin-tools] 完成：新钉 ${pinned} 个，复用 ${reused} 个，降级 ${degraded} 个`);
  return 0;
}

if (require.main === module) {
  const argv = process.argv.slice(2);

  // ① 用法错误：永远响亮失败（exit 2）。
  //    这类错误来自 package.json / workflow 的手写命令行，一旦静默降级，
  //    结果就是「参数打错了、钉版没生效、构建还是绿的」—— 比崩掉难查得多。
  let opts;
  try {
    opts = parseArgv(argv);
  } catch (err) {
    console.error(`[pin-tools] 参数错误: ${err.message}`);
    process.exit(2);
  }

  // ② 自检 / --plan 是给人排查用的，必须响亮失败；真实打包路径上本脚本的任何故障
  //    都只降级为告警 —— 它是可选优化，不该有能力把整条 Linux job 干红（见文件头事故记录）。
  const strict = opts.selfTest || opts.planOnly;
  run(opts).then(
    (code) => { process.exit(code || 0); },
    (err) => {
      if (strict) {
        console.error(`[pin-tools] 失败: ${(err && err.stack) || err}`);
        process.exit(1);
      }
      console.log(`::warning::[pin-tools] 内部错误，跳过工具钉版（tauri 会自行下载 continuous）：${(err && err.message) || err}`);
      console.error(`[pin-tools] 堆栈（仅供排查，不阻断构建）：\n${(err && err.stack) || err}`);
      process.exit(0);
    },
  );
}

module.exports = {
  ARCH_MAP,
  DEFAULT_PLUGIN_VERSION,
  resolvePinned,
  resolveArch,
  normalizeHomedir,
  resolveToolsDir,
  readUseLocalToolsDir,
  planFor,
  collectContext,
  parseArgv,
  run,
  runSelfTest,
  // 导出下载/落盘原语仅为可测试性：钉版 URL 一旦失效会静默降级（只告警不阻断），
  // 因此必须能在 CI 之外主动验证「这个 tag 的资产真的下得下来」。
  download,
  writeExecutable,
};
