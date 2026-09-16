param(
  [string]$ZipPath,
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$package = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
if ([string]::IsNullOrWhiteSpace($ZipPath)) {
  $ZipPath = Join-Path $repoRoot ("dist\photopeek-{0}-win-x64.zip" -f $version)
}
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $OutputPath = Join-Path $repoRoot ("dist\photopeek-{0}-win-x64-setup.exe" -f $version)
}
$zip = (Resolve-Path $ZipPath).Path
$output = [IO.Path]::GetFullPath($OutputPath)
$payload = Join-Path $repoRoot 'build\iexpress-payload'
$sedPath = Join-Path $repoRoot 'build\photopeek-iexpress.sed'
$archiveName = [IO.Path]::GetFileName($zip)

if (-not (Test-Path -LiteralPath "$env:WINDIR\System32\iexpress.exe")) {
  throw 'Windows IExpress is not available on this machine.'
}

if (Test-Path -LiteralPath $payload) {
  Remove-Item -LiteralPath $payload -Recurse -Force
}
New-Item -ItemType Directory -Path $payload -Force | Out-Null
Copy-Item -LiteralPath $zip -Destination (Join-Path $payload $archiveName) -Force

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$launcher = Join-Path $payload 'IExpressLauncher.exe'
if (-not (Test-Path -LiteralPath $csc)) {
  throw 'The .NET Framework C# compiler is not available.'
}
& $csc /nologo /target:exe /out:$launcher (Join-Path $PSScriptRoot 'iexpress-launcher.cs')
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcher)) {
  throw 'Failed to compile the IExpress launcher.'
}

$installPs1 = @'
$ErrorActionPreference = 'Stop'
$archive = Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.zip' -File | Select-Object -First 1
if ($null -eq $archive) { throw 'PhotoPeek ZIP payload was not found.' }

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\photopeek'
$staging = Join-Path ([IO.Path]::GetTempPath()) ('photopeek-install-' + [guid]::NewGuid().ToString('N'))
try {
  Get-Process -Name 'photopeek' -ErrorAction SilentlyContinue | Stop-Process -Force
  New-Item -ItemType Directory -Path $staging -Force | Out-Null
  Expand-Archive -LiteralPath $archive.FullName -DestinationPath $staging -Force
  if (-not (Test-Path -LiteralPath (Join-Path $staging 'photopeek.exe'))) {
    throw 'The ZIP payload is invalid (photopeek.exe is missing).'
  }
  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
  Get-ChildItem -LiteralPath $staging -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $installDir -Recurse -Force
  }

  $desktop = [Environment]::GetFolderPath('Desktop')
  if ($desktop) {
    $shortcut = Join-Path $desktop 'PhotoPeek.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($shortcut)
    $link.TargetPath = Join-Path $installDir 'photopeek.exe'
    $link.WorkingDirectory = $installDir
    $link.IconLocation = Join-Path $installDir 'photopeek.exe'
    $link.Save()
  }
  Start-Process -FilePath (Join-Path $installDir 'photopeek.exe')
} finally {
  if (Test-Path -LiteralPath $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  }
}
'@
Set-Content -LiteralPath (Join-Path $payload 'install.ps1') -Value $installPs1 -Encoding UTF8

$sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles
[Strings]
InstallPrompt=
DisplayLicense=
FinishMessage=PhotoPeek installation completed.
TargetName=$output
FriendlyName=PhotoPeek
AppLaunched=IExpressLauncher.exe
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
FILE0=$archiveName
FILE1=install.ps1
FILE2=IExpressLauncher.exe
[SourceFiles]
SourceFiles0=$payload\
[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
"@
Set-Content -LiteralPath $sedPath -Value $sed -Encoding ASCII

$iexpress = Start-Process -FilePath "$env:WINDIR\System32\iexpress.exe" -ArgumentList @('/N', '/Q', '/M', $sedPath) -WorkingDirectory $repoRoot -Wait -PassThru
if ($iexpress.ExitCode -ne 0) {
  throw "IExpress failed with exit code $($iexpress.ExitCode)."
}
if (-not (Test-Path -LiteralPath $output)) {
  throw "IExpress completed but did not create $output."
}
Write-Host "Created $output"
