; hooks.nsh —— Tauri v2 NSIS 安装器钩子（由 bundle.windows.nsis.installerHooks 接入）
;
; 机制核实（字段名不是猜的，三条独立证据）：
;   1) 本机 crate 源码 tauri-utils-2.9.3/src/config.rs:909-939（与 src-tauri/Cargo.lock 里
;      tauri-build 2.6.3 / tauri 2.11.5 对应的解析版本）：NsisConfig 有
;      `pub installer_hooks: Option<PathBuf>`，带 `#[serde(alias = "installer-hooks")]`，
;      而 NsisConfig 整个结构体是 `#[serde(rename_all = "camelCase", deny_unknown_fields)]`
;      —— 所以 JSON 键必须写 installerHooks，写错键名会直接被 schema 拒绝而不是静默忽略。
;   2) 官方文档 https://v2.tauri.app/distribute/windows-installer/ 的「Extending the Installer」
;      给出同一段示例：{ "bundle": { "windows": { "nsis": { "installerHooks": "./windows/hooks.nsh" } } } }
;      并列出四个钩子宏名；docs.rs 的 NsisConfig 页面（tauri_utils::config::NsisConfig::installer_hooks）同文。
;   3) 官方模板 crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi：顶部
;      `{{#if installer_hooks}} !include "{{installer_hooks}}" {{/if}}`，Section Install 内
;      `!ifmacrodef NSIS_HOOK_PREINSTALL` → `!insertmacro NSIS_HOOK_PREINSTALL` → 之后才
;      `!insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe"` 与 File /a 拷贝资源。
;      即 PREINSTALL 早于「杀主进程 + 覆盖文件」，正是唯一还来得及释放占用的时机
;      （与 Electron 线 gourd-ai-desktop/cmd/installer.nsh 里 customInit 所处的位置对位）。
;   ⇒ 结论：Tauri v2 原生支持该钩子，无需 template 整模板覆盖（也就没有与官方模板漂移的代价）。
;
; 为什么要这个钩子（故障链，与 Electron 线同源，这里只列本线特有的差异）：
;   桌面端启动时拉起 javaw.exe 跑 extraResources\gourd-ai-agent.jar，其执行映像就是安装目录内的
;   extraResources\jre\bin\javaw.exe（本机实测过的真实路径形如 D:\<apps>\GWork\extraResources\jre\bin\javaw.exe，
;   注意 Tauri 线的 resources 直接落在 $INSTDIR\extraResources\ 下，没有 Electron 那层 resources\）。
;   关窗只隐藏到托盘，只有 RunEvent::Exit 才 stopBackend；模板自带的 CheckIfAppIsRunning 只管
;   "${MAINBINARYNAME}.exe"，从不管 java / javaw → 主进程被回收后 javaw 成孤儿，继续占着 jre 与 jar；
;   运行中映像禁止改名与删除 → File /a 覆盖失败（模板未开启重试，失败即静默跳过）→
;   新 jar + 旧 jre（或新旧 exe 混编）的部分覆盖 → 新装后端起不来 → 全部 /web/** 接口不通。
;   全新机器无残留进程，故永远复现不了，只能由安装器主动回收。
;
; 为什么绝不能用 `taskkill /im javaw.exe`：用户机器上的 java 进程几乎一定不止我们这一个
;   （IDEA / Android Studio / Gradle daemon / 各类自建服务），按映像名批量杀 = 不可接受的误杀。
;   判据只认「可执行文件完整路径是否位于本安装目录之下」，前缀不成立就绝不动手。
;   Tauri 线是 currentUser 安装，$INSTDIR 在 Section Install 里已经确定（模板在插本钩子之前刚
;   SetOutPath $INSTDIR），因此无需读注册表就没有「拿不到旧目录」的缺口 —— 这点比 Electron 线更稳。
;
; 为什么用 FileOpen 逐行写出 .ps1，而不是把 PowerShell 塞进 nsExec 的引号串：
;   ${if}、双引号、反引号、$变量 在 NSIS 与 PowerShell 之间会被反复展开，属于转义地狱。改成
;   「纯文本脚本 + 旁挂数据文件」后：安装目录值不走命令行（写进同目录下的 .root.txt 由脚本自读），
;   路径含空格、含单引号、含 $ 都不会破坏解析；脚本正文刻意保持纯 ASCII 且不含 " 与 \，
;   这样 NSIS 的 FileWrite（按 ANSI/ACP 落盘）与 PowerShell 读到的字节完全一致。
;   代价：FileWrite 串里每个美元符都要写成 $$（NSIS 的转义），改脚本时别漏。
;
; 两份实现的关系：本文件的 gworkKillProcsUnder 宏与 gourd-ai-desktop/cmd/installer.nsh 里的同名宏
;   必须逐字一致（两条安装线共用同一份判杀语义）。改一处就要改另一处，别只改一边。
;
; 刻意不接 NSIS_HOOK_PREUNINSTALL：卸载段的判杀会抢在模板自带的「应用正在运行」确认提示之前把后端
;   干掉，等于改掉既有交互语义；而覆盖安装与自动更新都走 Section Install，已被 PREINSTALL 覆盖。
;
; 不要给本文件加 !ifndef 式包含保护：Tauri 的模板会针对安装器与卸载器分别编译同一份源码，
;   预处理器状态跨编译趟并不保证重置，加了保护反而可能在第二趟里丢掉宏定义。

; ── 辅助宏：向 $PLUGINSDIR 写出判杀脚本并执行一次 ───────────────────────────
; 参数 _oldDir：需要清理占用的安装目录（本线传 $INSTDIR）。整个宏不阻断安装：失败只 DetailPrint。
!macro gworkKillProcsUnder _oldDir
  ; 确保 $PLUGINSDIR 存在再写文件（写不进就跳过，不影响安装主流程）
  InitPluginsDir

  ; 第一步：目标安装目录写成旁挂数据文件。绝不用命令行传参 —— 路径尾部反斜杠 + 引号会让
  ; CommandLineToArgvW 把结尾引号吃掉，单引号/$ 同理，用文件承载则完全免疫。
  StrCpy $R7 ""
  ClearErrors
  FileOpen $R7 "$PLUGINSDIR\gwork-old-install.root.txt" w
  ${if} ${Errors}
    DetailPrint "gwork-kill: cannot create root file in $PLUGINSDIR; skip process cleanup"
  ${else}
    FileWrite $R7 "${_oldDir}$\r$\n"
    FileClose $R7

    ; 第二步：逐行落盘判杀脚本（一行一条 FileWrite；正文已在本机抽取后实测）。
    ClearErrors
    FileOpen $R7 "$PLUGINSDIR\gwork-kill-procs.ps1" w
    ${if} ${Errors}
      DetailPrint "gwork-kill: cannot create helper script in $PLUGINSDIR; skip process cleanup"
    ${else}
      FileWrite $R7 "# gwork-kill-procs.ps1 -- written at runtime by the installer; do not hand-edit.$\r$\n"
      FileWrite $R7 "# Releases file locks held by processes whose executable image lives inside a previous$\r$\n"
      FileWrite $R7 "# install directory, so that jar / jre / asar files can actually be overwritten.$\r$\n"
      FileWrite $R7 "# A process is stopped ONLY when its ExecutablePath starts with one of the roots found in$\r$\n"
      FileWrite $R7 "# a sibling *.root.txt. The image names below are a scan filter, never a kill criterion:$\r$\n"
      FileWrite $R7 "# JVMs owned by an IDE, Android Studio, Gradle or a self-hosted service must survive.$\r$\n"
      FileWrite $R7 "# Keep this body ASCII, without double quotes and without backslashes: FileWrite stores$\r$\n"
      FileWrite $R7 "# ANSI(ACP) bytes, so ASCII keeps both sides byte-identical, and every dollar sign has$\r$\n"
      FileWrite $R7 "# to be doubled for the NSIS string that carries it.$\r$\n"
      FileWrite $R7 "$$ErrorActionPreference = 'SilentlyContinue'$\r$\n"
      FileWrite $R7 "$$ProgressPreference = 'SilentlyContinue'$\r$\n"
      FileWrite $R7 "$$roots = @()$\r$\n"
      FileWrite $R7 "foreach ($$rf in @(Get-ChildItem -LiteralPath $$PSScriptRoot -Filter *.root.txt)) {$\r$\n"
      FileWrite $R7 "  $$raw = [IO.File]::ReadAllBytes($$rf.FullName)$\r$\n"
      FileWrite $R7 "  if ($$raw.Length -lt 1) { continue }$\r$\n"
      FileWrite $R7 "  $$txt = $$null$\r$\n"
      FileWrite $R7 "  if ($$raw.Length -ge 3 -and $$raw[0] -eq 239 -and $$raw[1] -eq 187 -and $$raw[2] -eq 191) {$\r$\n"
      FileWrite $R7 "    $$txt = [Text.Encoding]::UTF8.GetString($$raw, 3, $$raw.Length - 3)$\r$\n"
      FileWrite $R7 "  } else {$\r$\n"
      FileWrite $R7 "    try { $$txt = (New-Object Text.UTF8Encoding($$false, $$true)).GetString($$raw) } catch { $$txt = [Text.Encoding]::Default.GetString($$raw) }$\r$\n"
      FileWrite $R7 "  }$\r$\n"
      FileWrite $R7 "  $$root = $$txt.Trim().TrimEnd([char]92)$\r$\n"
      FileWrite $R7 "  if ($$root.Length -gt 0) { $$roots += $$root }$\r$\n"
      FileWrite $R7 "}$\r$\n"
      FileWrite $R7 "if ($$roots.Count -lt 1) {$\r$\n"
      FileWrite $R7 "  Write-Output 'gwork-kill: no install root supplied; skip'$\r$\n"
      FileWrite $R7 "  exit 0$\r$\n"
      FileWrite $R7 "}$\r$\n"
      FileWrite $R7 "$$names = @('GWork.exe', 'java.exe', 'javaw.exe')$\r$\n"
      FileWrite $R7 "$$victims = @()$\r$\n"
      FileWrite $R7 "foreach ($$p in @(Get-CimInstance -ClassName Win32_Process)) {$\r$\n"
      FileWrite $R7 "  if ($$names -notcontains $$p.Name) { continue }$\r$\n"
      FileWrite $R7 "  if ($$p.ProcessId -eq $$PID) { continue }$\r$\n"
      FileWrite $R7 "  $$exe = [string]$$p.ExecutablePath$\r$\n"
      FileWrite $R7 "  if ($$exe.Length -lt 1) { continue }$\r$\n"
      FileWrite $R7 "  foreach ($$r in $$roots) {$\r$\n"
      FileWrite $R7 "    if ($$exe.StartsWith($$r + [char]92, [StringComparison]::OrdinalIgnoreCase)) {$\r$\n"
      FileWrite $R7 "      $$victims += [PSCustomObject]@{ Pid = $$p.ProcessId; Name = $$p.Name; Exe = $$exe }$\r$\n"
      FileWrite $R7 "      break$\r$\n"
      FileWrite $R7 "    }$\r$\n"
      FileWrite $R7 "  }$\r$\n"
      FileWrite $R7 "}$\r$\n"
      FileWrite $R7 "if ($$victims.Count -lt 1) {$\r$\n"
      FileWrite $R7 "  Write-Output ('gwork-kill: no process under ' + ($$roots -join ' ; '))$\r$\n"
      FileWrite $R7 "  exit 0$\r$\n"
      FileWrite $R7 "}$\r$\n"
      FileWrite $R7 "foreach ($$v in $$victims) {$\r$\n"
      FileWrite $R7 "  Write-Output ('gwork-kill: stopping ' + $$v.Name + ' pid=' + $$v.Pid + ' exe=' + $$v.Exe)$\r$\n"
      FileWrite $R7 "  Stop-Process -Id $$v.Pid -Force$\r$\n"
      FileWrite $R7 "}$\r$\n"
      FileWrite $R7 "$$pids = @($$victims | ForEach-Object { $$_.Pid })$\r$\n"
      FileWrite $R7 "$$deadline = (Get-Date).AddSeconds(5)$\r$\n"
      FileWrite $R7 "while ((Get-Date) -lt $$deadline) {$\r$\n"
      FileWrite $R7 "  $$alive = @($$pids | Where-Object { Get-Process -Id $$_ })$\r$\n"
      FileWrite $R7 "  if ($$alive.Count -lt 1) { break }$\r$\n"
      FileWrite $R7 "  Start-Sleep -Milliseconds 250$\r$\n"
      FileWrite $R7 "}$\r$\n"
      FileWrite $R7 "$$alive = @($$pids | Where-Object { Get-Process -Id $$_ })$\r$\n"
      FileWrite $R7 "if ($$alive.Count -gt 0) {$\r$\n"
      FileWrite $R7 "  Write-Output ('gwork-kill: still alive after 5s: pid ' + (($$alive | ForEach-Object { [string]$$_ }) -join ','))$\r$\n"
      FileWrite $R7 "} else {$\r$\n"
      FileWrite $R7 "  Write-Output 'gwork-kill: matched processes exited'$\r$\n"
      FileWrite $R7 "}$\r$\n"
      FileWrite $R7 "# Always exit 0. A lock that really survived must be surfaced by the installer itself.$\r$\n"
      FileWrite $R7 "exit 0$\r$\n"
      FileClose $R7

      ; 第三步：执行。脚本内部已「强杀 + 最多等 5 秒真实退出」，句柄释放需要这段等待。
      ; 安装器与 PowerShell 之间的通信只走这一个常量命令行，没有任何动态拼接。
      nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\gwork-kill-procs.ps1"'
      Pop $R6
      ${if} $R6 == "error"
        ; 企业环境里 powershell 可能被策略禁掉（本机就有 SRP 拦未签名 exe 的先例）；不能因此卡住安装。
        DetailPrint "gwork-kill: powershell.exe could not run (absent or policy-blocked); continue install"
      ${else}
        DetailPrint "gwork-kill: helper exit code=$R6"
      ${endif}
      Delete "$PLUGINSDIR\gwork-kill-procs.ps1"
      Delete "$PLUGINSDIR\gwork-old-install.root.txt"
    ${endif}
  ${endif}
  StrCpy $R7 ""
  StrCpy $R6 ""
  ClearErrors
!macroend

; ── 安装段最开始：释放旧文件占用 ────────────────────────────────────────────
!macro NSIS_HOOK_PREINSTALL
  DetailPrint "gwork-kill: releasing file locks under $INSTDIR"
  !insertmacro gworkKillProcsUnder "$INSTDIR"
!macroend
