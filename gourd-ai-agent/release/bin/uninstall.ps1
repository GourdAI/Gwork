# Safe CLI uninstaller. User data is retained unless -PurgeData is explicit.
param([switch]$PurgeData)
$ErrorActionPreference = "Stop"
$INSTALL_DIR = Join-Path $env:USERPROFILE '.gwork'
$TARGET_BIN_DIR = Join-Path $INSTALL_DIR 'bin'
$TARGET_BIN_FULL = [IO.Path]::GetFullPath($TARGET_BIN_DIR).TrimEnd('\')

$removePath = { param($scope)
  $path = [Environment]::GetEnvironmentVariable('Path', $scope)
  if ($null -eq $path) { return }
  $old = Join-Path $env:USERPROFILE '.gourdai\bin'
  $new = @($path -split ';' | Where-Object { $_ -and $_ -ne $old -and $_ -ne $TARGET_BIN_DIR })
  [Environment]::SetEnvironmentVariable('Path', ($new -join ';'), $scope)
}
& $removePath 'User'

$hadStandaloneLauncher = $false
$hasDesktopLauncher = $false
if (Test-Path $TARGET_BIN_DIR) {
  foreach ($name in @('gwork','gourdai','gwork.ps1','gourdai.ps1','gwork.bat','gourdai.bat')) {
    $file = Join-Path $TARGET_BIN_DIR $name
    if (-not (Test-Path $file -PathType Leaf)) { continue }
    $content = Get-Content -Raw -LiteralPath $file -ErrorAction SilentlyContinue
    if ($content -match 'gwork-cli-installed') {
      $hadStandaloneLauncher = $true
      Remove-Item $file -Force -ErrorAction SilentlyContinue
    } elseif ($content -match 'gourd-ai-desktop-provisioned') {
      $hasDesktopLauncher = $true
    }
  }
  if ($hadStandaloneLauncher -and -not $hasDesktopLauncher) {
    foreach ($name in @('gourd-ai-agent.jar','uninstall.sh','uninstall.ps1')) {
      Remove-Item (Join-Path $TARGET_BIN_DIR $name) -Force -ErrorAction SilentlyContinue
    }
  }
}

# Only remove a symlink when its target is exactly this installation's launcher.
foreach ($name in @('gwork','gourdai')) {
  foreach ($link in @("$env:USERPROFILE\.local\bin\$name", "$env:USERPROFILE\bin\$name")) {
    if ((Test-Path $link -PathType Leaf) -and ((Get-Item $link).LinkType -eq 'SymbolicLink')) {
      $target = [IO.Path]::GetFullPath((Get-Item $link).Target)
      if ($target -eq (Join-Path $TARGET_BIN_FULL $name)) { Remove-Item $link -Force }
    }
  }
}
if ($PurgeData) { Remove-Item $INSTALL_DIR -Recurse -Force -ErrorAction SilentlyContinue; Write-Host "Purged $INSTALL_DIR" }
else { Write-Host "Removed CLI files; retained user data in $INSTALL_DIR. Use -PurgeData to delete it." }
