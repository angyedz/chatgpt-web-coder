#requires -version 5.1
# chatgpt-coder update protocol: 1
<#
.SYNOPSIS
  Install chatgpt-coder for the current Windows user.
.DESCRIPTION
  Installs a private Node.js runtime, Git, project dependencies, Chromium and the
  OpenAI tunnel client. No system-wide Node.js or administrator rights needed.
  Run this script from a complete copy of the project source.
.PARAMETER InstallDir
  Installation directory. Defaults to %LOCALAPPDATA%\Programs\chatgpt-coder.
.PARAMETER SourceRoot
  Path to the project source. Defaults to the parent directory of this script.
#>
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\chatgpt-coder'),
  [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
  [switch]$Update,
  [string]$ExpectedCurrentRelease = ''
)

$ErrorActionPreference = 'Stop'
# The installer can be launched from PowerShell 7, which may pass its own
# module paths to Windows PowerShell 5.1. Prefer the matching built-in modules.
$windowsModules = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\Modules'
if (Test-Path -LiteralPath $windowsModules) { $env:PSModulePath = $windowsModules + ';' + $env:PSModulePath }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
$transcriptStarted = $false
$stage = 'starting installer'
$release = $null
$releaseId = $null
$target = $null
$activated = $false

# Only remove real directories immediately inside the managed releases folder.
# Never recurse through a junction or symbolic link.
function Remove-ManagedDirectory {
  param([string]$Directory, [string]$Parent, [string]$ExpectedName)
  $parentItem = Get-Item -LiteralPath $Parent -Force -ErrorAction Stop
  $item = Get-Item -LiteralPath $Directory -Force -ErrorAction Stop
  if (-not $parentItem.PSIsContainer -or ($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      -not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Name -cne $ExpectedName) { throw 'Cleanup target is not a managed directory.' }
  $parentPath = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Parent).Path).TrimEnd('\')
  $resolved = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Directory).Path).TrimEnd('\')
  if ([IO.Path]::GetDirectoryName($resolved) -ine $parentPath -or $resolved -ine [IO.Path]::GetFullPath((Join-Path $parentPath $ExpectedName)).TrimEnd('\')) { throw 'Cleanup target is outside the managed directory.' }
  foreach ($child in Get-ChildItem -LiteralPath $resolved -Force -Recurse -ErrorAction Stop) {
    if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Cleanup target contains a junction or symbolic link.' }
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
}

function Remove-OldReleases {
  param([string]$Root, [string]$Current, [string]$Previous)
  if ($Current -notmatch '^[0-9a-f]{32}$' -or $Previous -notmatch '^[0-9a-f]{32}$') { throw 'Release identifiers could not be verified.' }
  $rootItem = Get-Item -LiteralPath $Root -Force -ErrorAction Stop
  $releases = Join-Path $Root 'releases'
  $releasesItem = Get-Item -LiteralPath $releases -Force -ErrorAction Stop
  if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($releasesItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Installation directory contains a junction or symbolic link.' }
  $rootPath = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Root).Path).TrimEnd('\')
  $releasesPath = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $releases).Path).TrimEnd('\')
  if ([IO.Path]::GetDirectoryName($releasesPath) -ine $rootPath) { throw 'Releases directory is outside the installation.' }
  $marker = Join-Path $rootPath 'current.txt'
  if ([IO.File]::ReadAllText($marker).Trim() -cne $Current) { throw 'The active release changed during cleanup.' }

  # Avoid touching releases in use by any running process, including background
  # Git or Node jobs from another agent window. Fail closed if inspection fails.
  $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $unknown = @($processes | Where-Object { $_.Name -match '^(node|git|cmd|powershell|pwsh)\.exe$' -and (-not $_.ExecutablePath -or -not $_.CommandLine) })
  if ($unknown.Count) { throw 'Could not inspect all running Node, Git, and shell processes.' }
  $removed = 0; $skipped = 0
  foreach ($item in Get-ChildItem -LiteralPath $releasesPath -Directory -Force -ErrorAction Stop) {
    if ($item.Name -cnotmatch '^[0-9a-f]{32}$' -or $item.Name -ceq $Current -or $item.Name -ceq $Previous) { continue }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $skipped++; continue }
    $candidate = [IO.Path]::GetFullPath($item.FullName).TrimEnd('\')
    if ([IO.Path]::GetDirectoryName($candidate) -ine $releasesPath) { $skipped++; continue }
    $active = $false
    foreach ($process in $processes) {
      if (($process.ExecutablePath -and $process.ExecutablePath.StartsWith($candidate + '\', [StringComparison]::OrdinalIgnoreCase)) -or
          ($process.CommandLine -and $process.CommandLine.IndexOf($candidate, [StringComparison]::OrdinalIgnoreCase) -ge 0)) { $active = $true; break }
    }
    if ($active) { $skipped++; continue }
    try {
      $metadataPath = Join-Path $candidate 'release.json'
      $manifestPath = Join-Path $candidate 'app\package.json'
      if (Test-Path -LiteralPath $metadataPath) {
        $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if (-not $metadata.version -or $manifest.name -cne 'chatgpt-coder' -or $manifest.version -cne $metadata.version) { throw 'Unrecognised release metadata.' }
      } else {
        # An interrupted installer may not have written its metadata yet. Only
        # remove old directories with the exact layout created by the installer.
        if (([DateTime]::UtcNow - $item.LastWriteTimeUtc).TotalHours -lt 6) { throw 'Incomplete release is too recent.' }
        $names = @(Get-ChildItem -LiteralPath $candidate -Force -ErrorAction Stop | Select-Object -ExpandProperty Name)
        if (-not ($names -contains 'app') -or -not ($names -contains 'runtime') -or -not ($names -contains 'download') -or @($names | Where-Object { $_ -notin @('app', 'runtime', 'download', 'git', 'chatgpt-coder.exe') }).Count) { throw 'Unrecognised incomplete release.' }
        if (Test-Path -LiteralPath $manifestPath) {
          $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
          if ($manifest.name -cne 'chatgpt-coder') { throw 'Unrecognised incomplete release manifest.' }
        }
      }
      if ([IO.File]::ReadAllText($marker).Trim() -cne $Current) { throw 'The active release changed during cleanup.' }
      Remove-ManagedDirectory -Directory $candidate -Parent $releasesPath -ExpectedName $item.Name
      $removed++
      Write-Host "[cleanup] Removed old release $removed."
    } catch {
      $skipped++
      Write-Warning "Cleanup skipped release $($item.Name): $($_.Exception.Message)"
    }
  }
  Write-Host "[cleanup] Removed $removed old release(s); kept the current and rollback releases. Skipped: $skipped."
}

function Invoke-Checked {
  param([string]$Executable, [string[]]$Arguments)
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Command failed (exit $LASTEXITCODE): $Executable" }
}

function Download-File {
  param([string]$Url, [string]$Destination)
  Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -TimeoutSec 300
}

function Get-Sha256 {
  param([string]$Path)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($Path)
  try { return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha256.Dispose() }
}

function Test-Search {
  try {
    $result = Invoke-WebRequest -Uri 'http://127.0.0.1:8888/search?q=ping&format=json' -UseBasicParsing -TimeoutSec 5
    return $result.StatusCode -eq 200 -and $result.Headers['Content-Type'] -match 'json'
  } catch { return $false }
}

function Install-SearchIfAvailable {
  if (Test-Search) { Write-Host 'SearXNG JSON API is already available on 127.0.0.1:8888.'; return }
  $docker = Get-Command docker.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $docker) { Write-Warning 'Docker is not available. Web search needs SearXNG; see README.md for setup.'; return }
  try {
    & $docker.Source version --format '{{.Server.Version}}' 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warning 'Docker is installed but its engine is not running. Start Docker Desktop and run this installer again to set up search.'; return }
    $name = 'chatgpt-coder-searxng'
    $label = (& $docker.Source inspect --format '{{ index .Config.Labels "org.chatgpt-coder.managed" }}' $name 2>$null)
    if ($LASTEXITCODE -eq 0) {
      if (($label -join '').Trim() -ne 'true') { Write-Warning "Container $name already exists and is not managed by this installer; leaving it untouched."; return }
      & $docker.Source start $name | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'Could not start the existing SearXNG container.' }
    } else {
      $searchHome = if ($env:CHATGPT_CODER_HOME) { [Environment]::ExpandEnvironmentVariables($env:CHATGPT_CODER_HOME) } else { Join-Path $env:USERPROFILE '.chatgpt-coder' }
      if ($searchHome -eq '~') { $searchHome = $env:USERPROFILE }
      elseif ($searchHome.StartsWith('~/') -or $searchHome.StartsWith('~\')) { $searchHome = Join-Path $env:USERPROFILE $searchHome.Substring(2) }
      $searchDir = [IO.Path]::GetFullPath((Join-Path $searchHome 'searxng'))
      New-Item -ItemType Directory -Force -Path $searchDir | Out-Null
      $settings = Join-Path $searchDir 'settings.yml'
      if (-not (Test-Path -LiteralPath $settings)) {
        $bytes = New-Object byte[] 32
        $random = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $random.GetBytes($bytes) } finally { $random.Dispose() }
        $secret = -join ($bytes | ForEach-Object { $_.ToString('x2') })
        $yaml = "use_default_settings: true`nserver:`n  secret_key: `"$secret`"`n  limiter: false`nsearch:`n  formats:`n    - html`n    - json`n"
        [IO.File]::WriteAllText($settings, $yaml, (New-Object Text.UTF8Encoding $false))
      }
      Write-Host 'Docker is available; downloading and starting the optional local SearXNG service...'
      & $docker.Source run -d --name $name --label 'org.chatgpt-coder.managed=true' --restart unless-stopped -p '127.0.0.1:8888:8080' -v ($searchDir + ':/etc/searxng:rw') 'searxng/searxng:latest' | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'Could not create the SearXNG container.' }
    }
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      if (Test-Search) { Write-Host 'SearXNG JSON API is ready on 127.0.0.1:8888.'; return }
      Start-Sleep -Seconds 2
    }
    Write-Warning 'SearXNG did not become ready. Check docker logs chatgpt-coder-searxng.'
  } catch {
    Write-Warning ("Optional SearXNG setup failed: " + $_.Exception.Message)
  }
}

try {
  if (-not $Update) {
    try {
      $logDir = Join-Path $env:LOCALAPPDATA 'chatgpt-coder\logs'
      New-Item -ItemType Directory -Force -Path $logDir | Out-Null
      $logPath = Join-Path $logDir ('install-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N') + '.log')
      Start-Transcript -LiteralPath $logPath | Out-Null
      $transcriptStarted = $true
      Write-Host "Installation log: $logPath"
    } catch {
      Write-Warning ("Could not create an installation log: " + $_.Exception.Message)
    }
  }
  $stage = 'checking requirements'
  if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) {
    throw 'Windows 10/11 64-bit is required.'
  }
  $source = [IO.Path]::GetFullPath($SourceRoot)
  $target = [IO.Path]::GetFullPath($InstallDir)
  if ($target.IndexOfAny([char[]]@(';', '"', "`r", "`n")) -ge 0) { throw 'InstallDir cannot contain a semicolon, quote, or newline.' }
  if (-not (Test-Path -LiteralPath (Join-Path $source 'package-lock.json')) -or
      -not (Test-Path -LiteralPath (Join-Path $source 'src\index.tsx')) -or
      -not (Test-Path -LiteralPath (Join-Path $source 'scripts\windows-launcher.cs'))) {
    throw 'A complete project source is required. Run this script from the project folder or pass -SourceRoot.'
  }
  if ((Test-Path -LiteralPath (Join-Path $target 'chatgpt-coder.exe')) -and
      -not (Test-Path -LiteralPath (Join-Path $target 'current.txt'))) {
    throw "An unmanaged chatgpt-coder.exe already exists in $target; choose another -InstallDir."
  }
  $marker = Join-Path $target 'current.txt'
  if ($Update) {
    if (-not (Test-Path -LiteralPath (Join-Path $target 'chatgpt-coder.exe')) -or -not (Test-Path -LiteralPath $marker)) { throw 'No existing managed installation was found.' }
    if ($ExpectedCurrentRelease -notmatch '^[0-9a-f]{32}$' -or ([IO.File]::ReadAllText($marker).Trim()) -ne $ExpectedCurrentRelease) { throw 'The active release changed; reopen the application before updating.' }
  }
  $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path -LiteralPath $compiler)) {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
  }
  if (-not $Update -and -not (Test-Path -LiteralPath $compiler) -and -not (Test-Path -LiteralPath (Join-Path $source 'prebuilt\chatgpt-coder.exe'))) { throw '.NET Framework 4 C# compiler not found. Enable .NET Framework 4.x in Windows.' }

  $releaseId = [Guid]::NewGuid().ToString('N')
  $release = Join-Path (Join-Path $target 'releases') $releaseId
  $app = Join-Path $release 'app'
  $runtime = Join-Path $release 'runtime'
  $downloadDir = Join-Path $release 'download'
  New-Item -ItemType Directory -Force -Path $app, $runtime, $downloadDir, (Join-Path $target 'browsers') | Out-Null

  $stage = 'preparing Node.js'
  $previousRuntime = if ($Update) { Join-Path (Join-Path (Join-Path $target 'releases') $ExpectedCurrentRelease) 'runtime' } else { '' }
  $reuseRuntime = $false
  if ($previousRuntime -and (Test-Path -LiteralPath (Join-Path $previousRuntime 'node.exe')) -and (Test-Path -LiteralPath (Join-Path $previousRuntime 'npm.cmd'))) {
    $previousNodeVersion = & (Join-Path $previousRuntime 'node.exe') --version
    $reuseRuntime = $LASTEXITCODE -eq 0 -and $previousNodeVersion -match '^v24\.'
  }
  if ($reuseRuntime) {
    Write-Host '[1/7] Reusing the installed Node.js 24 runtime...'
    Copy-Item -Path (Join-Path $previousRuntime '*') -Destination $runtime -Recurse -Force
  } else {
  Write-Host '[1/7] Downloading a private Node.js 24 runtime...'
  $base = 'https://nodejs.org/dist/latest-v24.x/'
  $checksums = (Invoke-WebRequest -Uri ($base + 'SHASUMS256.txt') -UseBasicParsing -TimeoutSec 60).Content
  $line = $checksums -split "`n" | Where-Object { $_ -match '^([a-fA-F0-9]{64})\s+(node-v24\.[0-9]+\.[0-9]+-win-x64\.zip)\s*$' } | Select-Object -First 1
  if (-not $line -or $line -notmatch '^([a-fA-F0-9]{64})\s+(node-v24\.[0-9]+\.[0-9]+-win-x64\.zip)\s*$') { throw 'Could not locate the Windows x64 Node.js 24 archive and checksum.' }
  $expectedHash = $Matches[1].ToLowerInvariant()
  $archiveName = $Matches[2]
  $archivePath = Join-Path $downloadDir $archiveName
  Download-File ($base + $archiveName) $archivePath
  $actualHash = Get-Sha256 -Path $archivePath
  if ($actualHash -ne $expectedHash) { throw 'Node.js SHA-256 verification failed.' }
  Expand-Archive -LiteralPath $archivePath -DestinationPath $downloadDir
  $nodeDir = Join-Path $downloadDir ([IO.Path]::GetFileNameWithoutExtension($archiveName))
  if (-not (Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe')) -or -not (Test-Path -LiteralPath (Join-Path $nodeDir 'npm.cmd'))) { throw 'Node.js archive is incomplete.' }
  Copy-Item -Path (Join-Path $nodeDir '*') -Destination $runtime -Recurse -Force
  }
  $node = Join-Path $runtime 'node.exe'
  $npm = Join-Path $runtime 'npm.cmd'
  $env:PATH = $runtime + ';' + $env:PATH
  $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $target 'browsers'

  $stage = 'preparing portable Git'
  $gitDir = Join-Path $release 'git'
  $previousGit = if ($Update) { Join-Path (Join-Path (Join-Path $target 'releases') $ExpectedCurrentRelease) 'git' } else { '' }
  if ($previousGit -and (Test-Path -LiteralPath (Join-Path $previousGit 'cmd\git.exe'))) {
    Write-Host '[2/7] Reusing the installed portable Git...'
    Copy-Item -LiteralPath $previousGit -Destination $gitDir -Recurse
  } else {
  Write-Host '[2/7] Downloading and verifying portable Git...'
  $gitRelease = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ 'User-Agent' = 'chatgpt-coder' } -TimeoutSec 60
  $gitAsset = $gitRelease.assets | Where-Object { $_.name -match '^MinGit-[0-9.]+-64-bit\.zip$' } | Select-Object -First 1
  if (-not $gitAsset -or $gitAsset.digest -notmatch '^sha256:([a-fA-F0-9]{64})$') { throw 'No verified portable Git archive was found.' }
  $gitHash = $Matches[1].ToLowerInvariant()
  $gitUri = [Uri]$gitAsset.browser_download_url
  if ($gitUri.Scheme -ne 'https' -or $gitUri.Host -ne 'github.com' -or -not $gitUri.AbsolutePath.StartsWith('/git-for-windows/git/releases/download/')) { throw 'Unexpected portable Git download URL.' }
  $gitZip = Join-Path $downloadDir $gitAsset.name
  Download-File $gitUri.AbsoluteUri $gitZip
  if ((Get-Sha256 -Path $gitZip) -ne $gitHash) { throw 'Portable Git SHA-256 verification failed.' }
  Expand-Archive -LiteralPath $gitZip -DestinationPath $gitDir
  }
  if (-not (Test-Path -LiteralPath (Join-Path $gitDir 'cmd\git.exe'))) { throw 'Portable Git archive is incomplete.' }

  $stage = 'installing npm dependencies'
  Write-Host '[3/7] Preparing the application and installing npm dependencies...'
  foreach ($file in @('package.json', 'package-lock.json', 'tsconfig.json')) {
    Copy-Item -LiteralPath (Join-Path $source $file) -Destination $app
  }
  Copy-Item -LiteralPath (Join-Path $source 'src') -Destination (Join-Path $app 'src') -Recurse
  Push-Location $app
  try {
    $prebuilt = Join-Path $source 'prebuilt\dist'
    if (Test-Path -LiteralPath (Join-Path $prebuilt 'index.js')) {
      Invoke-Checked -Executable $npm -Arguments @('ci', '--omit=dev', '--no-audit', '--no-fund')
      $stage = 'installing prebuilt application'
      Write-Host '[4/7] Installing prebuilt chatgpt-coder...'
      Copy-Item -LiteralPath $prebuilt -Destination (Join-Path $app 'dist') -Recurse
    } else {
      Invoke-Checked -Executable $npm -Arguments @('ci', '--no-audit', '--no-fund')
      $stage = 'building chatgpt-coder'
      Write-Host '[4/7] Building chatgpt-coder...'
      Invoke-Checked -Executable $npm -Arguments @('run', 'build')
    }
    $stage = 'downloading Playwright Chromium'
    Write-Host '[5/7] Downloading Playwright Chromium...'
    Invoke-Checked -Executable $node -Arguments @((Join-Path $app 'node_modules\playwright\cli.js'), 'install', 'chromium')
    $stage = 'installing tunnel-client'
    Write-Host '[6/7] Downloading and verifying tunnel-client...'
    if ($Update) { Write-Host 'Keeping the existing tunnel-client while the harness is running.' }
    else { Invoke-Checked -Executable $node -Arguments @((Join-Path $app 'dist\index.js'), '--install-tunnel') }
    Invoke-Checked -Executable $npm -Arguments @('prune', '--omit=dev', '--no-audit', '--no-fund')
  } finally {
    Pop-Location
  }

  # Downloaded archives and extracted staging copies are no longer needed once
  # the private runtime and Git are installed in this new release.
  try { Remove-ManagedDirectory -Directory $downloadDir -Parent $release -ExpectedName 'download' }
  catch { Write-Warning ("Could not remove installation downloads: " + $_.Exception.Message) }

  $stage = 'registering the executable and PATH'
  Write-Host '[7/7] Creating the executable and registering PATH...'
  $launcher = Join-Path $target 'chatgpt-coder.exe'
  if (-not $Update) {
    $launcherBuild = Join-Path $release 'chatgpt-coder.exe'
    $prebuiltLauncher = Join-Path $source 'prebuilt\chatgpt-coder.exe'
    if (Test-Path -LiteralPath $prebuiltLauncher) { Copy-Item -LiteralPath $prebuiltLauncher -Destination $launcherBuild }
    else { Invoke-Checked -Executable $compiler -Arguments @('/nologo', '/target:exe', "/out:$launcherBuild", (Join-Path $source 'scripts\windows-launcher.cs')) }
    Copy-Item -LiteralPath $launcherBuild -Destination $launcher -Force
  }
  if ($Update -and ([IO.File]::ReadAllText($marker).Trim()) -ne $ExpectedCurrentRelease) { throw 'The active release changed during the update; nothing was switched.' }
  $previousRelease = if (Test-Path -LiteralPath $marker) { [IO.File]::ReadAllText($marker).Trim() } else { '' }
  $package = Get-Content -LiteralPath (Join-Path $app 'package.json') -Raw | ConvertFrom-Json
  if ($package.name -ne 'chatgpt-coder' -or -not $package.version) { throw 'Invalid application package metadata.' }
  $metadata = @{ version = [string]$package.version; previous = $previousRelease; installedAt = [DateTime]::UtcNow.ToString('o') }
  $releaseInfoPath = Join-Path $source 'prebuilt\release-info.json'
  if (Test-Path -LiteralPath $releaseInfoPath) {
    $releaseInfo = Get-Content -LiteralPath $releaseInfoPath -Raw | ConvertFrom-Json
    if ($releaseInfo.repository -match '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$' -and $releaseInfo.tag -match '^build-\d+-\d+$' -and $releaseInfo.commit -match '^[a-f0-9]{40}$') {
      $metadata.repository = [string]$releaseInfo.repository
      $metadata.tag = [string]$releaseInfo.tag
      $metadata.commit = [string]$releaseInfo.commit
    }
  }
  $releaseMetadata = $metadata | ConvertTo-Json -Compress
  [IO.File]::WriteAllText((Join-Path $release 'release.json'), $releaseMetadata, [Text.Encoding]::UTF8)
  $markerTemp = Join-Path $target ('.current-' + $releaseId + '.tmp')
  [IO.File]::WriteAllText($markerTemp, $releaseId, [Text.Encoding]::ASCII)
  if (Test-Path -LiteralPath $marker) {
    # Windows PowerShell 5.1 can marshal a null backup filename as an empty
    # path. Use a unique real backup path, then remove it after the switch.
    $markerBackup = Join-Path $target ('.previous-' + $releaseId + '.tmp')
    [IO.File]::Replace($markerTemp, $marker, $markerBackup)
    Remove-Item -LiteralPath $markerBackup -Force -ErrorAction SilentlyContinue
  }
  else { [IO.File]::Move($markerTemp, $marker) }
  $activated = $true

  if ($Update) {
    Write-Host "Update installed: $($package.version). Restart chatgpt-coder to use it."
    try { Remove-OldReleases -Root $target -Current $releaseId -Previous $previousRelease }
    catch { Write-Warning ("Old release cleanup was skipped: " + $_.Exception.Message) }
    exit 0
  }

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @($userPath -split ';' | Where-Object { $_ })
  $exists = $false
  foreach ($entry in $entries) {
    if ([Environment]::ExpandEnvironmentVariables($entry).TrimEnd('\') -ieq $target.TrimEnd('\')) { $exists = $true; break }
  }
  if (-not $exists) {
    $newPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $target } else { $userPath.TrimEnd(';') + ';' + $target }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    try {
      if (-not ('ChatgptCoderEnvironmentBroadcast' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ChatgptCoderEnvironmentBroadcast {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
      }
      $result = [UIntPtr]::Zero
      [void][ChatgptCoderEnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
    } catch {
      Write-Warning 'PATH was saved, but Windows could not broadcast the update. Open a new terminal or sign out and back in.'
    }
  }
  $conflict = Get-Command chatgpt-coder -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conflict -and $conflict.Source -and $conflict.Source -ine $launcher) {
    Write-Warning "Another chatgpt-coder command is already on PATH: $($conflict.Source). Check Get-Command chatgpt-coder -All if the wrong version launches."
  }
  Install-SearchIfAvailable
  Write-Host ''
  Write-Host "Installed: $launcher"
  Write-Host 'Open a NEW terminal, cd to any project folder, then run: chatgpt-coder'
  Write-Host 'In the harness run /connect to configure the OpenAI tunnel and connector.'
  Write-Host 'Web search requires the SearXNG JSON API. See the messages above and README.md.'
  Write-Host 'The previous release is kept for rollback; credentials and sessions were not removed.'
} catch {
  $failure = "Installation failed while ${stage}: " + $_.Exception.Message
  Write-Host $failure -ForegroundColor Red
  if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace }
  if ($logPath) { Write-Host "Installation log: $logPath" }
  exit 1
} finally {
  if (-not $activated -and $release -and $target -and $releaseId -match '^[0-9a-f]{32}$' -and (Test-Path -LiteralPath $release)) {
    try {
      $markerPath = Join-Path $target 'current.txt'
      $selected = if (Test-Path -LiteralPath $markerPath) { [IO.File]::ReadAllText($markerPath).Trim() } else { '' }
      $rootItem = Get-Item -LiteralPath $target -Force -ErrorAction Stop
      if ($selected -ne $releaseId -and -not ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        Remove-ManagedDirectory -Directory $release -Parent (Join-Path $target 'releases') -ExpectedName $releaseId
        Write-Host '[cleanup] Removed the incomplete release from this failed installation.'
      }
    } catch { Write-Warning ("Could not remove the incomplete release: " + $_.Exception.Message) }
  }
  if ($transcriptStarted) { Stop-Transcript | Out-Null }
}
