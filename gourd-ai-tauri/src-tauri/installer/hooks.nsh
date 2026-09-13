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
;      `{{#if installer_hooks}} !include "{{installer_hooks}}" {{/if}}`，Section Install 内原生顺序是
;      PREINSTALL → CheckIfAppIsRunning → File。为保留官方交互确认语义，本项目的 template.nsi
;      将 PREINSTALL 精确移到 CheckIfAppIsRunning 成功之后、首个 File 之前；静默模式仍由官方宏
;      自动停止主进程，再由本钩子释放仅限 $INSTDIR 下的 orphan JVM 文件锁。
;   ⇒ 结论：hooks.nsh 通过 Tauri v2 原生 installerHooks 接入；仅调用时序由本项目模板调整。
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
; 卸载段接 NSIS_HOOK_PREUNINSTALL，但**只**在其中做 CLI 终端命令清理，刻意不做进程判杀。
;   template.nsi 已将该 hook 放到 CheckIfAppIsRunning 成功之后、首个 Delete 之前：交互卸载先由用户确认，
;   静默卸载则自动通过官方判杀流程。CLI 清理必须在删除应用文件前执行，否则卸载后
;   ~\.gwork\bin\gwork.bat 与用户 PATH 里的该目录条目残留，且 bat 指向已删除的
;   $INSTDIR\extraResources\jre —— 详见下方 NSIS_HOOK_PREUNINSTALL 处注释。
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

; ── 主进程检查成功之后、复制文件之前：释放旧文件占用 ──────────────────────────
!macro NSIS_HOOK_PREINSTALL
  DetailPrint "gwork-kill: releasing file locks under $INSTDIR"
  !insertmacro gworkKillProcsUnder "$INSTDIR"
!macroend

; ── 用户确认之后、删除文件之前：清理 CLI 终端命令与用户 PATH 条目 ─────────────────
; 为什么必须接这个钩子：App 首启时 cli_provision 会把启动器写进**用户全局区** ~\.gwork\bin，
;   并把该目录加进用户 PATH（src-tauri/src/cli_provision.rs：HARNESS_HOME = ".gwork"，
;   bin_dir() = resolve_user_home()\.gwork\bin，Windows 上 resolve_user_home() 取 USERPROFILE；
;   PATH 由 ensure_path_windows() 写 HKCU\Environment）。全局区不随 $INSTDIR 删除，而模板自带的
;   卸载逻辑只删 $INSTDIR（template.nsi 的 Section Uninstall：从 "; Delete the app directory"
;   一直到 RMDir "$INSTDIR" 那一段），于是卸载后 gwork.bat 残留，且 bat 里烤死的
;   javaw / jar 路径指向已消失的 $INSTDIR\extraResources\jre → 用户命令行里留下一个必然失败的
;   `gwork` 入口。Electron 线在 gourd-ai-desktop/cmd/installer.nsh:264-281 的 customRemoveFiles
;   里做了同一件事，本线此前缺失。
; 为什么调助手 ps1、而不是用 NSIS 原语内联：Tauri 侧**已经有**这份助手 —— cli_provision.rs:657-658
;   在 provision 时写出 ~\.gwork\bin\desktop-cli-uninstall.ps1，其函数注释（同文件 283-286 行）
;   明确写着「由卸载器在删除应用文件**之前**调用」，即它本来就是为这个钩子准备的，只是一直没被挂上。
;   与 Electron 线用的是同一个文件名、同一个 ~\.gwork\bin 路径、同一条 powershell 命令行，
;   语义天然对齐。反过来若用 NSIS 原语重写一份，就会出现两套判据（启动器归属的 sentinel 匹配、
;   与独立 CLI 安装模式共存的判定、PATH 条目的精确摘除），必然随时间漂移。
; 为什么 PREUNINSTALL 而不是 POSTUNINSTALL：助手要求在删除应用文件之前调用；template.nsi 将
;   `!insertmacro NSIS_HOOK_PREUNINSTALL` 放在 CheckIfAppIsRunning 成功之后、首个 Delete 之前，
;   同时满足用户确认和助手生命周期要求。助手位于用户主目录，与 $INSTDIR 生命周期无关。
; 为什么这里**不**做进程判杀：主进程已经由紧邻其前的官方 CheckIfAppIsRunning 处理；重复按名称判杀
;   没有必要。安装时的 orphan java/javaw 则由 PREINSTALL 按可执行文件完整路径归属处理。
; PATH 安全性：绝不清空、也绝不重写整个 PATH。摘除逻辑在助手内（cli_provision.rs:305-316）：
;   先按 $bin 全等比较过滤用户 PATH（$_.TrimEnd("\") -ne $target），只摘掉本项目自己加的那一项；
;   且仅当目录内已无其它启动器、也不存在 CLI 安装模式（gourd-ai-agent.jar）时才动手；
;   启动器本身也只删带 SENTINEL（"gourd-ai-desktop-provisioned"）的那几个，独立 CLI 的同名文件不受影响。
; 助手可能不存在（App 从未启动过 → 从未 provision），故用 ${FileExists} 守卫；调用失败也只
;   DetailPrint，绝不阻断卸载（与 gworkKillProcsUnder 同一口径）。
!macro NSIS_HOOK_PREUNINSTALL
  Push $R6
  ${if} ${FileExists} "$PROFILE\.gwork\bin\desktop-cli-uninstall.ps1"
    DetailPrint "gwork-cli: removing 'gwork' terminal command and its user PATH entry"
    nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PROFILE\.gwork\bin\desktop-cli-uninstall.ps1"'
    Pop $R6
    ${if} $R6 == "error"
      ; 企业环境里 powershell 可能被策略禁掉（本机就有 SRP 拦未签名 exe 的先例）；不能因此卡住卸载。
      DetailPrint "gwork-cli: powershell.exe could not run (absent or policy-blocked); continue uninstall"
    ${else}
      DetailPrint "gwork-cli: helper exit code=$R6"
    ${endif}
  ${else}
    DetailPrint "gwork-cli: no helper under $PROFILE\.gwork\bin; nothing to clean"
  ${endif}
  Pop $R6
  ClearErrors
!macroend

; ── UI 排版修复：宋体 9pt 行距过密 + radio/checkbox 8u 高度裁切文字 ───────────────
; 证据（2026-09-09 本机实测：Win32 枚举运行中安装器各控件的字体与矩形）：
;   1) SimpChinese.nlf 的字体是宋体 9，内层对话框的 MS Shell Dlg 在中文系统也落到宋体：
;      CJK 字形墨迹几乎撑满 em 盒，tmInternalLeading 仅 3px，相邻换行视觉「贴在一起」，
;      即用户反馈的「换行之间没间隔、文字挤在一起」；
;   2) 模板维护页 ${NSD_CreateRadioButton} ... 8u 实测高度仅 12px，而正文字体行高
;      tmHeight=16px，单行文字被上下裁切，即用户反馈的「字被遮挡」
;      （实测维护页两个 Button rect 406x12、字体 tmH=16）；卸载页复选框同病。
; 为什么不改模板：与本文件开头同源的理由——整模板覆盖有跟官方升级漂移的代价；
;   MUI2 留了两个模板未占用的全局注入点（Interface.nsh:299/317）：
;   MUI_CUSTOMFUNCTION_GUIINIT（安装趟）/ MUI_CUSTOMFUNCTION_UNGUIINIT（卸载趟），
;   它们在本文件 !include 之后才展开，在这里定义必然生效。
; 做法：GUIInit 里按 DPI 创建微软雅黑 9pt 常规/粗体与 12pt 粗体（标题用）三把字体，
;   内层页面控件则由文件尾的 NSD_Create* 包装宏在创建时刻同步设字体 + 补高度：
;   两级遍历 $HWNDPARENT 子窗（内层对话框与底部按钮）+ 内层对话框子窗（当页控件），
;   按原字体 weight/字号挑对应雅黑字体 WM_SETFONT（保住 header 标题的粗体与大字号）；
;   对高度小于「字体像素高+6」的 Button 类控件（radio/checkbox；下一步/取消按钮自身
;   21px 足够高，天然免疫）MoveWindow 补足高度。全部幂等：字体句柄相同且高度够就
;   什么都不做，无闪烁；扫一遍约 20 个控件、纯轻量消息，开销可忽略。
; 字体创建失败的极端环境（雅黑被精简掉）保持宋体原样，绝不让安装器因此异常。
!define MUI_CUSTOMFUNCTION_GUIINIT GWorkUiInit
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.GWorkUiInit

Var GWorkFontNormal   ; 雅黑 9pt 常规
Var GWorkFontBold     ; 雅黑 9pt 粗体
Var GWorkFontHeader   ; 雅黑 12pt 粗体（header/欢迎页标题）
Var GWorkFontPx       ; 9pt 的像素高（正数），控件最小高度基准
Var GWorkLogFontBuf   ; 复用的 92 字节 LOGFONT 缓冲
Var GWorkRectBuf      ; 复用的 16 字节 RECT 缓冲
Var GWorkTextBuf      ; 复用的 2048 字节窗体文本缓冲（Static 行wrap测高用）
Var GWorkTmBuf        ; 复用的 128 字节 TEXTMETRIC 缓冲（品牌文字行高测量用）

!macro GWorkUiFontFix SUF
Function ${SUF}GWorkUiInit
  ; 9pt -> 像素高，跟随系统 DPI：MulDiv(9, LOGPIXELSY, 72)
  System::Call 'user32::GetDC(p 0) i .r0'
  System::Call 'gdi32::GetDeviceCaps(i r0, i 90) i .r1'
  System::Call 'user32::ReleaseDC(p 0, i r0)'
  System::Call 'kernel32::MulDiv(i 9, i r1, i 72) i .r2'
  StrCpy $GWorkFontPx $2
  IntOp $2 0 - $2
  ; charset 134 (GB2312)、输出质量 5 (CLEARTYPE)
  System::Call 'gdi32::CreateFontW(i r2, i 0, i 0, i 0, i 400, i 0, i 0, i 0, i 134, i 3, i 2, i 1, i 5, w "Microsoft YaHei") i .s'
  Pop $GWorkFontNormal
  System::Call 'gdi32::CreateFontW(i r2, i 0, i 0, i 0, i 700, i 0, i 0, i 0, i 134, i 3, i 2, i 1, i 5, w "Microsoft YaHei") i .s'
  Pop $GWorkFontBold
  System::Call 'kernel32::MulDiv(i 12, i r1, i 72) i .r2'
  IntOp $2 0 - $2
  System::Call 'gdi32::CreateFontW(i r2, i 0, i 0, i 0, i 700, i 0, i 0, i 0, i 134, i 3, i 2, i 1, i 5, w "Microsoft YaHei") i .s'
  Pop $GWorkFontHeader
  StrCmp $GWorkFontNormal 0 gwork_uiinit_done
  System::Alloc 92
  Pop $GWorkLogFontBuf
  System::Alloc 16
  Pop $GWorkRectBuf
  System::Alloc 2048
  Pop $GWorkTextBuf
  ; TEXTMETRICW 实测 60 字节（11×LONG + 4×WCHAR + 5×BYTE），128 留足对齐余量
  System::Alloc 128
  Pop $GWorkTmBuf
  SendMessage $HWNDPARENT 0x0030 $GWorkFontNormal 1   ; WM_SETFONT
  Call ${SUF}GWorkApplyFonts
  ; 品牌文字（版权行）：垂直对齐到按钮行 + 补足被控件高度裁掉的行高（详见下方函数头注释）
  Call ${SUF}GWorkAlignBrandingText
  ; 全局定时器：hwnd=0 不被页面切换销毁，每页新建的控件 25ms 内被扫到
  gwork_uiinit_done:
FunctionEnd


Function ${SUF}GWorkApplyFonts
  StrCmp $GWorkFontNormal 0 gwork_af_done
  Push $R0
  Push $R1
  StrCpy $R0 0
  gwork_af_l1:
  System::Call 'user32::FindWindowEx(p $HWNDPARENT, p R0, p 0, p 0) i .R0'
  StrCmp $R0 0 gwork_af_done2
  Push $R0
  Call ${SUF}GWorkApplyOne
  StrCpy $R1 0
  gwork_af_l2:
  System::Call 'user32::FindWindowEx(p R0, p R1, p 0, p 0) i .R1'
  StrCmp $R1 0 gwork_af_l1
  Push $R1
  Call ${SUF}GWorkApplyOne
  Goto gwork_af_l2
  gwork_af_done2:
  Pop $R1
  Pop $R0
  gwork_af_done:
FunctionEnd

; 栈顶取 hwnd；恢复所有用到的寄存器，保证对调用者零副作用
Function ${SUF}GWorkApplyOne
  Exch $R9
  Push $R8
  Push $R7
  Push $R6
  Push $R5
  Push $R4
  Push $R3
  Push $R2
  Push $R1
  Push $R0

  ; ── 高度补足：仅 Button 类且高度不够者 ──
  System::Call 'user32::GetClassName(p R9, t .R0, i 64)'
  StrCmp $R0 "Button" 0 gwork_ao_font
  System::Call 'user32::GetWindowRect(p R9, p $GWorkRectBuf)'
  System::Call '*$GWorkRectBuf(i .R4, i .R3, i .R2, i .R1)'   ; left,top,right,bottom（屏幕坐标）
  IntOp $R5 $R1 - $R3
  IntOp $R6 $GWorkFontPx + 6
  IntCmp $R5 $R6 gwork_ao_font gwork_ao_move gwork_ao_font    ; 已够高就跳过
  gwork_ao_move:
  System::Call 'user32::GetParent(p R9) i .R7'
  System::Call 'user32::MapWindowPoints(p 0, p R7, p $GWorkRectBuf, i 2)'
  System::Call '*$GWorkRectBuf(i .R4, i .R3, i .R2, i .R1)'   ; 转父窗客户区坐标
  IntOp $R2 $R2 - $R4
  System::Call 'user32::MoveWindow(p R9, i R4, i R3, i R2, i R6, i 1)'

  ; ── 字体替换：按原 weight/字号选雅黑，幂等 ──
  gwork_ao_font:
  SendMessage $R9 0x0031 0 0 $R8                              ; WM_GETFONT
  StrCmp $R8 0 gwork_ao_wN
  System::Call 'gdi32::GetObjectW(i R8, i 92, p $GWorkLogFontBuf)'
  System::Call '*$GWorkLogFontBuf(i .R6, i .R7, i .R7, i .R7, i .R5)'  ; R6=lfHeight, R5=lfWeight
  IntCmpU $R5 600 gwork_ao_wN gwork_ao_wN gwork_ao_chkBig
  gwork_ao_chkBig:
  IntCmp $R6 -14 gwork_ao_wH gwork_ao_wH gwork_ao_wB          ; <=-14px 视为标题级字号
  gwork_ao_wH:
  StrCpy $R7 $GWorkFontHeader
  Goto gwork_ao_have
  gwork_ao_wB:
  StrCpy $R7 $GWorkFontBold
  Goto gwork_ao_have
  gwork_ao_wN:
  StrCpy $R7 $GWorkFontNormal
  gwork_ao_have:
  StrCmp $R8 $R7 gwork_ao_done
  SendMessage $R9 0x0030 $R7 1                                ; WM_SETFONT + 重绘

  ; ── 内层 Static：按实际行wrap高度补足控件高（原生页 DirText / finish 文本等）──
  System::Call 'user32::GetParent(p R9) i .R8'
  StrCmp $R8 $HWNDPARENT gwork_ao_done                        ; 外层对话框自带控件（header 等）不动
  System::Call 'user32::GetClassName(p R9, t .R7, i 64)'
  StrCmp $R7 "Static" 0 gwork_ao_done
  System::Call 'user32::GetWindowText(p R9, p $GWorkTextBuf, i 1024)'
  System::Call 'user32::GetWindowRect(p R9, p $GWorkRectBuf)'
  System::Call '*$GWorkRectBuf(i .R4, i .R3, i .R2, i .R1)'
  IntOp $R5 $R1 - $R3
  IntOp $R6 $R2 - $R4
  System::Call '*$GWorkRectBuf(i 0, i 0, i R6, i 0)'
  System::Call 'user32::GetDC(p R9) i .R8'
  SendMessage $R9 0x0031 0 0 $R7
  System::Call 'gdi32::SelectObject(i R8, i R7) i .R1'
  System::Call 'user32::DrawTextW(i R8, p $GWorkTextBuf, i -1, p $GWorkRectBuf, i 0x410)'  ; DT_CALCRECT|DT_WORDBREAK
  System::Call 'gdi32::SelectObject(i R8, i R1)'
  System::Call 'user32::ReleaseDC(p R9, i R8)'
  System::Call '*$GWorkRectBuf(i .R4, i .R3, i .R2, i .R1)'
  IntOp $R1 $R1 - $R3
  IntOp $R1 $R1 + 2
  IntCmp $R5 $R1 gwork_ao_done gwork_ao_move2 gwork_ao_done
  gwork_ao_move2:
  System::Call 'user32::GetWindowRect(p R9, p $GWorkRectBuf)'
  System::Call 'user32::GetParent(p R9) i .R8'
  System::Call 'user32::MapWindowPoints(p 0, p R8, p $GWorkRectBuf, i 2)'
  System::Call '*$GWorkRectBuf(i .R4, i .R3, i .R2, i .R6)'
  IntOp $R2 $R2 - $R4
  System::Call 'user32::MoveWindow(p R9, i R4, i R3, i R2, i R1, i 1)'
  gwork_ao_done:
  Pop $R0
  Pop $R1
  Pop $R2
  Pop $R3
  Pop $R4
  Pop $R5
  Pop $R6
  Pop $R7
  Pop $R8
  Pop $R9
FunctionEnd

; ── 品牌文字行对齐 + 高度补足：id 1256/1028 对齐到按钮行（id 1）中心，并补足被裁的高度 ──
; 现象（2026-09-11 用户反馈 + 本机 PrintWindow 像素剖面实测）：
;   a) 位置：维护页等「非 welcome/finish 页」显示品牌文字时
;      （MUI 在 .onGUIInit 里对 1256 设 WM_SETTEXT，并在这些页把它与 1028 置为可见），NSIS 3.11
;      的资源布局里品牌文字 rect (719,643) 483x12 与「标准分隔线」(id 1035) rect (719,651)
;      480x2 垂直重叠 2~3px：文字骑在线上，且其不透明行盒把线在文字宽度内「咬断」。
;   b) 高度（本轮修复）：GWorkApplyFonts 把品牌文字字体从对话框默认字体换成微软雅黑 9pt
;      （实测 tmHeight=16、tmAscent=13），但该控件是**外层对话框 $HWNDPARENT 的子窗**，
;      正是 GWorkApplyOne 里「StrCmp $R8 $HWNDPARENT gwork_ao_done」刻意跳过的那一类
;      （原意是避免误动 header），于是高度一直停在资源里的 12px。
;      12 < 16：Static 自顶部绘制，底部 4px（含 p / y / g 的降部）被控件边界裁掉。
;      实测证据：品牌文字墨迹只占 y=309..317 共 **9 行**，而**同一字体**的按钮文字为 11 行，
;      差额正是被裁掉的降部 —— 用户看到的就是「版权行下半截没了，像被一条线挡住」。
; 依据：官方「经典布局」（Source/exehead/resource.rc 的 IDD_INST）中 IDC_VERSTR 相对按钮行
;   垂直居中（按钮 142..156、文字 145..153：145 = 142 + (14-8)/2），「品牌文字与按钮同一
;   水平行」正是这套 UI 的初衷；本函数把同一关系施加到当前 rect 上：
;     target = max(文字自身字体 tmHeight + 2, $GWorkFontPx + 6)
;     newTop = 按钮top + (按钮高 - target) / 2（整除），x / 宽保持不变。
;   高度取「字体实测行高 + 2」而不是写死常量：DPI 缩放与字体回退都能自适应；下限用
;   $GWorkFontPx + 6 是为了与 radio/checkbox 包装宏 GWorkNSD_FixBtn 共用同一留白口径，
;   且字体/DC 任一不可得时它就是唯一可用值（此时退化为纯位置对齐，即上一版语义）。
; 安全性：基准只认「id=1 且类名为 Button」的控件，找不到即整段跳过；全部在「父窗客户坐标」
;   内运算（GetWindowRect → MapWindowPoints(0, $HWNDPARENT, ...) → MoveWindow，与
;   GWorkNSD_FixBtn 的既有套路一致）；幂等（高度已够则只改位置）；不动分隔线、不动 MUI 的
;   页面显隐；仅依赖 $GWorkRectBuf / $GWorkTmBuf（均在 UiInit 内分配，随字体句柄一起受
;   同一道守卫保护）。
; 覆盖范围：安装器与卸载器各展开一次（SUF 参数化），两者窗口结构相同（同一份 exehead 资源）。
Function ${SUF}GWorkAlignBrandingText
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8

  ; 基准控件：id=1 的按钮（安装器/卸载器各页都在）；顺带校验类名，防资源变动误伤
  System::Call 'user32::GetDlgItem(p $HWNDPARENT, i 1) i .R0'
  StrCmp $R0 0 gwork_abt_done
  System::Call 'user32::GetClassName(p R0, t .R7, i 64)'
  StrCmp $R7 "Button" 0 gwork_abt_done

  ; 按钮 rect：先屏幕坐标、再转父窗客户坐标；R5=按钮高、R6=按钮top
  System::Call 'user32::GetWindowRect(p R0, p $GWorkRectBuf)'
  System::Call 'user32::MapWindowPoints(p 0, p $HWNDPARENT, p $GWorkRectBuf, i 2)'
  System::Call '*$GWorkRectBuf(i .R1, i .R2, i .R3, i .R4)'
  IntOp $R5 $R4 - $R2
  StrCpy $R6 $R2

  ; ── 目标高度 R8：先落兜底值，再用品牌文字自身字体实测的行高顶上去 ──
  IntOp $R8 $GWorkFontPx + 6
  System::Call 'user32::GetDlgItem(p $HWNDPARENT, i 1256) i .R0'
  StrCmp $R0 0 gwork_abt_hset
  ; 缓冲必须真实存在：GetTextMetricsW 会向该指针写约 60 字节，传 NULL 是访问违例
  ;（和 GetWindowRect(hwnd, NULL) 那种「失败即返回 FALSE」的 API 不同）。Alloc 失败只在内存
  ;  耗尽时出现，但代价是安装器直接崩溃 —— 比「文字被裁」严重得多，所以显式挡住。
  StrCmp $GWorkTmBuf 0 gwork_abt_hset
  SendMessage $R0 0x0031 0 0 $R7                                ; WM_GETFONT
  StrCmp $R7 0 gwork_abt_hset
  System::Call 'user32::GetDC(p R0) i .R2'
  StrCmp $R2 0 gwork_abt_hset
  System::Call 'gdi32::SelectObject(i R2, i R7) i .R3'
  System::Call 'gdi32::GetTextMetricsW(i R2, p $GWorkTmBuf)'
  System::Call '*$GWorkTmBuf(i .R4)'                            ; tmHeight
  System::Call 'gdi32::SelectObject(i R2, i R3)'
  System::Call 'user32::ReleaseDC(p R0, i R2)'
  IntOp $R4 $R4 + 2
  ; 只有实测值更大时才采用它：相等/小于 → hset（保留兜底值），大于 → hbig（改用实测值）
  IntCmp $R4 $R8 gwork_abt_hset gwork_abt_hset gwork_abt_hbig
  gwork_abt_hbig:
  StrCpy $R8 $R4
  gwork_abt_hset:

  ; ── 上限钳制：目标高不得超过按钮高 ──
  ; 两个作用：① GWorkAlignOneBranding 要算 (按钮高 - 最终高) / 2，目标高更大时差值为负，
  ;   居中失去意义、控件还会向下溢出客户区；② 万一 GetTextMetricsW 未真正写入，读到的
  ;   未初始化缓冲可能是任意大值，这一步把异常值兜回按钮高。当前字号下不会触发
  ;   （96dpi：19 < 21），属于纯防御。
  IntCmp $R8 $R5 gwork_abt_hmax_ok gwork_abt_hmax_ok gwork_abt_hmax_fix
  gwork_abt_hmax_fix:
  StrCpy $R8 $R5
  gwork_abt_hmax_ok:

  ; 品牌文字控件 (id 1256 = MUI Branding.Text)
  System::Call 'user32::GetDlgItem(p $HWNDPARENT, i 1256) i .R0'
  Call ${SUF}GWorkAlignOneBranding

  ; 品牌文字背景控件 (id 1028 = MUI Branding.Background)：同法对齐（当前与 1256 同 rect）
  System::Call 'user32::GetDlgItem(p $HWNDPARENT, i 1028) i .R0'
  Call ${SUF}GWorkAlignOneBranding

  gwork_abt_done:
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

; 入参（约定复用寄存器，全部只读，不进 NSIS 栈）：
;   $R0 = 目标控件句柄   $R5 = 按钮高   $R6 = 按钮top   $R8 = 目标高度
; 自身临时寄存器 $R1..$R4 / $R7 在函数首尾 Push/Pop 保护（与 GWorkApplyOne 同一风格），
; 调用方无需再关心寄存器存活；$R5/$R6/$R8 全程只读，不动。
Function ${SUF}GWorkAlignOneBranding
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R7
  ; ⚠ 这 5 个 Push 必须排在下面那条零值判断之前：否则 $R0=0 时会直接跳到 gwork_aob_done
  ;   去 Pop，从调用者的栈上弹掉 5 个不属于本函数的字，把调用方彻底搞坏。
  StrCmp $R0 0 gwork_aob_done
  System::Call 'user32::GetWindowRect(p R0, p $GWorkRectBuf)'
  System::Call 'user32::MapWindowPoints(p 0, p $HWNDPARENT, p $GWorkRectBuf, i 2)'
  System::Call '*$GWorkRectBuf(i .R1, i .R2, i .R3, i .R4)'
  IntOp $R3 $R3 - $R1                       ; 宽（保持不变）
  IntOp $R7 $R4 - $R2                       ; 当前高
  ; 当前高 < 目标高 → 提升；>= 目标高 → 沿用当前高（不压缩已有留白）
  ; ⚠ IntCmp 三段跳转的顺序是【相等 / 小于 / 大于】（NSIS 手册 Reference/IntCmp），
  ;   不是直觉上的「小于 / 相等 / 大于」。此处曾写反一次，后果是本该补高的分支永不命中、
  ;   现象与「完全没改过」一模一样，极易被误判成「函数没被调用」而白绕一大圈。
  ;   同类三分支写法在 GWorkNSD_FixBtn / GWorkApplyOne 里也有，动任何一处前先对手册确认顺序。
  IntCmp $R7 $R8 gwork_aob_keep gwork_aob_big gwork_aob_keep
  gwork_aob_big:
  StrCpy $R7 $R8
  gwork_aob_keep:
  IntOp $R4 $R5 - $R7                       ; 按钮高 - 最终高
  IntOp $R4 $R4 / 2
  IntOp $R4 $R4 + $R6                       ; + 按钮top → 垂直居中于按钮行
  System::Call 'user32::MoveWindow(p R0, i R1, i $R4, i $R3, i $R7, i 1)'
  gwork_aob_done:
  Pop $R7
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
FunctionEnd
!macroend

!insertmacro GWorkUiFontFix ""
; ── 显式契约：上一行展开之后，Function GWorkApplyFonts 才真实存在 ───────────────────
; template.nsi 尾部的 Function GWorkNativePageShow 会 Call GWorkApplyFonts，而该 Function 不是
; 模板自带的，是上面这个宏（SUF="" 那次展开）生成的。NSIS 没有「某个 Function 是否存在」的
; 内建判断，所以只能靠「定义方 !define + 使用方 !ifdef」这种显式契约：一旦有人删掉
; tauri.conf.json 的 bundle.windows.nsis.installerHooks，hooks.nsh 整个不再被 include，
; template.nsi 那句 Call 会直接以 "Function not found" 编译失败，且报错不指向真因。
; 包含顺序已核实（下面一律用锚点而不是行号描述，行号会随模板改版漂移）：template.nsi 里
; `{{#if installer_hooks}} !include "{{installer_hooks}}" {{/if}}` 紧跟在 !include MUI2.nsh 等头部
; include 群之后、所有 !define 与 Section 之前；而 Call GWorkApplyFonts 在文件最末尾的
; Function GWorkNativePageShow 内。故本 !define 必然先于那边的 !ifdef 求值。
; 放在这一行（而不是宏体内）的原因：宏会被 SUF="" 与 SUF="un." 展开两次，写在宏体内会
; "already defined"；而 un.GWorkApplyFonts 的存在并不代表 GWorkApplyFonts 存在，故契约只跟
; SUF="" 这次展开绑定。
!define GWORK_APPLY_FONTS_DEFINED
!insertmacro GWorkUiFontFix "un."

; ── 内层控件：创建时刻同步设字体 + 补足高度（NSD_Create* 包装宏）─────────────
; 为什么不用全局定时器：System 插件 'k' 回调只在创建它的那次 System::Call 内同步有效
;   （实测 SetTimer 返回成功但回调永不触发）；MUI_PAGE_CUSTOMFUNCTION_SHOW 每页消费后
;   即 !undef（Pages.nsh:109），hooks 无法全局注入。但所有内层控件都经 nsDialogs 的
;   NSD_Create* 出生 —— 它们是 !define（nsDialogs.nsh:406-408 由 __NSD_DefineControl 生成），
;   可以 !undef + !define 重定义：包一层，在原插件调用创建控件后（hwnd 在栈顶）同步
;   WM_SETFONT 雅黑 + 对过矮控件 MoveWindow 补高，栈形态不变（Exch 进出各一次）。
; 跳转写法：GWorkNSD_FixBtn 曾在宏体内用相对跳转（IntCmp +N），理由是本宏会在多处展开、固定标号
;   会重定义冲突。但相对跳转要求人肉数指令条数，而「!insertmacro 本身不算一条指令，宏展开后
;   其中每条运行时指令各算一条」（NSIS 手册 4.4 Relative Jumps），一旦增删一行就整体错位 ——
;   本文件已经错过两处（原 404 / 410 行，均少算一条）。现改用 ${__COUNTER__} 生成每次展开
;   唯一的绝对标号，既免去数数，又不冲突。
;   GWorkNSD_Fix（下面只设字体的短宏）也使用 StrCmp 做零值判断：零句柄安全跳过，
;   非零句柄明确继续执行 WM_SETFONT，不依赖 IntCmp 三分支位置语义。

!macro GWorkNSD_Fix
  !define GWORK_FIX_DONE gwork_fix_done_${__COUNTER__}
  Exch $R9
  Push $R8
  StrCmp $GWorkFontNormal 0 ${GWORK_FIX_DONE}
  SendMessage $R9 0x0030 $GWorkFontNormal 1
  ${GWORK_FIX_DONE}:
  Pop $R8
  Exch $R9
  !undef GWORK_FIX_DONE
!macroend

!macro GWorkNSD_Label x y w h t
  nsDialogs::CreateControl ${__NSD_Label_CLASS} ${__NSD_Label_STYLE} ${__NSD_Label_EXSTYLE} ${x} ${y} ${w} ${h} ${t}
  !insertmacro GWorkNSD_Fix
!macroend
!macro GWorkNSD_RadioButton x y w h t
  nsDialogs::CreateControl ${__NSD_RadioButton_CLASS} ${__NSD_RadioButton_STYLE} ${__NSD_RadioButton_EXSTYLE} ${x} ${y} ${w} ${h} ${t}
  !insertmacro GWorkNSD_FixBtn
!macroend
!macro GWorkNSD_CheckBox x y w h t
  nsDialogs::CreateControl ${__NSD_CheckBox_CLASS} ${__NSD_CheckBox_STYLE} ${__NSD_CheckBox_EXSTYLE} ${x} ${y} ${w} ${h} ${t}
  !insertmacro GWorkNSD_FixBtn
!macroend
!macro GWorkNSD_Text x y w h t
  nsDialogs::CreateControl ${__NSD_Text_CLASS} ${__NSD_Text_STYLE} ${__NSD_Text_EXSTYLE} ${x} ${y} ${w} ${h} ${t}
  !insertmacro GWorkNSD_Fix
!macroend

!undef NSD_CreateLabel
!define NSD_CreateLabel "!insertmacro GWorkNSD_Label "
!undef NSD_CreateRadioButton
!define NSD_CreateRadioButton "!insertmacro GWorkNSD_RadioButton "
!undef NSD_CreateCheckBox
!define NSD_CreateCheckBox "!insertmacro GWorkNSD_CheckBox "
!undef NSD_CreateText
!define NSD_CreateText "!insertmacro GWorkNSD_Text "


; Button 族（radio/checkbox）专用：设字体 + 补足被 8u 裁切的高度（模板里 Next/Cancel 等
;   _pushbutton 不走这两个包装宏，天然不受影响；Label/Text 只设字体不动几何，避免误压）
; 句柄使用 StrCmp 做零值判断；高度比较仍用 IntCmp，等于或大于目标高度时跳到收尾段。
; 标号名带 ${__COUNTER__}：本宏经 NSD_CreateRadioButton / NSD_CreateCheckBox 在多处展开，
;   固定标号会 "label already declared"；${__COUNTER__} 每次展开自增，!define 在展开时求值、
;   !undef 在展开末尾释放，下一次展开拿到新号（NSIS 3.11 自带 x64.nsh:76 就是同一写法：
;   !define GetNativeMachineArchitecture_lbl lbl_GNMA_${__COUNTER__}）。
; 标号是编译期符号、不占指令位，所以加标号不会改变任何指令编号，栈形态与寄存器用途完全不变。
!macro GWorkNSD_FixBtn
  !define GWORK_FBTN_DONE gwork_fb_done_${__COUNTER__}
  Exch $R9
  Push $R8
  Push $R7
  Push $R6
  Push $R5
  Push $R4
  Push $R3
  Push $R2
  Push $R1
  ; 雅黑句柄为零则整段跳过；非零句柄必须继续执行字体与高度逻辑。
  StrCmp $GWorkFontNormal 0 ${GWORK_FBTN_DONE}
  SendMessage $R9 0x0030 $GWorkFontNormal 1
  System::Call 'user32::GetWindowRect(p R9, p $GWorkRectBuf)'
  System::Call '*$GWorkRectBuf(i .R4, i .R3, i .R2, i .R1)'
  IntOp $R5 $R1 - $R3
  IntOp $R8 $GWorkFontPx + 6
  ; 已够高（$R5 == $R8）或更高（$R5 > $R8）都直接进收尾，跳过补高。
  ; 原写法 IntCmp $R5 $R8 +5 0 +5 少算一条：+5 从本条（第 16 条）落在第 21 条 MoveWindow 上，
  ; 而不是第 22 条 Pop $R1。后果比「分支永不生效」更糟 —— 它跳过了 GetParent / MapWindowPoints /
  ; RECT 回读 / IntOp $R2-$R4 这四条，$R4/$R3/$R2 仍是第 13 条读出的**屏幕**坐标，
  ; MoveWindow 拿屏幕坐标当父窗客户区坐标用 → 控件被挪到错误位置，并被强制压到 $R8 高度。
  IntCmp $R5 $R8 ${GWORK_FBTN_DONE} 0 ${GWORK_FBTN_DONE}
  System::Call 'user32::GetParent(p R9) i .R7'
  System::Call 'user32::MapWindowPoints(p 0, p R7, p $GWorkRectBuf, i 2)'
  System::Call '*$GWorkRectBuf(i .R4, i .R3, i .R2, i .R1)'
  IntOp $R2 $R2 - $R4
  System::Call 'user32::MoveWindow(p R9, i R4, i R3, i R2, i R8, i 1)'
  ${GWORK_FBTN_DONE}:
  Pop $R1
  Pop $R2
  Pop $R3
  Pop $R4
  Pop $R5
  Pop $R6
  Pop $R7
  Pop $R8
  Exch $R9
  !undef GWORK_FBTN_DONE
!macroend
