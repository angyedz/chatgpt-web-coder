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
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
$transcriptStarted = $false
$stage = 'starting installer'

function Invoke-Checked {
  param([string]$Executable, [string[]]$Arguments)
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Command failed (exit $LASTEXITCODE): $Executable" }
}

function Download-File {
  param([string]$Url, [string]$Destination)
  Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -TimeoutSec 300
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

  $stage = 'downloading Node.js'
  Write-Host '[1/7] Downloading a private Node.js 24 runtime...'
  $base = 'https://nodejs.org/dist/latest-v24.x/'
  $checksums = (Invoke-WebRequest -Uri ($base + 'SHASUMS256.txt') -UseBasicParsing -TimeoutSec 60).Content
  $line = $checksums -split "`n" | Where-Object { $_ -match '^([a-fA-F0-9]{64})\s+(node-v24\.[0-9]+\.[0-9]+-win-x64\.zip)\s*$' } | Select-Object -First 1
  if (-not $line -or $line -notmatch '^([a-fA-F0-9]{64})\s+(node-v24\.[0-9]+\.[0-9]+-win-x64\.zip)\s*$') { throw 'Could not locate the Windows x64 Node.js 24 archive and checksum.' }
  $expectedHash = $Matches[1].ToLowerInvariant()
  $archiveName = $Matches[2]
  $archivePath = Join-Path $downloadDir $archiveName
  Download-File ($base + $archiveName) $archivePath
  $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) { throw 'Node.js SHA-256 verification failed.' }
  Expand-Archive -LiteralPath $archivePath -DestinationPath $downloadDir
  $nodeDir = Join-Path $downloadDir ([IO.Path]::GetFileNameWithoutExtension($archiveName))
  if (-not (Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe')) -or -not (Test-Path -LiteralPath (Join-Path $nodeDir 'npm.cmd'))) { throw 'Node.js archive is incomplete.' }
  Copy-Item -Path (Join-Path $nodeDir '*') -Destination $runtime -Recurse -Force
  $node = Join-Path $runtime 'node.exe'
  $npm = Join-Path $runtime 'npm.cmd'
  $env:PATH = $runtime + ';' + $env:PATH
  $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $target 'browsers'

  $stage = 'downloading portable Git'
  Write-Host '[2/7] Downloading and verifying portable Git...'
  $gitRelease = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ 'User-Agent' = 'chatgpt-coder' } -TimeoutSec 60
  $gitAsset = $gitRelease.assets | Where-Object { $_.name -match '^MinGit-[0-9.]+-64-bit\.zip$' } | Select-Object -First 1
  if (-not $gitAsset -or $gitAsset.digest -notmatch '^sha256:([a-fA-F0-9]{64})$') { throw 'No verified portable Git archive was found.' }
  $gitHash = $Matches[1].ToLowerInvariant()
  $gitUri = [Uri]$gitAsset.browser_download_url
  if ($gitUri.Scheme -ne 'https' -or $gitUri.Host -ne 'github.com' -or -not $gitUri.AbsolutePath.StartsWith('/git-for-windows/git/releases/download/')) { throw 'Unexpected portable Git download URL.' }
  $gitZip = Join-Path $downloadDir $gitAsset.name
  Download-File $gitUri.AbsoluteUri $gitZip
  if ((Get-FileHash -LiteralPath $gitZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $gitHash) { throw 'Portable Git SHA-256 verification failed.' }
  $gitDir = Join-Path $release 'git'
  Expand-Archive -LiteralPath $gitZip -DestinationPath $gitDir
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
  $releaseMetadata = @{ version = [string]$package.version; previous = $previousRelease; installedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
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

  if ($Update) {
    Write-Host "Update installed: $($package.version). Restart chatgpt-coder to use it."
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
  Write-Host 'Previous releases are retained under releases; credentials and sessions were not removed.'
} catch {
  $failure = "Installation failed while ${stage}: " + $_.Exception.Message
  Write-Host $failure -ForegroundColor Red
  if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace }
  if ($logPath) { Write-Host "Installation log: $logPath" }
  exit 1
} finally {
  if ($transcriptStarted) { Stop-Transcript | Out-Null }
}
