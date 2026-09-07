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

   ── 失败策略 ──
   下载失败只告警不阻断：tauri 自己就把这个插件当可选项
   （"linuxdeploy will fall back to its built-in version if the download failed"）。
   钉版失败时退回原行为（让 tauri 去下 continuous），比因钉版失败而整个构建挂掉更可取。

   用法：
     node cmd/pin-linuxdeploy-tools.js            实际下载并落盘
     node cmd/pin-linuxdeploy-tools.js --plan     只打印计划，不联网不落盘（CI 之外也可跑）
     node cmd/pin-linuxdeploy-tools.js --force    已存在也重新下载覆盖
   环境变量：
     GWORK_LINUXDEPLOY_PLUGIN_APPIMAGE_VERSION    覆盖钉住的 tag（排查上游回归时用来 A/B）
   ============================================================ */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const MODULE_DIR = path.resolve(__dirname, '..');

/** 架构名映射：Node 的 process.arch → AppImage 生态用的 uname -m 风格名 */
const ARCH_MAP = { x64: 'x86_64', arm64: 'aarch64', ia32: 'i386' };

/**
 * 钉住的版本。
 * `continuous` 是滚动 tag（实测 2026-06-07 刚重建过）；下面这个是上游最近的一个
 * 不可变 tag，时间上与 tauri 自带的 2024-07 linuxdeploy 更接近，兼容性风险最低。
 */
const DEFAULT_PLUGIN_VERSION = '1-alpha-20250213-1';

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
 * tauri-bundler 的工具目录：
 *   bundle.useLocalToolsDir = true → <src-tauri>/target/.tauri
 *   否则（默认）                   → ${XDG_CACHE_HOME:-~/.cache}/tauri
 */
function resolveToolsDir({ srcTauriDir, useLocalToolsDir, env = process.env, homedir = os.homedir() }) {
  if (useLocalToolsDir) return path.join(srcTauriDir, 'target', '.tauri');
  const cache = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.trim() !== ''
    ? env.XDG_CACHE_HOME
    : path.join(homedir(), '.cache');
  return path.join(cache, 'tauri');
}

/** 从 tauri.conf.json 读 useLocalToolsDir（缺省 false），读不到就当 false 并告警 */
function readUseLocalToolsDir(srcTauriDir) {
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

async function main() {
  const argv = process.argv.slice(2);
  const planOnly = argv.includes('--plan');
  const force = argv.includes('--force');
  const unknown = argv.filter((a) => !['--plan', '--force'].includes(a));
  if (unknown.length > 0) {
    console.error(`[pin-tools] 未知参数: ${unknown.join(' ')}（可用: --plan --force）`);
    process.exit(2);
  }

  const arch = resolveArch();
  if (!arch) {
    console.log(`[pin-tools] 当前平台 ${process.platform} 不需要 AppImage 工具，跳过。`);
    return;
  }

  const srcTauriDir = path.join(MODULE_DIR, 'src-tauri');
  const toolsDir = resolveToolsDir({ srcTauriDir, useLocalToolsDir: readUseLocalToolsDir(srcTauriDir) });
  const plan = planFor({ arch, toolsDir });

  console.log(`[pin-tools] 架构: ${arch}`);
  console.log(`[pin-tools] 工具目录: ${toolsDir}`);

  if (planOnly) {
    for (const item of plan) {
      console.log(`[pin-tools] 计划 ${item.key}@${item.version}`);
      console.log(`[pin-tools]   ← ${item.url}`);
      console.log(`[pin-tools]   → ${item.dest}`);
    }
    return;
  }

  let pinned = 0;
  let reused = 0;
  let skipped = 0;

  for (const item of plan) {
    if (!force && fs.existsSync(item.dest)) {
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
      writeExecutable(item.dest, data);
      console.log(`[pin-tools]   → ${item.dest}（${data.length} 字节，已加可执行位）`);
      pinned += 1;
    } catch (err) {
      skipped += 1;
      // GitHub Actions 注解，让日志里显眼但不红
      console.log(`::warning::[pin-tools] ${item.key} 钉版失败：${err.message}`);
      console.log(`[pin-tools] ${item.key}: 退回 tauri 默认行为（下载 continuous 或用它自带的插件）`);
      if (!item.optional) {
        console.error(`[pin-tools] ${item.key} 不是可选项，终止。`);
        process.exit(1);
      }
    }
  }

  console.log(`[pin-tools] 完成：新钉 ${pinned} 个，复用 ${reused} 个，降级 ${skipped} 个`);
  console.log(`[pin-tools] 原因备忘：${plan.map((p) => `${p.key} — ${p.why}`).join('；')}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[pin-tools] 失败: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  ARCH_MAP,
  DEFAULT_PLUGIN_VERSION,
  resolvePinned,
  resolveArch,
  resolveToolsDir,
  readUseLocalToolsDir,
  planFor,
  // 导出下载/落盘原语仅为可测试性：钉版 URL 一旦失效会静默降级（只告警不阻断），
  // 因此必须能在 CI 之外主动验证「这个 tag 的资产真的下得下来」。
  download,
  writeExecutable,
};
