param(
  [switch]$SkipMac
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$package = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
$dist = Join-Path $repoRoot 'dist'
$releaseDir = Join-Path $dist $version

Push-Location $repoRoot
try {
  npm run build:win
  if ($LASTEXITCODE -ne 0) { throw 'Windows build failed.' }
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'scripts\build-iexpress-installer.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'Windows installer build failed.' }

  New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
  $winZip = Join-Path $dist ("photopeek-{0}-win-x64.zip" -f $version)
  $installer = Join-Path $dist ("photopeek-{0}-win-x64-setup.exe" -f $version)
  Move-Item -LiteralPath $winZip -Destination (Join-Path $releaseDir (Split-Path $winZip -Leaf)) -Force
  Move-Item -LiteralPath $installer -Destination (Join-Path $releaseDir (Split-Path $installer -Leaf)) -Force

  if (-not $SkipMac) {
    try {
      npm run build:mac-arm64
      if ($LASTEXITCODE -ne 0) { throw 'macOS arm64 build is unavailable on this host.' }
      $macZip = Get-ChildItem -LiteralPath $dist -Filter ("photopeek-{0}-mac-arm64.zip" -f $version) -File | Select-Object -First 1
      if ($null -ne $macZip) {
        Move-Item -LiteralPath $macZip.FullName -Destination (Join-Path $releaseDir $macZip.Name) -Force
      }
    } catch {
      Write-Warning "macOS arm64 build skipped: $($_.Exception.Message)"
    }
  }

  $hashLines = Get-ChildItem -LiteralPath $releaseDir -File | Where-Object { $_.Extension -in @('.zip', '.exe', '.dmg') } | ForEach-Object {
    $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    "{0}  {1}" -f $hash, $_.Name
  }
  Set-Content -LiteralPath (Join-Path $releaseDir 'SHA256SUMS.txt') -Value $hashLines -Encoding UTF8
  Write-Host "Release prepared in $releaseDir"
} finally {
  Pop-Location
}
