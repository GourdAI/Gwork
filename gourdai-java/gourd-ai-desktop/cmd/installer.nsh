; installer.nsh —— electron-builder NSIS 自定义脚本
;
; 目的：在桌面端全局区迁移到用户目录后，保留旧版本用户数据，并兼容卸载时清理桌面端 CLI 命令。
;
; 背景：新版全局区为「运行 App 的那个用户」的 %USERPROFILE%\.gwork。旧版本则把运行期数据
;      放在安装目录的 resources\extraResources\.gwork 或 .gourdai 中。electron-builder 覆盖
;      安装时会先静默执行旧版卸载器，其默认逻辑包含 `RMDir /r $INSTDIR`，因此旧数据若不先
;      暂存就会被删除。
;
; ⚠ 身份陷阱（务必保持当前设计）：
;      本安装器配置为 oneClick=false + perMachine=false，用户可选「为所有用户安装」。该选项会
;      触发 UAC 提权，安装器随之以**管理员身份**运行，此时 NSIS 的 $PROFILE 指向的是
;      管理员账户（如 C:\Users\Administrator），而不是真正使用 App 的那个用户。
;      因此 $PROFILE 绝不能作为「安装器 → App」的跨进程交接点，否则 App 以真实用户身份启动时
;      会读到空目录，而旧安装目录已被卸载器删除 → 用户配置永久丢失。
;
; 迁移策略（安装器只负责「别弄丢」，落地到用户目录由 App 完成）：
; 1. customInit    —— 旧卸载器执行前，把旧 .gwork / .gourdai 复制到 staging。staging 位于
;                     $PROFILE 下，但**仅由安装器进程自读自写自删**，不跨身份传递，故提权与否
;                     都安全；安装中断时 staging 保留，同身份重跑安装可续用。
; 2. customInstall —— 新文件落地后，把 staging 还原到**新安装目录**的 resources\extraResources\。
;                     安装器一定有权写 $INSTDIR，App 一定有权读 $INSTDIR，与运行 App 的用户是谁无关。
;                     还原成功才删除 staging；失败则保留 staging 供下次安装重试。
; 3. App 首次启动  —— 以**真实用户身份**把安装目录里的 .gwork/.gourdai 合并进自己的 ~/.gwork
;                     （见 main/migration.js）。多用户各自迁移到各自的用户目录，语义正确。
; 4. customRemoveFiles —— 优先调用用户全局区中的 desktop-cli-uninstall.ps1，再兼容旧安装目录中的
;                     助手；默认删除安装目录，但不删除用户目录下的 .gwork 数据。
;
; ── 本文件的第二个职责：覆盖安装前释放旧安装目录的文件占用 ──────────────────
;
; 故障链（这是 customInit 里多出一段「判杀进程」的唯一原因，别当冗余删掉）：
;   1) 桌面端启动时会拉起一个 javaw.exe 子进程跑 resources\extraResources\gourd-ai-agent.jar，
;      该子进程的执行映像正是安装目录内的 extraResources\jre\bin\javaw.exe（文件句柄 = 运行中映像）。
;   2) 关窗只是隐藏到托盘，只有 before-quit 才 stopBackend；因此「没正常退出过的老安装」在升级时
;      仍然留有 java 残留进程。
;   3) 模板的 CHECK_APP_RUNNING（app-builder-lib templates/nsis/include/
;      allowOnlyOneInstallerInstance.nsh 的 _CHECK_APP_RUNNING）只对主程序下手：
;      `taskkill /im "${APP_EXECUTABLE_FILENAME}"` —— 它从来不管 java / javaw。主进程被强杀后
;      那个 javaw.exe 就成了孤儿，且继续占着 jre 与 jar。
;   4) 孤儿占用的文件处于「运行中映像」状态，禁止改名与删除 → customRemoveFiles 里
;      un.atomicRMDir 返回 busy 而 Abort（或 CopyFiles 重试后静默取消）→ 最终形成
;      新 jar + 旧 jre（或反之、或新旧 asar 混编）的**部分覆盖** → 新装的后端起不来 →
;      全部 /web/** 接口不通。全新机器没有残留进程，所以永远复现不了，只能由安装器主动回收。
;
; 为什么绝不能用 `taskkill /im javaw.exe`：用户机器上的 java 进程几乎一定不止我们这一个
;   （IDEA / Android Studio / Gradle daemon / 各类自建服务），按映像名批量杀 = 不可接受的误杀。
;   所以判据只认「可执行文件完整路径是否位于旧安装目录之下」，前缀不成立就绝不动手；
;   判据取不到（读不到旧目录）时同样直接跳过 —— 宁可放过，不可误杀。
;
; 为什么是 customInit：它在 .onInit 内、initMultiUser 之后执行（templates/nsis/installer.nsi），
;   而旧卸载器要等到 install 段里的 uninstallOldVersion 才被静默调用 —— customInit 是唯一还来得及
;   在卸载器删文件之前释放占用的时机。
;
; 为什么用 FileOpen 逐行写出 .ps1，而不是把 PowerShell 塞进 nsExec 的引号串：
;   ${if}、双引号、反引号、$变量 在 NSIS 与 PowerShell 之间会被反复展开，属于转义地狱。改成
;   「纯文本脚本 + 旁挂数据文件」后：安装目录值不走命令行（写进同目录下的 .root.txt 由脚本自读），
;   路径含空格、含单引号、含 $ 都不会破坏解析；脚本正文本身刻意保持纯 ASCII 且不含 " 与 \，
;   这样 NSIS 的 FileWrite（按 ANSI/ACP 落盘）与 PowerShell 读到的字节完全一致。
;   代价：FileWrite 串里每个美元符都要写成 $$（NSIS 的转义），改脚本时别漏。

!ifndef BUILD_UNINSTALLER

; ── 辅助宏：向 $PLUGINSDIR 写出判杀脚本并执行一次 ───────────────────────────
; 参数 _oldDir：需要清理占用的旧安装目录。整个宏不阻断安装：任何一步失败都只是 DetailPrint。
!macro gworkKillProcsUnder _oldDir
  ; customInit 跑在 .onInit 里，此时 $PLUGINSDIR 可能还没建（模板要到 install 段才 InitPluginsDir），
  ; 故显式初始化；模板自身在 customInit 之后也有同样的用法（installer.nsi 的 addLicenseFiles 分支）。
  InitPluginsDir

  ; 第一步：旧安装目录写成旁挂数据文件。绝不用命令行传参 —— 路径尾部反斜杠 + 引号会让
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
      ; 用 ExecToLog 把 killed / no process 之类结论带进安装日志，便于远程排障。
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

; ── 安装前：先释放旧目录占用，再暂存旧安装目录里的用户配置 ──────────────────
!macro customInit
  ; 从注册表读取上一次安装位置（SHELL_CONTEXT 已由 initMultiUser 按安装模式设定）
  ReadRegStr $R9 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ; installMode=="all" 时，installSection 还会额外卸载 HKCU 下的旧安装
  ; （见模板 installSection.nsh），若 HKLM 无记录则回退查 HKCU，避免该场景漏迁移
  ${if} $installMode == "all"
  ${andIf} $R9 == ""
    ReadRegStr $R9 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${endIf}

  ; 抢占在旧卸载器之前：把「旧安装目录下的」java / javaw（以及仍赖着不走的主程序）按路径判杀，
  ; 否则 un.atomicRMDir 会因 javaw.exe 是运行中映像而 Abort，留下新旧混合的部分覆盖。
  ; 已知缺陷：$R9 为空时无处作为前缀判据，只能跳过（全新安装本就没有旧目录；但老版本卸载键的
  ; InstallLocation 属性在本项目历史上确实缺失过 —— HKLM 侧丢过这个值，那种机器的占用问题仍会残留，
  ; 需要靠 App 侧 before-quit 正常退出，或后续把 InstallLocation 写全来兜底）。
  ${if} $R9 == ""
    DetailPrint "gwork-kill: no previous InstallLocation in registry; skip process cleanup"
  ${else}
    DetailPrint "gwork-kill: releasing file locks under $R9"
    !insertmacro gworkKillProcsUnder "$R9"
  ${endif}

  ; 两个旧数据区独立暂存；只在检测到对应源时重建对应 staging。
  ${if} $R9 != ""
    ${if} ${FileExists} "$R9\resources\extraResources\.gwork"
      ; xcopy /E /H 保留完整目录树，含空目录、隐藏与系统文件。
      ; 先复制到临时兄弟目录，复制失败绝不破坏上一份可重试的 staging。
      ; 用 ExecToLog 而非 ExecToStack：文件多时 xcopy 输出会撑爆 NSIS 栈字符串。
      RMDir /r "$PROFILE\.gwork-desktop-migration\install-gwork-next"
      CreateDirectory "$PROFILE\.gwork-desktop-migration\install-gwork-next"
      nsExec::ExecToLog '"$SYSDIR\xcopy.exe" "$R9\resources\extraResources\.gwork\*" "$PROFILE\.gwork-desktop-migration\install-gwork-next" /E /H /K /Y /I'
      Pop $R8
      ${if} $R8 == 0
        RMDir /r "$PROFILE\.gwork-desktop-migration\install-gwork"
        Rename "$PROFILE\.gwork-desktop-migration\install-gwork-next" "$PROFILE\.gwork-desktop-migration\install-gwork"
        DetailPrint "Staging user config: $R9\resources\extraResources\.gwork"
      ${else}
        DetailPrint "Staging user config failed (xcopy=$R8); previous staging preserved"
      ${endif}
    ${endif}
    ${if} ${FileExists} "$R9\resources\extraResources\.gourdai"
      RMDir /r "$PROFILE\.gwork-desktop-migration\install-gourdai-next"
      CreateDirectory "$PROFILE\.gwork-desktop-migration\install-gourdai-next"
      nsExec::ExecToLog '"$SYSDIR\xcopy.exe" "$R9\resources\extraResources\.gourdai\*" "$PROFILE\.gwork-desktop-migration\install-gourdai-next" /E /H /K /Y /I'
      Pop $R8
      ${if} $R8 == 0
        RMDir /r "$PROFILE\.gwork-desktop-migration\install-gourdai"
        Rename "$PROFILE\.gwork-desktop-migration\install-gourdai-next" "$PROFILE\.gwork-desktop-migration\install-gourdai"
        DetailPrint "Staging legacy user config: $R9\resources\extraResources\.gourdai"
      ${else}
        DetailPrint "Staging legacy user config failed (xcopy=$R8); previous staging preserved"
      ${endif}
    ${endif}
  ${endif}
!macroend

; ── 新文件落地后：把 staging 还原到新安装目录，交由 App 首启迁移到用户目录 ──────────
!macro customInstall
  ; 还原点必须是 $INSTDIR：安装器有写权限，App 有读权限，且与「App 由哪个用户运行」解耦。
  ; 不能直接写 $PROFILE\.gwork —— 提权安装时那是管理员的目录，真实用户永远读不到。
  ${if} ${FileExists} "$PROFILE\.gwork-desktop-migration\install-gwork\*.*"
    CreateDirectory "$INSTDIR\resources\extraResources\.gwork"
    nsExec::ExecToLog '"$SYSDIR\xcopy.exe" "$PROFILE\.gwork-desktop-migration\install-gwork\*" "$INSTDIR\resources\extraResources\.gwork" /E /H /K /Y /I'
    Pop $R8
    ${if} $R8 == 0
      RMDir /r "$PROFILE\.gwork-desktop-migration\install-gwork"
      DetailPrint "Restored user config for first-run migration"
    ${else}
      DetailPrint "Restore failed (xcopy=$R8); staging preserved for next install"
    ${endif}
  ${endif}
  ${if} ${FileExists} "$PROFILE\.gwork-desktop-migration\install-gourdai\*.*"
    CreateDirectory "$INSTDIR\resources\extraResources\.gourdai"
    nsExec::ExecToLog '"$SYSDIR\xcopy.exe" "$PROFILE\.gwork-desktop-migration\install-gourdai\*" "$INSTDIR\resources\extraResources\.gourdai" /E /H /K /Y /I'
    Pop $R8
    ${if} $R8 == 0
      RMDir /r "$PROFILE\.gwork-desktop-migration\install-gourdai"
      DetailPrint "Restored legacy user config for first-run migration"
    ${else}
      DetailPrint "Restore failed (xcopy=$R8); legacy staging preserved for next install"
    ${endif}
  ${endif}
  ; staging 根若已空则一并清理（非空说明有失败项，保留待重试）
  RMDir "$PROFILE\.gwork-desktop-migration"
!macroend

!endif ; BUILD_UNINSTALLER

; ── 卸载：先清理 CLI 命令，再删除应用文件 ─────────────────────────────────────
; 保留 electron-builder 默认的删文件逻辑；只在其前面调用 CLI 清理助手。
!macro customRemoveFiles
  ; 新版：CLI 助手位于用户全局区，且全局区不能随应用卸载删除。
  IfFileExists "$PROFILE\.gwork\bin\desktop-cli-uninstall.ps1" 0 tryLegacyInstallGwork
    DetailPrint "Removing 'gwork' terminal command..."
    nsExec::Exec 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PROFILE\.gwork\bin\desktop-cli-uninstall.ps1"'
    Goto skipCliCleanup
  tryLegacyInstallGwork:
  ; 兼容旧安装目录中的新版 .gwork 助手。
  IfFileExists "$INSTDIR\resources\extraResources\.gwork\bin\desktop-cli-uninstall.ps1" 0 tryLegacyInstallGourdai
    DetailPrint "Removing legacy-install 'gwork' terminal command..."
    nsExec::Exec 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\extraResources\.gwork\bin\desktop-cli-uninstall.ps1"'
    Goto skipCliCleanup
  tryLegacyInstallGourdai:
  ; 品牌升级前的旧安装：助手在旧 .gourdai\bin 下。
  IfFileExists "$INSTDIR\resources\extraResources\.gourdai\bin\desktop-cli-uninstall.ps1" 0 skipCliCleanup
    DetailPrint "Removing legacy 'gourdai' terminal command..."
    nsExec::Exec 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\extraResources\.gourdai\bin\desktop-cli-uninstall.ps1"'
  skipCliCleanup:

  ; 以下逐字复刻模板默认逻辑，保证升级/卸载行为与官方一致
  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"

    Push ""
    Call un.atomicRMDir
    Pop $R0

    ${if} $R0 != 0
      DetailPrint "File is busy, aborting: $R0"

      # Attempt to restore previous directory
      Push ""
      Call un.restoreFiles
      Pop $R0

      Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
    ${endif}

  ${endif}

  # Remove all files (or remaining shallow directories from the block above)
  RMDir /r $INSTDIR
!macroend
