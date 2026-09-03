'use strict';

/**
 * cli-provision.js —— 桌面端「注册终端命令」
 *
 * 目的：桌面版安装后，用户在 cmd / PowerShell / Git Bash 里也能直接敲
 *       `gwork cli`、`gwork web 0`、`gwork run '你好'`，与旧的 CLI 安装模式一致。
 *
 * 关键点（与 CLI 安装模式的本质区别）：
 * - 桌面端**自带完整 JRE**（extraResources/jre）与 `gourd-ai-agent.jar`（同一个 App 主类，
 *   完整支持 cli/web/run/serve 子命令）。所以启动器**直接硬编码指向自带 java.exe + jar**，
 *   全程**不检测系统 Java**（正是需求所强调的：有自己的 JRE，不用额外找 Java）。
 * - 启动器写入用户主目录的 `~/.gwork/bin`，并把该目录加入用户 PATH。
 * - 幂等自愈：每次 App 启动都重写启动器（安装目录变化/升级后自动刷新指向），PATH 已有则不动。
 * - 全程 try/catch，任何失败都只告警、绝不影响 App 启动。
 *
 * 卸载：provision 时顺带写入自解释的卸载助手（win: desktop-cli-uninstall.ps1），
 *       NSIS customUnInstall 会调用它删除启动器 + PATH 项（见 cmd/installer.nsh）。
 *       助手带「只删我们打的 sentinel 标记、且与 CLI 安装共存时不误删」的保护逻辑。
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { app } = require('electron');
const { getResourcesDir, migrateLegacyHarnessDirs } = require('./backend');
const { resolveUserHome } = require('./runtime-paths');

// 启动器里埋的标记：卸载助手据此判断「这是桌面端写的」，避免误删 CLI 安装模式的启动器
const SENTINEL = 'gourd-ai-desktop-provisioned';
const HARNESS_HOME = '.gwork';

const IS_WIN = process.platform === 'win32';

/**
 * 是否运行于 Linux AppImage。
 * AppImage 运行时把包挂载到**临时随机目录**（/tmp/.mount_XXXXXX/），每次启动都变、退出即卸载，
 * 故 process.resourcesPath 指向的是短命路径。若把它烤进常驻启动器，App 关闭后路径即失效。
 * → AppImage 环境直接跳过终端命令注册（deb 包 / CLI 安装模式有稳定路径，不受影响）。
 * 判据：AppImage 运行时会注入 APPIMAGE(=.AppImage 文件绝对路径) 与 APPDIR(=挂载点) 环境变量。
 */
function isAppImage() {
  return process.platform === 'linux' && !!(process.env.APPIMAGE || process.env.APPDIR);
}

/**
 * OS 用户主目录。复用 runtime-paths.resolveUserHome，与 backend.getRuntimeHomeDir() 共用
 * 同一份解析顺序：否则在同时存在 USERPROFILE 与 HOME 的环境（Git Bash、WSL 互通、CI）
 * 会出现 bin 目录与 -Dgwork.home 分叉，启动器写到 A、后端读的却是 B。
 */
function getUserHome() {
  return resolveUserHome();
}

function getBinDir() {
  return path.join(getUserHome(), HARNESS_HOME, 'bin');
}

/**
 * 自带 JRE 的**控制台版** java 可执行文件（CLI 需要 stdin/stdout，必须用 java 而非 javaw）。
 * @returns {string|null}
 */
function getBundledJava() {
  const javaName = IS_WIN ? 'java.exe' : 'java';
  const p = path.join(getResourcesDir(), 'jre', 'bin', javaName);
  return fs.existsSync(p) ? p : null;
}

/**
 * 自带的 gourd-ai-agent.jar
 * @returns {string|null}
 */
function getBundledJar() {
  const p = path.join(getResourcesDir(), 'gourd-ai-agent.jar');
  return fs.existsSync(p) ? p : null;
}

/**
 * 读取自带 JRE 的主版本号（从 jre/release 的 JAVA_VERSION 解析）。
 * 用于决定是否追加 --enable-native-access=ALL-UNNAMED（仅 Java 21+ 认识，
 * 老版本会因「无法识别的选项」直接启动失败，故只在确认 >=21 时才加）。
 * @returns {number|null}
 */
function getBundledJavaMajor() {
  try {
    const releaseFile = path.join(getResourcesDir(), 'jre', 'release');
    const text = fs.readFileSync(releaseFile, 'utf8');
    const m = text.match(/JAVA_VERSION="?(\d+)/);
    if (m) return parseInt(m[1], 10);
  } catch (e) {
    /* ignore */
  }
  return null;
}

/**
 * 组装 JVM 参数（编码统一 UTF-8；21+ 追加 native-access）。
 * 注意：不含任何可能带空格的项；-Dgwork.home 因安装路径常含空格，
 * 由各启动器按自身引号规则单独承载。
 * @param {number|null} major
 * @returns {string[]}
 */
function buildJavaOpts(major) {
  const opts = [
    '-Dfile.encoding=UTF-8',
    '-Dstdout.encoding=UTF-8',
    '-Dstderr.encoding=UTF-8',
    '-Dstdin.encoding=UTF-8',
  ];
  if (typeof major === 'number' && major >= 21) {
    opts.push('--enable-native-access=ALL-UNNAMED');
  }
  return opts;
}

// ── 启动器脚本内容 ─────────────────────────────────────────────────────────

/** CMD/.bat 启动器（Windows 原生控制台） */
function batContent(javaPath, jarPath, javaOpts, homeDir) {
  // -Dgwork.home 需整体加引号：安装路径常含空格（如 C:\Program Files\...），否则会被拆成多个参数
  const homeOpt = '"-Dgwork.home=' + homeDir + '"';
  return [
    '@echo off',
    'rem ' + SENTINEL,
    'rem GWork CLI Launcher (Desktop bundled JRE) —— 由桌面端自动生成，勿手改',
    'setlocal',
    'rem 自愈：App 已卸载/移动（自带 JAR 不在）→ 提示并退出（NSIS 卸载器会清理启动器与 PATH）',
    'if not exist "' + jarPath + '" (',
    '    echo gwork: GWork 桌面端运行时未找到，可能已卸载或移动安装目录。1>&2',
    '    exit /b 127',
    ')',
    '"' + javaPath + '" ' + javaOpts.join(' ') + ' ' + homeOpt + ' -jar "' + jarPath + '" %*',
  ].join('\r\n') + '\r\n';
}

/** PowerShell 启动器（gwork.ps1） */
function ps1Content(javaPath, jarPath, javaOpts, homeDir) {
  // 单引号字面量整体传递，避免安装路径含空格被 PowerShell 拆分为多参数
  const homeOpt = "'-Dgwork.home=" + homeDir + "'";
  return [
    '# ' + SENTINEL,
    '# GWork CLI Launcher (Desktop bundled JRE) —— 由桌面端自动生成，勿手改',
    'param([Parameter(ValueFromRemainingArguments)]$RestArgs)',
    'try {',
    '    $OutputEncoding = [System.Text.Encoding]::UTF8',
    '    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '    [Console]::InputEncoding = [System.Text.Encoding]::UTF8',
    '} catch {}',
    'if (-not (Test-Path -LiteralPath "' + jarPath + '")) {',
    '    [Console]::Error.WriteLine("gwork: GWork 桌面端运行时未找到，可能已卸载或移动安装目录。")',
    '    exit 127',
    '}',
    '& "' + javaPath + '" ' + javaOpts.join(' ') + ' ' + homeOpt + ' -jar "' + jarPath + '" @RestArgs',
    'exit $LASTEXITCODE',
  ].join('\r\n') + '\r\n';
}

/**
 * Git Bash / WSL / macOS / Linux 启动器（无扩展名 gwork）。
 * Windows 下把反斜杠路径转成正斜杠（Java 与 bash 均接受），并复用 CLI 安装模式的
 * winpty 逻辑保证交互式行编辑正常。
 *
 * **自愈卸载**：mac 的 .dmg 拖拽卸载、以及权限受限场景都没有卸载钩子能清理用户目录里的
 * 启动器。故启动器自身在运行前先探测自带 JAR 是否还在：若 App 已被删除（JAR 不存在）
 * 且不存在 CLI 安装模式（gourd-ai-agent.jar），就删掉桌面端写的启动器并提示，避免留下死命令。
 */
function shContent(javaPath, jarPath, javaOpts, homeDir) {
  const j = IS_WIN ? javaPath.replace(/\\/g, '/') : javaPath;
  const jar = IS_WIN ? jarPath.replace(/\\/g, '/') : jarPath;
  const bin = (IS_WIN ? getBinDir().replace(/\\/g, '/') : getBinDir());
  // Java 在 Windows 上亦接受正斜杠；转换后避免反斜杠在 bash 里被转义
  const home = IS_WIN ? homeDir.replace(/\\/g, '/') : homeDir;
  const optStr = javaOpts.join(' ');
  return [
    '#!/bin/bash',
    '# ' + SENTINEL,
    '# GWork CLI Launcher (Desktop bundled JRE) —— 由桌面端自动生成，勿手改',
    'JAVA="' + j + '"',
    'JAR="' + jar + '"',
    'JAVA_OPTS="' + optStr + '"',
    // -Dgwork.home 单独成变量并在 exec 时加引号传参，避免安装路径含空格被词拆分
    'HOME_OPT="-Dgwork.home=' + home + '"',
    '# 自愈：App 已卸载（自带 JAR 不在）→ 清掉桌面端写的启动器后优雅退出',
    'if [ ! -f "$JAR" ]; then',
    '    BIN="' + bin + '"',
    '    if [ ! -f "$BIN/gourd-ai-agent.jar" ]; then',
    '        for n in gwork gwork.bat gwork.ps1 gourdai gourdai.bat gourdai.ps1 desktop-cli-uninstall.sh; do',
    '            f="$BIN/$n"',
    '            if [ -f "$f" ] && grep -qF "' + SENTINEL + '" "$f" 2>/dev/null; then rm -f "$f"; fi',
    '        done',
    '        rm -f "$BIN/desktop-cli-uninstall.sh" 2>/dev/null',
    '    fi',
    '    echo "gwork: GWork 桌面端似乎已卸载（未找到运行时）。已自动清理该命令。" >&2',
    '    exit 127',
    'fi',
    '# Git Bash / MSYS 终端需要 winpty 才能正确处理行编辑',
    'if [ -n "$MSYSTEM" ]; then',
    '    JAVA_OPTS="$JAVA_OPTS -Djline.terminal.type=xterm-256color"',
    '    if [ -t 0 ] && [ -t 1 ] && command -v winpty >/dev/null 2>&1; then',
    '        exec winpty "$JAVA" $JAVA_OPTS "$HOME_OPT" -jar "$JAR" "$@"',
    '    fi',
    'fi',
    'exec "$JAVA" $JAVA_OPTS "$HOME_OPT" -jar "$JAR" "$@"',
    '',
  ].join('\n');
}

// ── 卸载助手内容 ───────────────────────────────────────────────────────────

/**
 * Windows 卸载助手（desktop-cli-uninstall.ps1）。
 * 写在用户全局区的 .gwork\bin（与启动器同处）；由 NSIS customRemoveFiles 在删除应用文件<b>之前</b>调用。
 * 逻辑：只删带 sentinel 的启动器；与 CLI 安装模式共存（存在 gourd-ai-agent.jar）时保留 PATH；
 *       清理干净后自删。
 */
function uninstallPs1Content() {
  const binDir = getBinDir();
  return [
    '# GWork 桌面端 CLI 命令卸载助手（由桌面端自动生成）',
    '$ErrorActionPreference = "SilentlyContinue"',
    '$bin = ' + JSON.stringify(binDir),
    '$sentinel = "' + SENTINEL + '"',
    '$names = @("gwork.bat","gwork.ps1","gwork","gourdai.bat","gourdai.ps1","gourdai")',
    '$hasCli = Test-Path (Join-Path $bin "gourd-ai-agent.jar")',
    'foreach ($n in $names) {',
    '    $f = Join-Path $bin $n',
    '    if (Test-Path $f) {',
    '        $c = Get-Content -Raw -LiteralPath $f',
    '        if ($c -match $sentinel) { Remove-Item -Force -LiteralPath $f }',
    '    }',
    '}',
    '# 仅当没有其它启动器、且不存在 CLI 安装（gourd-ai-agent.jar）时，才摘除 PATH 项',
    '$remain = $false',
    'foreach ($n in $names) { if (Test-Path (Join-Path $bin $n)) { $remain = $true } }',
    'if ($hasCli) { $remain = $true }',
    'if (-not $remain) {',
    '    $p = [Environment]::GetEnvironmentVariable("Path","User")',
    '    if ($p) {',
    '        $target = $bin.TrimEnd("\\")',
    '        $parts = $p -split ";" | Where-Object { $_ -and ($_.TrimEnd("\\") -ne $target) }',
    '        [Environment]::SetEnvironmentVariable("Path", ($parts -join ";"), "User")',
    '    }',
    '}',
    '# 助手自删',
    'try { Remove-Item -Force -LiteralPath $MyInvocation.MyCommand.Path } catch {}',
    '',
  ].join('\r\n');
}

/**
 * Unix 卸载助手（desktop-cli-uninstall.sh）。mac/linux 的包卸载器（AppImage 无、deb 需 postrm）
 * 暂未自动挂接，此助手供用户手动执行。逻辑与 Windows 版一致。
 *
 * ⚠ 桌面端与独立 CLI 现在**共用 ~/.gwork/bin**，所以无法靠路径区分归属：
 * - 启动器：靠文件内的 SENTINEL 区分（只删桌面端自己写的）；
 * - rc 里的 PATH 行：靠「marker 注释行 + 紧跟的下一行」这一成对结构精确删除。
 *   绝不能用 `grep -vF ".gwork/bin"` 整行过滤 —— 那会把独立 CLI 写的
 *   `export PATH="$PATH:$HOME/.gwork/bin"` 一并删掉，并留下孤立的 `# Solon Code CLI` 注释。
 */
function uninstallShContent() {
  const binDir = getBinDir();
  return [
    '#!/bin/bash',
    '# GWork 桌面端 CLI 命令卸载助手（由桌面端自动生成）',
    'BIN="' + binDir + '"',
    'SENTINEL="' + SENTINEL + '"',
    'for n in gwork gwork.bat gwork.ps1 gourdai gourdai.bat gourdai.ps1; do',
    '    f="$BIN/$n"',
    '    if [ -f "$f" ] && grep -qF "$SENTINEL" "$f" 2>/dev/null; then rm -f "$f"; fi',
    'done',
    '# 仅移除桌面端自己追加的「marker + PATH 行」；同目录下独立 CLI 的 PATH 行不受影响。',
    'for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do',
    '    [ -f "$rc" ] || continue',
    '    if grep -qF "# GWork Desktop CLI" "$rc" 2>/dev/null || grep -qF "# Gourd AI Desktop CLI" "$rc" 2>/dev/null; then',
    '        tmp="$(mktemp)"',
    '        awk \'',
    '            skip == 1 { skip = 0; next }',
    '            $0 == "# GWork Desktop CLI" || $0 == "# Gourd AI Desktop CLI" { skip = 1; next }',
    '            { print }',
    '        \' "$rc" > "$tmp" && mv "$tmp" "$rc" || rm -f "$tmp"',
    '    fi',
    'done',
    '# 助手自删',
    'rm -f "$0" 2>/dev/null',
    '',
  ].join('\n');
}

// ── 写文件（统一封装，控制换行/权限）─────────────────────────────────────────

function writeScript(filePath, content, executable) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8' });
  if (executable && !IS_WIN) {
    try { fs.chmodSync(filePath, 0o755); } catch (e) { /* ignore */ }
  }
}

// ── PATH 注册 ──────────────────────────────────────────────────────────────

/**
 * Windows：通过 PowerShell 的 .NET API 把用户主目录的 ~/.gwork/bin 加入用户 PATH（幂等）。
 * 同时清理任何以 resources\extraResources\旧全局目录\bin 结尾的历史桌面 PATH，
 * 但不触碰用户独立 CLI 的安装目录。
 * @returns {Promise<void>}
 */
function ensurePathWindows() {
  const binDir = getBinDir();
  const legacySuffixes = [
    '\\resources\\extraResources\\.gwork\\bin',
    '\\resources\\extraResources\\.gourdai\\bin',
    '\\resources\\extraResources\\.gourdai\\.gourdai\\bin',
  ];
  const legacyJson = JSON.stringify(legacySuffixes);
  const psScript = [
    '$d = ' + JSON.stringify(binDir),
    '$legacySuffixes = ' + legacyJson,
    '$p = [Environment]::GetEnvironmentVariable("Path","User")',
    'if ($p) {',
    '    $clean = (($p -split ";" | Where-Object { $entry = $_; $entry -and -not ($legacySuffixes | Where-Object { $entry.TrimEnd("\\").ToLowerInvariant().EndsWith($_.ToLowerInvariant()) }) }) -join ";")',
    '    if ($clean -ne $p) { [Environment]::SetEnvironmentVariable("Path", $clean, "User"); $p = $clean }',
    '}',
    'if ([string]::IsNullOrEmpty($p)) {',
    '    [Environment]::SetEnvironmentVariable("Path", $d, "User")',
    '} elseif (($p -split ";" | ForEach-Object { $_.TrimEnd("\\") }) -notcontains $d.TrimEnd("\\")) {',
    '    [Environment]::SetEnvironmentVariable("Path", ($p.TrimEnd(";") + ";" + $d), "User")',
    '}',
  ].join('\n');
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 15000 },
      (err) => {
        if (err) console.warn('[cli-provision] 配置用户 PATH 失败:', err.message);
        resolve();
      }
    );
  });
}

/**
 * Unix：把 PATH 段追加到对应 shell 的 rc 文件（幂等，靠 marker 判重）。
 * 同时清理历史桌面端写入的旧 PATH 行，否则旧 bin 里的启动器仍在 PATH 中且可能排在前面，
 * `gwork` 会解析到旧启动器，其 -Dgwork.home 指向旧位置。
 */
function ensurePathUnix() {
  const home = getUserHome();
  const binDir = getBinDir();
  const marker = '# GWork Desktop CLI';
  const line = 'export PATH="$PATH:' + binDir + '"';
  const shell = path.basename(process.env.SHELL || 'bash');

  // 历史桌面端 PATH 行（逐个比对，不做模糊包含匹配，避免误删用户自装 CLI 的行）：
  // - 品牌升级前的 ~/.gourdai/bin 与旧版 bug 期的嵌套 ~/.gourdai/.gourdai/bin
  // - macOS 旧全局区：~/Library/Application Support/Gourd AI/.gwork（及 .gourdai）/bin
  const legacyBinDirs = [
    path.join(home, '.gourdai', 'bin'),
    path.join(home, '.gourdai', '.gourdai', 'bin'),
  ];
  if (process.platform === 'darwin') {
    const macAppSupport = path.join(home, 'Library', 'Application Support', 'Gourd AI');
    legacyBinDirs.push(path.join(macAppSupport, '.gwork', 'bin'));
    legacyBinDirs.push(path.join(macAppSupport, '.gourdai', 'bin'));
    legacyBinDirs.push(path.join(macAppSupport, '.gourdai', '.gourdai', 'bin'));
  }
  // Linux deb 旧版把全局区放在安装资源目录（如 /opt/GWork/resources/extraResources/.gwork/bin），
  // 安装前缀不固定，改用后缀匹配。
  const legacySuffixes = [
    '/resources/extraResources/.gwork/bin',
    '/resources/extraResources/.gourdai/bin',
    '/resources/extraResources/.gourdai/.gourdai/bin',
  ];
  const isLegacyPathLine = (text) => {
    if (!text.includes('export PATH=')) return false;
    if (text.includes(binDir)) return false; // 当前目标行，保留
    if (legacyBinDirs.some((dir) => text.includes(dir))) return true;
    return legacySuffixes.some((suffix) => text.includes(suffix));
  };

  const files = [];
  if (shell === 'zsh') {
    files.push(path.join(home, '.zshrc'));
  } else if (shell === 'bash') {
    if (process.platform === 'darwin') {
      files.push(path.join(home, '.bash_profile'), path.join(home, '.bashrc'));
    } else {
      files.push(path.join(home, '.bashrc'), path.join(home, '.bash_profile'));
    }
  } else {
    files.push(path.join(home, '.profile'), path.join(home, '.bashrc'), path.join(home, '.zshrc'));
  }

  for (const file of files) {
    try {
      let existing = '';
      if (fs.existsSync(file)) {
        existing = fs.readFileSync(file, 'utf8');
        const original = existing.split('\n');
        const lines = original.filter((l) => !isLegacyPathLine(l));
        if (lines.length !== original.length) {
          existing = lines.join('\n');
          fs.writeFileSync(file, existing, 'utf8');
        }
        if (existing.includes(binDir)) {
          // 品牌迁移：旧版写入的 rc 注释标记刷新为新品牌名（PATH 行本身不变，幂等）
          if (existing.includes('# Gourd AI Desktop CLI')) {
            fs.writeFileSync(file, existing.split('# Gourd AI Desktop CLI').join(marker), 'utf8');
          }
          continue; // 已配置
        }
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
      }
      const prefix = existing.endsWith('\n') || existing === '' ? '' : '\n';
      fs.appendFileSync(file, prefix + '\n' + marker + '\n' + line + '\n');
    } catch (e) {
      /* 单个文件失败不影响其它 */
    }
  }
}

// ── 主入口 ─────────────────────────────────────────────────────────────────

/**
 * 注册（或自愈刷新）桌面端的 `gwork` 终端命令。
 * 幂等、非阻塞、全程 try/catch。定位不到自带运行时则跳过（绝不回退系统 Java）。
 * @returns {Promise<boolean>} 是否成功写入启动器
 */
async function provisionCli() {
  try {
    // Linux AppImage：资源路径是临时挂载（退出即失效），不能烤进常驻启动器 → 跳过。
    if (isAppImage()) {
      console.warn('[cli-provision] 检测到 AppImage 运行环境（资源路径临时），跳过终端命令注册');
      return false;
    }

    // 启动器/PATH 使用用户主目录的 ~/.gwork；迁移在写入前完成，
    // 确保旧安装目录启动器不会重新成为默认命令。
    migrateLegacyHarnessDirs();

    const javaPath = getBundledJava();
    const jarPath = getBundledJar();
    if (!javaPath || !jarPath) {
      console.warn('[cli-provision] 未找到自带 JRE/JAR，跳过终端命令注册',
        '(java=' + javaPath + ', jar=' + jarPath + ')');
      return false;
    }

    const binDir = getBinDir();
    fs.mkdirSync(binDir, { recursive: true });

    const javaOpts = buildJavaOpts(getBundledJavaMajor());
    // 打包版 CLI 文件日志同样仅输出 ERROR（与后端一致，防 DEBUG 日志撑爆全局区；
    // 启动器是落盘常驻脚本，只能烤入稳定的 isPackaged 属性，不能烤环境变量）
    if (app.isPackaged) {
      javaOpts.push('-Dsolon.logging.appender.file.level=ERROR');
    }
    // 全局配置区基目录固定为用户主目录；启动器实际使用 ~/.gwork。
    const homeDir = getUserHome();

    // 三种启动器一律重写（自愈：安装目录变化后自动指向新路径）
    writeScript(path.join(binDir, 'gwork.bat'), batContent(javaPath, jarPath, javaOpts, homeDir), false);
    writeScript(path.join(binDir, 'gwork.ps1'), ps1Content(javaPath, jarPath, javaOpts, homeDir), false);
    writeScript(path.join(binDir, 'gwork'), shContent(javaPath, jarPath, javaOpts, homeDir), true);

    // 品牌升级：删除旧命令残留（仅限带桌面端 sentinel 的，CLI 安装模式的同名文件不受影响）
    for (const legacyName of ['gourdai.bat', 'gourdai.ps1', 'gourdai']) {
      const legacyPath = path.join(binDir, legacyName);
      try {
        if (fs.existsSync(legacyPath)
          && fs.readFileSync(legacyPath, 'utf8').includes(SENTINEL)) {
          fs.unlinkSync(legacyPath);
          console.log('[cli-provision] 已清理旧命令残留: ' + legacyPath);
        }
      } catch (e) { /* ignore */ }
    }

    // 卸载助手（win 由 NSIS 调用，unix 供手动执行）
    if (IS_WIN) {
      writeScript(path.join(binDir, 'desktop-cli-uninstall.ps1'), uninstallPs1Content(), false);
    } else {
      writeScript(path.join(binDir, 'desktop-cli-uninstall.sh'), uninstallShContent(), true);
    }

    // 配置 PATH（幂等）
    if (IS_WIN) {
      await ensurePathWindows();
    } else {
      ensurePathUnix();
    }

    console.log('[cli-provision] 终端命令已就绪: ' + path.join(binDir, 'gwork') + ' （新开终端后可用 `gwork cli` / `gwork web 0`）');
    return true;
  } catch (err) {
    console.warn('[cli-provision] 注册终端命令失败（不影响 App 启动）:', err && err.message);
    return false;
  }
}

module.exports = {
  provisionCli,
  getBinDir,
  // 导出便于测试
  _internal: {
    getBundledJava,
    getBundledJar,
    getBundledJavaMajor,
    buildJavaOpts,
    batContent,
    ps1Content,
    shContent,
    uninstallPs1Content,
    uninstallShContent,
    isAppImage,
    ensurePathUnix,
    SENTINEL,
  },
};
