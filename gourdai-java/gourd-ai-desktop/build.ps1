#Requires -Version 5.1
<#
.SYNOPSIS  GWork Windows 构建脚本（Electron）
.PARAMETER JavaHome    JDK 目录（默认 $env:JAVA_HOME）
.PARAMETER ProjectRoot 项目根目录
.PARAMETER SkipMaven   跳过 Maven 构建
.PARAMETER SkipJlink   跳过 jlink 生成 JRE
.EXAMPLE
    .\build.ps1
    .\build.ps1 -SkipMaven -SkipJlink
#>
param(
    [string]$JavaHome    = $env:JAVA_HOME,
    [string]$ProjectRoot = (Split-Path $PSScriptRoot -Parent),
    [switch]$SkipMaven,
    [switch]$SkipJlink
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ExtraResourcesDir = Join-Path $PSScriptRoot "build\extraResources"
$JreDir            = Join-Path $ExtraResourcesDir "jre"
$JarSource         = Join-Path $ProjectRoot "gourd-ai-agent\target\gourd-ai-agent.jar"
$UiSource          = Join-Path $ProjectRoot "gourd-ai-agent\src\main\resources\static"
$UiDest            = Join-Path $PSScriptRoot "build\ui"

Write-Host "=== GWork Windows 构建（Electron）===" -ForegroundColor Cyan

# 1. Maven 构建 JAR
if (-not $SkipMaven) {
    Write-Host "[1/5] Maven 构建 gourd-ai-agent.jar..." -ForegroundColor Yellow
    Push-Location $ProjectRoot
    try { mvn -pl gourd-ai-agent -am package -DskipTests -q; if ($LASTEXITCODE -ne 0) { throw "Maven 失败" } }
    finally { Pop-Location }
}
if (-not (Test-Path $JarSource)) { throw "JAR 不存在: $JarSource" }

# 2. 复制 JAR 到 build/extraResources/
Write-Host "[2/5] 复制 JAR 到 build/extraResources/..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path $ExtraResourcesDir | Out-Null
Copy-Item -Force $JarSource (Join-Path $ExtraResourcesDir "gourd-ai-agent.jar")

# 3. 复制前端 UI 到 build/ui/（单一来源：直接取自 gourd-ai-agent 静态资源）
Write-Host "[3/5] 复制前端 UI 到 build/ui/..." -ForegroundColor Yellow
if (-not (Test-Path (Join-Path $UiSource "index.html"))) { throw "UI 源不存在: $UiSource" }
if (Test-Path $UiDest) { Remove-Item -Recurse -Force $UiDest }
New-Item -ItemType Directory -Force -Path $UiDest | Out-Null
Copy-Item -Recurse -Force (Join-Path $UiSource "*") $UiDest

# 4. jlink 生成精简 JRE 到 build/extraResources/jre/
if (-not $SkipJlink) {
    Write-Host "[4/5] jlink 生成精简 JRE..." -ForegroundColor Yellow
    if (-not $JavaHome) { throw "未设置 JAVA_HOME" }
    $Jlink = Join-Path $JavaHome "bin\jlink.exe"
    if (-not (Test-Path $Jlink)) { throw "jlink 不存在: $Jlink (需要 JDK >= 11)" }
    if (Test-Path $JreDir) { Remove-Item -Recurse -Force $JreDir }
    $Modules = "java.base,java.logging,java.sql,java.naming,java.management,java.instrument,java.net.http,jdk.crypto.ec,jdk.zipfs,jdk.unsupported"
    & $Jlink --module-path "$JavaHome\jmods" --add-modules $Modules --output $JreDir `
             --strip-debug --compress 2 --no-header-files --no-man-pages
    if ($LASTEXITCODE -ne 0) { throw "jlink 失败" }
    $Size = [math]::Round((Get-ChildItem $JreDir -Recurse | Measure-Object Length -Sum).Sum / 1MB, 1)
    Write-Host "  JRE: ${Size} MB"
}

# 5. Electron Builder 打包（输出到 out/）
Write-Host "[5/5] npm install && electron-builder..." -ForegroundColor Yellow
Push-Location $PSScriptRoot
try {
    npm install; if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
    npm run build:win; if ($LASTEXITCODE -ne 0) { throw "electron-builder 失败" }
} finally { Pop-Location }

Write-Host "`n=== 构建完成 ===" -ForegroundColor Green
Write-Host "安装包: $PSScriptRoot\out\"
Get-ChildItem (Join-Path $PSScriptRoot "out") -Include "*.exe","*.msi" -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  [$([math]::Round($_.Length/1MB,1)) MB] $($_.FullName)"
}
