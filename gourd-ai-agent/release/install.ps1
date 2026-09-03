# Solon Code CLI installer for Windows PowerShell
$ErrorActionPreference = "Stop"
$SOURCE_DIR = if ($env:GOURDWORK_INSTALL_DIR -and (Test-Path $env:GOURDWORK_INSTALL_DIR)) { $env:GOURDWORK_INSTALL_DIR } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
$SOURCE_BIN_DIR = Join-Path $SOURCE_DIR "bin"
$SOURCE_SKILLS_DIR = Join-Path $SOURCE_DIR "skills"
$SOURCE_AGENTS = Join-Path $SOURCE_DIR "AGENTS.md"
$TARGET_DIR = Join-Path $env:USERPROFILE ".gwork"
$TARGET_BIN_DIR = Join-Path $TARGET_DIR "bin"
$TARGET_SKILLS_DIR = Join-Path $TARGET_DIR "skills"
$OLD_DIR = Join-Path $env:USERPROFILE ".gourdai"

if (-not (Get-Command java -ErrorAction SilentlyContinue)) { throw "Java is not installed or not in PATH" }
if (-not (Test-Path $SOURCE_BIN_DIR)) { throw "Source bin directory not found: $SOURCE_BIN_DIR" }
New-Item -ItemType Directory -Path $TARGET_BIN_DIR,$TARGET_SKILLS_DIR -Force | Out-Null

# Migrate non-bin user data, filling only missing target paths.
function Merge-UserData([string]$source, [string]$destination, [bool]$root = $false) {
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  Get-ChildItem $source -Force | ForEach-Object {
    if ($root -and $_.Name -eq 'bin') { return }
    if ($root -and $_.Name -eq '.gourdai' -and $_.PSIsContainer) {
      Merge-UserData $_.FullName $destination $false
      return
    }
    $dest = Join-Path $destination $_.Name
    if (Test-Path $dest) {
      if ($_.PSIsContainer) { Merge-UserData $_.FullName $dest $false }
    } else { Copy-Item $_.FullName $dest -Recurse -Force }
  }
}
if (Test-Path $OLD_DIR) { Merge-UserData $OLD_DIR $TARGET_DIR $true }

Copy-Item (Join-Path $SOURCE_BIN_DIR '*') $TARGET_BIN_DIR -Recurse -Force
if ((Test-Path $SOURCE_AGENTS) -and -not (Test-Path (Join-Path $TARGET_DIR 'AGENTS.md'))) { Copy-Item $SOURCE_AGENTS (Join-Path $TARGET_DIR 'AGENTS.md') }
if (Test-Path $SOURCE_SKILLS_DIR) {
  Get-ChildItem $SOURCE_SKILLS_DIR -Directory | ForEach-Object {
    $dest = Join-Path $TARGET_SKILLS_DIR $_.Name
    Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item $_.FullName $dest -Recurse -Force
  }
}

$launcherPs1 = @'
# gwork-cli-installed
param([Parameter(ValueFromRemainingArguments)]$RestArgs)
$JarDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$JarFile = Join-Path $JarDir "gourd-ai-agent.jar"
$JavaArgs = @("-Dfile.encoding=UTF-8", "-Dstdout.encoding=UTF-8", "-Dstderr.encoding=UTF-8", "-Dstdin.encoding=UTF-8", "-Dgwork.home=$env:USERPROFILE")
& java @JavaArgs -jar $JarFile @RestArgs
'@
$launcherBat = @'
@echo off
rem gwork-cli-installed
setlocal
set "SCRIPT_DIR=%~dp0"
set "JAR_FILE=%SCRIPT_DIR%gourd-ai-agent.jar"
java -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -Dstdin.encoding=UTF-8 "-Dgwork.home=%USERPROFILE%" -jar "%JAR_FILE%" %*
'@
$launcherSh = @'
#!/bin/bash
# gwork-cli-installed
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec java "-Dfile.encoding=UTF-8" "-Dgwork.home=$USERPROFILE" -jar "$SCRIPT_DIR/gourd-ai-agent.jar" "$@"
'@
foreach ($name in @('gwork','gourdai')) { Set-Content (Join-Path $TARGET_BIN_DIR "$name.ps1") $launcherPs1 -Encoding UTF8; Set-Content (Join-Path $TARGET_BIN_DIR "$name.bat") $launcherBat -Encoding UTF8; Set-Content (Join-Path $TARGET_BIN_DIR $name) $launcherSh -Encoding UTF8 }

$USER_PATH = [Environment]::GetEnvironmentVariable("Path", "User")
$entries = @($USER_PATH -split ';' | Where-Object { $_ -and $_ -ne (Join-Path $env:USERPROFILE '.gourdai\bin') -and $_ -ne $TARGET_BIN_DIR })
[Environment]::SetEnvironmentVariable("Path", (($entries + $TARGET_BIN_DIR) -join ';'), "User")
Write-Host "Installation complete: $TARGET_DIR"
Write-Host "Commands: gwork (primary), gourdai (compatibility alias)"
