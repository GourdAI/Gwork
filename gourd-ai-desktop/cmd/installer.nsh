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

!ifndef BUILD_UNINSTALLER

; ── 安装前：暂存旧安装目录里的用户配置 ───────────────────────────────────────
!macro customInit
  ; 从注册表读取上一次安装位置（SHELL_CONTEXT 已由 initMultiUser 按安装模式设定）
  ReadRegStr $R9 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ; installMode=="all" 时，installSection 还会额外卸载 HKCU 下的旧安装
  ; （见模板 installSection.nsh），若 HKLM 无记录则回退查 HKCU，避免该场景漏迁移
  ${if} $installMode == "all"
  ${andIf} $R9 == ""
    ReadRegStr $R9 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${endIf}

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
