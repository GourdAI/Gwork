//! cli_provision.rs —— 桌面端「注册终端命令」（Rust 移植版）
//!
//! 移植自 gourd-ai-desktop/main/cli-provision.js。
//!
//! 目的：桌面版安装后，用户在 cmd / PowerShell / Git Bash 里也能直接敲
//!       `gwork cli`、`gwork web 0`、`gwork run '你好'`，与旧的 CLI 安装模式一致。
//!
//! 关键点（与 CLI 安装模式的本质区别）：
//! - 桌面端**自带完整 JRE**（extraResources/jre）与 `gourd-ai-agent.jar`（同一个 App 主类，
//!   完整支持 cli/web/run/serve 子命令）。所以启动器**直接硬编码指向自带 java + jar**，
//!   全程**不检测系统 Java**。
//! - 启动器写入用户主目录的 `~/.gwork/bin`，并把该目录加入用户 PATH。
//! - 幂等自愈：每次 App 启动都重写启动器（安装目录变化/升级后自动刷新指向），PATH 已有则不动。
//! - 全程兜底，任何失败都只告警、绝不影响 App 启动。
//!
//! 卸载：provision 时顺带写入自解释的卸载助手（win: desktop-cli-uninstall.ps1），
//!       卸载器会调用它删除启动器 + PATH 项。助手带「只删我们打的 sentinel 标记、
//!       且与 CLI 安装共存时不误删」的保护逻辑。

use anyhow::Context;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// 启动器里埋的标记：卸载助手据此判断「这是桌面端写的」，避免误删 CLI 安装模式的启动器。
pub const SENTINEL: &str = "gourd-ai-desktop-provisioned";
/// 全局配置区目录名（位于用户主目录下）。
pub const HARNESS_HOME: &str = ".gwork";
/// 旧品牌目录名（品牌升级残留清理用）。
pub const LEGACY_HOME: &str = ".gourdai";

#[cfg(windows)]
const IS_WIN: bool = true;
#[cfg(not(windows))]
const IS_WIN: bool = false;

// ── 路径解析 ────────────────────────────────────────────────────────────────

/// OS 用户主目录。Windows 与 Unix 的变量优先级必须固定且全局唯一：
/// 同时存在 USERPROFILE 与 HOME 的环境（Git Bash、WSL 互通、CI）下，若不同调用方
/// 读取顺序不一致，会出现启动器写到 A、后端却读 B 的分叉。
///
/// 与 Electron runtime-paths.resolveUserHome 保持一致：
/// - Windows: USERPROFILE || dirs::home_dir()
/// - Unix:    HOME        || dirs::home_dir()
pub fn resolve_user_home() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(v) = std::env::var_os("USERPROFILE") {
            let s = v.to_string_lossy().to_string();
            if !s.is_empty() {
                return PathBuf::from(s);
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(v) = std::env::var_os("HOME") {
            let s = v.to_string_lossy().to_string();
            if !s.is_empty() {
                return PathBuf::from(s);
            }
        }
    }
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// 运行时数据基目录，即 Java 侧 -Dgwork.home 的取值语义。
/// **不含** `.gwork` 子目录；刻意与打包方式、平台无关，一律是 OS 用户主目录。
pub fn runtime_home_dir() -> PathBuf {
    resolve_user_home()
}

/// 内置资源目录（对应 Electron 版 getResourcesDir）。
///
/// **本函数只是转发**：真实解析（候选排序 + 「jre/bin/java 实存」判据 + 缓存）
/// 全部集中在 `crate::paths`。历史上这里与 backend.rs 各持一份实现且候选优先级
/// **相反**，在 NSIS 覆盖安装遗留旧布局目录时会选错路径，直接造成安装版后端
/// 不启动（详见 paths.rs 顶部说明）。严禁在此重新拼接资源路径。
pub fn resources_dir() -> PathBuf {
    crate::paths::resources_dir()
}

/// 启动器目录：~/.gwork/bin
fn bin_dir() -> PathBuf {
    resolve_user_home().join(HARNESS_HOME).join("bin")
}

/// 是否运行于 Linux AppImage。
/// AppImage 运行时把包挂载到**临时随机目录**（/tmp/.mount_XXXXXX/），每次启动都变、退出即卸载，
/// 故资源路径指向的是短命路径。若把它烤进常驻启动器，App 关闭后路径即失效。
/// → AppImage 环境直接跳过终端命令注册（deb 包 / CLI 安装模式有稳定路径，不受影响）。
/// 判据：AppImage 运行时会注入 APPIMAGE(=.AppImage 文件绝对路径) 与 APPDIR(=挂载点) 环境变量。
fn is_appimage() -> bool {
    cfg!(target_os = "linux")
        && (std::env::var_os("APPIMAGE").is_some() || std::env::var_os("APPDIR").is_some())
}

// ── 自带运行时定位 ──────────────────────────────────────────────────────────

/// 自带 JRE 的**控制台版** java 可执行文件（CLI 需要 stdin/stdout，必须用 java 而非 javaw）。
/// 与后端进程（用 javaw 避免控制台窗口）共享同一套目录解析，只是取名偏好相反。
fn bundled_java() -> Option<PathBuf> {
    crate::paths::bundled_java_exe(false)
}

/// 自带的 gourd-ai-agent.jar
fn bundled_jar() -> Option<PathBuf> {
    let p = resources_dir().join("gourd-ai-agent.jar");
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

/// 读取自带 JRE 的主版本号（从 jre/release 的 JAVA_VERSION 解析）。
/// 用于决定是否追加 --enable-native-access=ALL-UNNAMED（仅 Java 21+ 认识，
/// 老版本会因「无法识别的选项」直接启动失败，故只在确认 >=21 时才加）。
fn bundled_java_major() -> Option<u32> {
    let release_file = resources_dir().join("jre").join("release");
    let text = std::fs::read_to_string(release_file).ok()?;
    // 解析 JAVA_VERSION="21" 或 JAVA_VERSION=17
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("JAVA_VERSION=") {
            let rest = rest.trim_matches('"');
            // 取首个 '.' 前的数字段
            let major_str: String = rest
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if let Ok(major) = major_str.parse::<u32>() {
                return Some(major);
            }
        }
    }
    None
}

/// 组装 JVM 参数（编码统一 UTF-8；21+ 追加 native-access）。
/// 注意：不含任何可能带空格的项；-Dgwork.home 因安装路径常含空格，
/// 由各启动器按自身引号规则单独承载。
fn build_java_opts(major: Option<u32>) -> Vec<String> {
    let mut opts = vec![
        "-Dfile.encoding=UTF-8".to_string(),
        "-Dstdout.encoding=UTF-8".to_string(),
        "-Dstderr.encoding=UTF-8".to_string(),
        "-Dstdin.encoding=UTF-8".to_string(),
    ];
    if let Some(m) = major {
        if m >= 21 {
            opts.push("--enable-native-access=ALL-UNNAMED".to_string());
        }
    }
    opts
}

// ── 启动器脚本内容 ──────────────────────────────────────────────────────────

/// CMD/.bat 启动器（Windows 原生控制台）
fn bat_content(java_path: &str, jar_path: &str, java_opts: &[String], home_dir: &str) -> String {
    // -Dgwork.home 需整体加引号：安装路径常含空格（如 C:\Program Files\...），否则会被拆成多个参数
    let home_opt = format!("\"-Dgwork.home={}\"", home_dir);
    let lines = [
        "@echo off".to_string(),
        format!("rem {}", SENTINEL),
        "rem GWork CLI Launcher (Desktop bundled JRE) —— 由桌面端自动生成，勿手改".to_string(),
        "setlocal".to_string(),
        "rem 自愈：App 已卸载/移动（自带 JAR 不在）→ 提示并退出（卸载器会清理启动器与 PATH）"
            .to_string(),
        format!("if not exist \"{}\" (", jar_path),
        "    echo gwork: GWork 桌面端运行时未找到，可能已卸载或移动安装目录。1>&2".to_string(),
        "    exit /b 127".to_string(),
        ")".to_string(),
        format!(
            "\"{}\" {} {} -jar \"{}\" %*",
            java_path,
            java_opts.join(" "),
            home_opt,
            jar_path
        ),
    ];
    let mut out = lines.join("\r\n");
    out.push_str("\r\n");
    out
}

/// PowerShell 启动器（gwork.ps1）
fn ps1_content(java_path: &str, jar_path: &str, java_opts: &[String], home_dir: &str) -> String {
    // 单引号字面量整体传递，避免安装路径含空格被 PowerShell 拆分为多参数
    let home_opt = format!("'-Dgwork.home={}'", home_dir);
    let lines = [
        format!("# {}", SENTINEL),
        "# GWork CLI Launcher (Desktop bundled JRE) —— 由桌面端自动生成，勿手改".to_string(),
        "param([Parameter(ValueFromRemainingArguments)]$RestArgs)".to_string(),
        "try {".to_string(),
        "    $OutputEncoding = [System.Text.Encoding]::UTF8".to_string(),
        "    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8".to_string(),
        "    [Console]::InputEncoding = [System.Text.Encoding]::UTF8".to_string(),
        "} catch {}".to_string(),
        format!(
            "if (-not (Test-Path -LiteralPath \"{}\")) {{",
            jar_path
        ),
        "    [Console]::Error.WriteLine(\"gwork: GWork 桌面端运行时未找到，可能已卸载或移动安装目录。\")".to_string(),
        "    exit 127".to_string(),
        "}".to_string(),
        format!(
            "& \"{}\" {} {} -jar \"{}\" @RestArgs",
            java_path,
            java_opts.join(" "),
            home_opt,
            jar_path
        ),
        "exit $LASTEXITCODE".to_string(),
    ];
    let mut out = lines.join("\r\n");
    out.push_str("\r\n");
    out
}

/// Git Bash / WSL / macOS / Linux 启动器（无扩展名 gwork）。
/// Windows 下把反斜杠路径转成正斜杠（Java 与 bash 均接受），并复用 CLI 安装模式的
/// winpty 逻辑保证交互式行编辑正常。
///
/// **自愈卸载**：mac 的 .dmg 拖拽卸载、以及权限受限场景都没有卸载钩子能清理用户目录里的
/// 启动器。故启动器自身在运行前先探测自带 JAR 是否还在：若 App 已被删除（JAR 不存在）
/// 且不存在 CLI 安装模式（gourd-ai-agent.jar），就删掉桌面端写的启动器并提示，避免留下死命令。
fn sh_content(java_path: &str, jar_path: &str, java_opts: &[String], home_dir: &str) -> String {
    let to_fwd = |p: &str| -> String {
        if IS_WIN {
            p.replace('\\', "/")
        } else {
            p.to_string()
        }
    };
    let j = to_fwd(java_path);
    let jar = to_fwd(jar_path);
    let bin = to_fwd(&bin_dir().to_string_lossy());
    let home = to_fwd(home_dir);
    let opt_str = java_opts.join(" ");
    let lines = [
        "#!/bin/bash".to_string(),
        format!("# {}", SENTINEL),
        "# GWork CLI Launcher (Desktop bundled JRE) —— 由桌面端自动生成，勿手改".to_string(),
        format!("JAVA=\"{}\"", j),
        format!("JAR=\"{}\"", jar),
        format!("JAVA_OPTS=\"{}\"", opt_str),
        // -Dgwork.home 单独成变量并在 exec 时加引号传参，避免安装路径含空格被词拆分
        format!("HOME_OPT=\"-Dgwork.home={}\"", home),
        "# 自愈：App 已卸载（自带 JAR 不在）→ 清掉桌面端写的启动器后优雅退出".to_string(),
        "if [ ! -f \"$JAR\" ]; then".to_string(),
        format!("    BIN=\"{}\"", bin),
        "    if [ ! -f \"$BIN/gourd-ai-agent.jar\" ]; then".to_string(),
        "        for n in gwork gwork.bat gwork.ps1 gourdai gourdai.bat gourdai.ps1 desktop-cli-uninstall.sh; do".to_string(),
        "            f=\"$BIN/$n\"".to_string(),
        format!(
            "            if [ -f \"$f\" ] && grep -qF \"{}\" \"$f\" 2>/dev/null; then rm -f \"$f\"; fi",
            SENTINEL
        ),
        "        done".to_string(),
        "        rm -f \"$BIN/desktop-cli-uninstall.sh\" 2>/dev/null".to_string(),
        "    fi".to_string(),
        "    echo \"gwork: GWork 桌面端似乎已卸载（未找到运行时）。已自动清理该命令。\" >&2"
            .to_string(),
        "    exit 127".to_string(),
        "fi".to_string(),
        "# Git Bash / MSYS 终端需要 winpty 才能正确处理行编辑".to_string(),
        "if [ -n \"$MSYSTEM\" ]; then".to_string(),
        "    JAVA_OPTS=\"$JAVA_OPTS -Djline.terminal.type=xterm-256color\"".to_string(),
        "    if [ -t 0 ] && [ -t 1 ] && command -v winpty >/dev/null 2>&1; then".to_string(),
        "        exec winpty \"$JAVA\" $JAVA_OPTS \"$HOME_OPT\" -jar \"$JAR\" \"$@\"".to_string(),
        "    fi".to_string(),
        "fi".to_string(),
        "exec \"$JAVA\" $JAVA_OPTS \"$HOME_OPT\" -jar \"$JAR\" \"$@\"".to_string(),
        String::new(),
    ];
    lines.join("\n")
}

// ── 卸载助手内容 ────────────────────────────────────────────────────────────

/// Windows 卸载助手（desktop-cli-uninstall.ps1）。
/// 写在用户全局区的 .gwork\bin（与启动器同处）；由卸载器在删除应用文件**之前**调用。
/// 逻辑：只删带 sentinel 的启动器；与 CLI 安装模式共存（存在 gourd-ai-agent.jar）时保留 PATH；
///       清理干净后自删。
#[cfg(windows)]
fn uninstall_ps1_content() -> String {
    let bin_dir_str = bin_dir().to_string_lossy().to_string();
    let bin_json = serde_json::to_string(&bin_dir_str).unwrap_or_else(|_| format!("\"{}\"", bin_dir_str));
    let lines = [
        "# GWork 桌面端 CLI 命令卸载助手（由桌面端自动生成）".to_string(),
        "$ErrorActionPreference = \"SilentlyContinue\"".to_string(),
        format!("$bin = {}", bin_json),
        format!("$sentinel = \"{}\"", SENTINEL),
        "$names = @(\"gwork.bat\",\"gwork.ps1\",\"gwork\",\"gourdai.bat\",\"gourdai.ps1\",\"gourdai\")".to_string(),
        "$hasCli = Test-Path (Join-Path $bin \"gourd-ai-agent.jar\")".to_string(),
        "foreach ($n in $names) {".to_string(),
        "    $f = Join-Path $bin $n".to_string(),
        "    if (Test-Path $f) {".to_string(),
        "        $c = Get-Content -Raw -LiteralPath $f".to_string(),
        "        if ($c -match $sentinel) { Remove-Item -Force -LiteralPath $f }".to_string(),
        "    }".to_string(),
        "}".to_string(),
        "# 仅当没有其它启动器、且不存在 CLI 安装（gourd-ai-agent.jar）时，才摘除 PATH 项".to_string(),
        "$remain = $false".to_string(),
        "foreach ($n in $names) { if (Test-Path (Join-Path $bin $n)) { $remain = $true } }".to_string(),
        "if ($hasCli) { $remain = $true }".to_string(),
        "if (-not $remain) {".to_string(),
        "    $p = [Environment]::GetEnvironmentVariable(\"Path\",\"User\")".to_string(),
        "    if ($p) {".to_string(),
        "        $target = $bin.TrimEnd(\"\\\")".to_string(),
        "        $parts = $p -split \";\" | Where-Object { $_ -and ($_.TrimEnd(\"\\\") -ne $target) }".to_string(),
        "        [Environment]::SetEnvironmentVariable(\"Path\", ($parts -join \";\"), \"User\")".to_string(),
        "    }".to_string(),
        "}".to_string(),
        "# 助手自删".to_string(),
        "try { Remove-Item -Force -LiteralPath $MyInvocation.MyCommand.Path } catch {}".to_string(),
        String::new(),
    ];
    lines.join("\r\n")
}

/// Unix 卸载助手（desktop-cli-uninstall.sh）。mac/linux 的包卸载器（AppImage 无、deb 需 postrm）
/// 暂未自动挂接，此助手供用户手动执行。逻辑与 Windows 版一致。
///
/// ⚠ 桌面端与独立 CLI 现在**共用 ~/.gwork/bin**，所以无法靠路径区分归属：
/// - 启动器：靠文件内的 SENTINEL 区分（只删桌面端自己写的）；
/// - rc 里的 PATH 行：靠「marker 注释行 + 紧跟的下一行」这一成对结构精确删除。
///   绝不能用 `grep -vF ".gwork/bin"` 整行过滤 —— 那会把独立 CLI 写的
///   `export PATH="$PATH:$HOME/.gwork/bin"` 一并删掉，并留下孤立的 `# Solon Code CLI` 注释。
#[cfg(not(windows))]
fn uninstall_sh_content() -> String {
    let bin_dir_str = bin_dir().to_string_lossy().to_string();
    let lines = [
        "#!/bin/bash".to_string(),
        "# GWork 桌面端 CLI 命令卸载助手（由桌面端自动生成）".to_string(),
        format!("BIN=\"{}\"", bin_dir_str),
        format!("SENTINEL=\"{}\"", SENTINEL),
        "for n in gwork gwork.bat gwork.ps1 gourdai gourdai.bat gourdai.ps1; do".to_string(),
        "    f=\"$BIN/$n\"".to_string(),
        "    if [ -f \"$f\" ] && grep -qF \"$SENTINEL\" \"$f\" 2>/dev/null; then rm -f \"$f\"; fi".to_string(),
        "done".to_string(),
        "# 仅移除桌面端自己追加的「marker + PATH 行」；同目录下独立 CLI 的 PATH 行不受影响。".to_string(),
        "for rc in \"$HOME/.zshrc\" \"$HOME/.bashrc\" \"$HOME/.bash_profile\" \"$HOME/.profile\"; do".to_string(),
        "    [ -f \"$rc\" ] || continue".to_string(),
        "    if grep -qF \"# GWork Desktop CLI\" \"$rc\" 2>/dev/null || grep -qF \"# Gourd AI Desktop CLI\" \"$rc\" 2>/dev/null; then".to_string(),
        "        tmp=\"$(mktemp)\"".to_string(),
        "        awk '".to_string(),
        "            skip == 1 { skip = 0; next }".to_string(),
        "            $0 == \"# GWork Desktop CLI\" || $0 == \"# Gourd AI Desktop CLI\" { skip = 1; next }".to_string(),
        "            { print }".to_string(),
        "        ' \"$rc\" > \"$tmp\" && mv \"$tmp\" \"$rc\" || rm -f \"$tmp\"".to_string(),
        "    fi".to_string(),
        "done".to_string(),
        "# 助手自删".to_string(),
        "rm -f \"$0\" 2>/dev/null".to_string(),
        String::new(),
    ];
    lines.join("\n")
}

// ── 写文件 ──────────────────────────────────────────────────────────────────

fn write_script(file_path: &Path, content: &str, executable: bool) -> std::io::Result<()> {
    std::fs::write(file_path, content)?;
    #[cfg(unix)]
    {
        if executable {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(file_path)?.permissions();
            perms.set_mode(0o755);
            let _ = std::fs::set_permissions(file_path, perms);
        }
    }
    let _ = executable;
    Ok(())
}

// ── PATH 注册 ───────────────────────────────────────────────────────────────

/// Windows：通过 PowerShell 的 .NET API 把用户主目录的 ~/.gwork/bin 加入用户 PATH（幂等）。
/// 同时清理任何以 resources\extraResources\旧全局目录\bin 结尾的历史桌面 PATH，
/// 但不触碰用户独立 CLI 的安装目录。
#[cfg(windows)]
async fn ensure_path_windows() {
    let bin_dir_str = bin_dir().to_string_lossy().to_string();
    let legacy_suffixes = [
        "\\resources\\extraResources\\.gwork\\bin",
        "\\resources\\extraResources\\.gourdai\\bin",
        "\\resources\\extraResources\\.gourdai\\.gourdai\\bin",
    ];
    let bin_json = serde_json::to_string(&bin_dir_str).unwrap_or_else(|_| format!("\"{}\"", bin_dir_str));
    let legacy_json = serde_json::to_string(&legacy_suffixes)
        .unwrap_or_else(|_| "[]".to_string());
    let ps_script = [
        format!("$d = {}", bin_json),
        format!("$legacySuffixes = {}", legacy_json),
        "$p = [Environment]::GetEnvironmentVariable(\"Path\",\"User\")".to_string(),
        "if ($p) {".to_string(),
        "    $clean = (($p -split \";\" | Where-Object { $entry = $_; $entry -and -not ($legacySuffixes | Where-Object { $entry.TrimEnd(\"\\\").ToLowerInvariant().EndsWith($_.ToLowerInvariant()) }) }) -join \";\")".to_string(),
        "    if ($clean -ne $p) { [Environment]::SetEnvironmentVariable(\"Path\", $clean, \"User\"); $p = $clean }".to_string(),
        "}".to_string(),
        "if ([string]::IsNullOrEmpty($p)) {".to_string(),
        "    [Environment]::SetEnvironmentVariable(\"Path\", $d, \"User\")".to_string(),
        "} elseif (($p -split \";\" | ForEach-Object { $_.TrimEnd(\"\\\") }) -notcontains $d.TrimEnd(\"\\\")) {".to_string(),
        "    [Environment]::SetEnvironmentVariable(\"Path\", ($p.TrimEnd(\";\") + \";\" + $d), \"User\")".to_string(),
        "}".to_string(),
    ]
    .join("\n");

    // PowerShell -EncodedCommand 需要 UTF-16LE 的 base64
    let utf16le: Vec<u8> = ps_script
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &utf16le);

    let mut cmd = tokio::process::Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        &encoded,
    ])
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null());

    // 必须显式 CREATE_NO_WINDOW：powershell.exe 是**控制台子系统**程序，父进程
    // （GUI 子系统的 tauri exe）本身没有控制台，Windows 会为它新建一个控制台窗口。
    // 表现即「启动瞬间闪过一个黑色命令行窗口」。重定向 stdio 不能抑制这个窗口，
    // -WindowStyle Hidden 也只作用于 PowerShell 自己后续创建的窗口，均需靠该 flag 兜住。
    // 注：tokio::process::Command 自带 `creation_flags` 固有方法（Windows），
    // 无需再引入 std::os::windows::process::CommandExt。
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let result = cmd.output().await;

    match result {
        Ok(out) => {
            if !out.status.success() {
                warn!(
                    "[cli-provision] 配置用户 PATH 失败: powershell 退出码 {:?}",
                    out.status.code()
                );
            }
        }
        Err(e) => {
            warn!("[cli-provision] 配置用户 PATH 失败: {}", e);
        }
    }
}

/// Unix：把 PATH 段追加到对应 shell 的 rc 文件（幂等，靠 marker 判重）。
/// 同时清理历史桌面端写入的旧 PATH 行，否则旧 bin 里的启动器仍在 PATH 中且可能排在前面，
/// `gwork` 会解析到旧启动器，其 -Dgwork.home 指向旧位置。
#[cfg(not(windows))]
fn ensure_path_unix() {
    let home = resolve_user_home();
    let bin_dir_str = bin_dir().to_string_lossy().to_string();
    let marker = "# GWork Desktop CLI";
    let line = format!("export PATH=\"$PATH:{}\"", bin_dir_str);
    let shell = std::env::var("SHELL")
        .ok()
        .and_then(|s| PathBuf::from(s).file_name().map(|n| n.to_string_lossy().to_string()))
        .unwrap_or_else(|| "bash".to_string());

    // 历史桌面端 PATH 行（逐个比对，不做模糊包含匹配，避免误删用户自装 CLI 的行）：
    // - 品牌升级前的 ~/.gourdai/bin 与旧版 bug 期的嵌套 ~/.gourdai/.gourdai/bin
    // - macOS 旧全局区：~/Library/Application Support/Gourd AI/.gwork（及 .gourdai）/bin
    let mut legacy_bin_dirs: Vec<String> = vec![
        home.join(".gourdai").join("bin").to_string_lossy().to_string(),
        home.join(".gourdai").join(".gourdai").join("bin").to_string_lossy().to_string(),
    ];
    #[cfg(target_os = "macos")]
    {
        let mac_app_support = home.join("Library").join("Application Support").join("Gourd AI");
        legacy_bin_dirs.push(mac_app_support.join(".gwork").join("bin").to_string_lossy().to_string());
        legacy_bin_dirs.push(mac_app_support.join(".gourdai").join("bin").to_string_lossy().to_string());
        legacy_bin_dirs.push(
            mac_app_support
                .join(".gourdai")
                .join(".gourdai")
                .join("bin")
                .to_string_lossy()
                .to_string(),
        );
    }
    // Linux deb 旧版把全局区放在安装资源目录（如 /opt/GWork/resources/extraResources/.gwork/bin），
    // 安装前缀不固定，改用后缀匹配。
    let legacy_suffixes = [
        "/resources/extraResources/.gwork/bin",
        "/resources/extraResources/.gourdai/bin",
        "/resources/extraResources/.gourdai/.gourdai/bin",
    ];

    let is_legacy_path_line = |text: &str| -> bool {
        if !text.contains("export PATH=") {
            return false;
        }
        if text.contains(&bin_dir_str) {
            return false; // 当前目标行，保留
        }
        if legacy_bin_dirs.iter().any(|dir| text.contains(dir.as_str())) {
            return true;
        }
        legacy_suffixes.iter().any(|suffix| text.contains(suffix))
    };

    let mut files: Vec<PathBuf> = Vec::new();
    if shell == "zsh" {
        files.push(home.join(".zshrc"));
    } else if shell == "bash" {
        #[cfg(target_os = "macos")]
        {
            files.push(home.join(".bash_profile"));
            files.push(home.join(".bashrc"));
        }
        #[cfg(not(target_os = "macos"))]
        {
            files.push(home.join(".bashrc"));
            files.push(home.join(".bash_profile"));
        }
    } else {
        files.push(home.join(".profile"));
        files.push(home.join(".bashrc"));
        files.push(home.join(".zshrc"));
    }

    for file in files {
        let _ = (|| -> std::io::Result<()> {
            let mut existing = String::new();
            if file.exists() {
                existing = std::fs::read_to_string(&file)?;
                let original: Vec<&str> = existing.split('\n').collect();
                let lines: Vec<&str> = original
                    .iter()
                    .filter(|l| !is_legacy_path_line(l))
                    .copied()
                    .collect();
                if lines.len() != original.len() {
                    existing = lines.join("\n");
                    std::fs::write(&file, &existing)?;
                }
                if existing.contains(&bin_dir_str) {
                    // 品牌迁移：旧版写入的 rc 注释标记刷新为新品牌名（PATH 行本身不变，幂等）
                    if existing.contains("# Gourd AI Desktop CLI") {
                        let refreshed = existing.replace("# Gourd AI Desktop CLI", marker);
                        std::fs::write(&file, refreshed)?;
                    }
                    return Ok(()); // 已配置
                }
            } else if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let prefix = if existing.ends_with('\n') || existing.is_empty() {
                ""
            } else {
                "\n"
            };
            let mut f = std::fs::OpenOptions::new().append(true).create(true).open(&file)?;
            use std::io::Write;
            writeln!(f, "{}\n{}\n{}", prefix, marker, line)?;
            Ok(())
        })();
    }
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

/// 注册（或自愈刷新）桌面端的 `gwork` 终端命令。
/// 幂等、非阻塞、全程兜底。定位不到自带运行时则跳过（绝不回退系统 Java）。
///
/// 返回 `Ok(true)` 表示成功写入启动器；`Ok(false)` 表示跳过；`Err` 仅在出现
/// 不可恢复的内部错误时返回（调用方应降级为 warn 处理）。
pub async fn provision_cli() -> Result<bool, anyhow::Error> {
    // Linux AppImage：资源路径是临时挂载（退出即失效），不能烤进常驻启动器 → 跳过。
    if is_appimage() {
        warn!("[cli-provision] 检测到 AppImage 运行环境（资源路径临时），跳过终端命令注册");
        return Ok(false);
    }

    // 启动器/PATH 使用用户主目录的 ~/.gwork；迁移在写入前完成，
    // 确保旧安装目录启动器不会重新成为默认命令。
    if let Err(e) = crate::migration::migrate_global_data() {
        warn!("[cli-provision] 全局目录迁移失败（不影响终端命令注册）: {}", e);
    }

    let java_path = bundled_java();
    let jar_path = bundled_jar();
    let (java_path, jar_path) = match (java_path, jar_path) {
        (Some(j), Some(k)) => (j, k),
        (j, k) => {
            warn!(
                "[cli-provision] 未找到自带 JRE/JAR，跳过终端命令注册 (java={:?}, jar={:?})",
                j, k
            );
            return Ok(false);
        }
    };

    let bin = bin_dir();
    std::fs::create_dir_all(&bin)
        .with_context(|| format!("创建启动器目录失败: {}", bin.display()))?;

    let mut java_opts = build_java_opts(bundled_java_major());
    // 打包版 CLI 文件日志同样仅输出 ERROR（与后端一致，防 DEBUG 日志撑爆全局区）
    if !cfg!(debug_assertions) {
        java_opts.push("-Dsolon.logging.appender.file.level=ERROR".to_string());
    }
    // 全局配置区基目录固定为用户主目录；启动器实际使用 ~/.gwork。
    let home_dir_str = runtime_home_dir().to_string_lossy().to_string();
    let java_path_str = java_path.to_string_lossy().to_string();
    let jar_path_str = jar_path.to_string_lossy().to_string();

    // 三种启动器一律重写（自愈：安装目录变化后自动指向新路径）
    write_script(
        &bin.join("gwork.bat"),
        &bat_content(&java_path_str, &jar_path_str, &java_opts, &home_dir_str),
        false,
    )?;
    write_script(
        &bin.join("gwork.ps1"),
        &ps1_content(&java_path_str, &jar_path_str, &java_opts, &home_dir_str),
        false,
    )?;
    write_script(
        &bin.join("gwork"),
        &sh_content(&java_path_str, &jar_path_str, &java_opts, &home_dir_str),
        true,
    )?;

    // 品牌升级：删除旧命令残留（仅限带桌面端 sentinel 的，CLI 安装模式的同名文件不受影响）
    for legacy_name in ["gourdai.bat", "gourdai.ps1", "gourdai"] {
        let legacy_path = bin.join(legacy_name);
        let _ = (|| -> std::io::Result<()> {
            if legacy_path.exists() {
                let content = std::fs::read_to_string(&legacy_path)?;
                if content.contains(SENTINEL) {
                    std::fs::remove_file(&legacy_path)?;
                    info!("[cli-provision] 已清理旧命令残留: {}", legacy_path.display());
                }
            }
            Ok(())
        })();
    }

    // 卸载助手（win 由卸载器调用，unix 供手动执行）
    #[cfg(windows)]
    write_script(&bin.join("desktop-cli-uninstall.ps1"), &uninstall_ps1_content(), false)?;
    #[cfg(not(windows))]
    write_script(&bin.join("desktop-cli-uninstall.sh"), &uninstall_sh_content(), true)?;

    // 配置 PATH（幂等）
    #[cfg(windows)]
    ensure_path_windows().await;
    #[cfg(not(windows))]
    ensure_path_unix();

    info!(
        "[cli-provision] 终端命令已就绪: {} （新开终端后可用 `gwork cli` / `gwork web 0`）",
        bin.join("gwork").display()
    );
    Ok(true)
}
