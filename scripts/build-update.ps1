#requires -version 5.1
param([string]$OutputPath = '')

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$stage = $null
$stageRoot = $null
try {
  if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) { throw 'Windows 10/11 x64 or ARM64 is required.' }
  $package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
  if ($package.name -ne 'chatgpt-coder' -or $package.version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') { throw 'Invalid package name or version.' }
  if (-not $OutputPath) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $OutputPath = Join-Path $root ("dist\updates\chatgpt-coder-update-$($package.version)-$stamp.zip")
  }
  $output = [IO.Path]::GetFullPath($OutputPath)
  if ([IO.Path]::GetExtension($output) -ine '.zip') { throw 'OutputPath must end in .zip.' }
  if (Test-Path -LiteralPath $output) { throw "Output already exists: $output. Choose another -OutputPath." }

  $runtime = $null
  $installedRoot = Join-Path $env:LOCALAPPDATA 'Programs\chatgpt-coder'
  $marker = Join-Path $installedRoot 'current.txt'
  if (Test-Path -LiteralPath $marker) {
    $release = [IO.File]::ReadAllText($marker).Trim()
    if ($release -match '^[0-9a-f]{32}$') {
      $candidate = Join-Path $installedRoot "releases\$release\runtime"
      if ((Test-Path -LiteralPath (Join-Path $candidate 'node.exe')) -and (Test-Path -LiteralPath (Join-Path $candidate 'npm.cmd'))) { $runtime = $candidate }
    }
  }
  if ($runtime) { $node = Join-Path $runtime 'node.exe'; $npm = Join-Path $runtime 'npm.cmd'; $env:PATH = $runtime + ';' + $env:PATH }
  else {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $nodeCommand -or -not $npmCommand) { throw 'Node.js 22 or newer and npm are required. Install chatgpt-coder first or install Node.js.' }
    $node = $nodeCommand.Source; $npm = $npmCommand.Source
  }
  $nodeVersion = & $node --version
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { throw 'Node.js 22 or newer is required.' }
  $lockInfo = & $node -e 'const p = require(process.argv[1]); process.stdout.write(JSON.stringify({name:p.name,version:p.version}));' (Join-Path $root 'package-lock.json')
  if ($LASTEXITCODE -ne 0) { throw 'Could not read package-lock.json.' }
  $lock = $lockInfo | ConvertFrom-Json
  if ($lock.name -ne $package.name -or $lock.version -ne $package.version) { throw 'Package and lock file names or versions do not match.' }
  $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path -LiteralPath $compiler)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
  if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework 4 C# compiler not found.' }

  $stageRoot = (Resolve-Path -LiteralPath $env:TEMP).Path.TrimEnd('\')
  $stage = Join-Path $stageRoot ('chatgpt-coder-build-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage | Out-Null
  $inputs = @('install.cmd', 'build-update.cmd', 'package.json', 'package-lock.json', 'tsconfig.json', 'README.md', '.gitignore', '.env.example', 'harness.config.example.json', 'src', 'scripts', 'docs')
  foreach ($name in $inputs) {
    $item = Join-Path $root $name
    if (-not (Test-Path -LiteralPath $item)) { throw "Missing build input: $item" }
    Copy-Item -LiteralPath $item -Destination (Join-Path $stage $name) -Recurse
  }
  Push-Location $stage
  try {
    Write-Host '[1/4] Installing build dependencies from package-lock.json...'
    & $npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }

    # Stamp unique build metadata only into the disposable CI staging folder.
    if ($env:GITHUB_ACTIONS -eq 'true' -and $env:GITHUB_EVENT_NAME -ne 'pull_request' -and
        ($env:GITHUB_REF_NAME -eq 'main' -or $env:GITHUB_REF_NAME -eq 'pre-release')) {
      $baseVersion = $package.version.Split('+')[0]
      $ciVersion = $baseVersion + '+build.' + $env:GITHUB_RUN_ID + '.' + $env:GITHUB_RUN_ATTEMPT
      & $node (Join-Path $stage 'scripts/stamp-build-version.cjs') $ciVersion
      if ($LASTEXITCODE -ne 0) { throw 'Could not stamp CI version.' }
      $package.version = $ciVersion
      Write-Host ('CI version: ' + $ciVersion)
    }
    Write-Host '[2/4] Compiling application...'
    & $npm run build
    if ($LASTEXITCODE -ne 0) { throw "Application build failed with exit code $LASTEXITCODE." }
    if (-not (Test-Path -LiteralPath (Join-Path $stage 'dist\index.js'))) { throw 'Compiled application entry point is missing.' }
    $prebuilt = Join-Path $stage 'prebuilt'
    New-Item -ItemType Directory -Path $prebuilt | Out-Null
    Move-Item -LiteralPath (Join-Path $stage 'dist') -Destination (Join-Path $prebuilt 'dist')
    if ($env:GITHUB_ACTIONS -eq 'true' -and $env:GITHUB_REPOSITORY -match '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$' -and $env:GITHUB_SHA -match '^[a-f0-9]{40}$' -and $env:GITHUB_RUN_ID -match '^\d+$' -and $env:GITHUB_RUN_ATTEMPT -match '^\d+$') {
      $sourceSha = $env:CHATGPT_CODER_SOURCE_SHA
      if (-not $sourceSha) { $sourceSha = $env:GITHUB_SHA }
      if ($sourceSha -notmatch '^[a-f0-9]{40}$') { throw 'Invalid release source commit SHA.' }
      if ($env:GITHUB_REF_NAME -eq 'main' -and $env:GITHUB_EVENT_NAME -ne 'pull_request') { $releaseTag = "build-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)" }
      elseif ($env:GITHUB_REF_NAME -eq 'pre-release' -and $env:GITHUB_EVENT_NAME -ne 'pull_request') { $releaseTag = "prerelease-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)" }
      else { $releaseTag = "ci-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)" }
      $releaseInfo = @{ repository = $env:GITHUB_REPOSITORY; tag = $releaseTag; commit = $sourceSha } | ConvertTo-Json -Compress
      [IO.File]::WriteAllText((Join-Path $prebuilt 'release-info.json'), $releaseInfo, (New-Object Text.UTF8Encoding $false))
    }
    Write-Host '[3/4] Compiling Windows launcher...'
    & $compiler /nologo /target:exe ("/out:" + (Join-Path $prebuilt 'chatgpt-coder.exe')) (Join-Path $stage 'scripts\windows-launcher.cs')
    if ($LASTEXITCODE -ne 0) { throw "Launcher build failed with exit code $LASTEXITCODE." }
    Write-Host '[4/4] Creating update ZIP...'
    New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($output)) | Out-Null
    $files = @($inputs + 'prebuilt') | ForEach-Object { Join-Path $stage $_ }
    Compress-Archive -LiteralPath $files -DestinationPath $output -CompressionLevel Optimal
    $size = (Get-Item -LiteralPath $output).Length
    if ($size -gt 100MB) { throw "Update exceeds the 100 MB limit: $output" }
    $sha = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash
    Write-Host "Update ZIP: $output"
    Write-Host "Version: $($package.version)"
    Write-Host "SHA-256: $sha"
    Write-Host 'In the installed harness use /update, select this ZIP, and run /update apply.'
  } finally { Pop-Location }
} catch {
  Write-Host ("Build failed: " + $_.Exception.Message) -ForegroundColor Red
  if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace }
  exit 1
} finally {
  if ($stage -and $stageRoot -and (Test-Path -LiteralPath $stage)) {
    $item = Get-Item -LiteralPath $stage -Force
    $resolved = (Resolve-Path -LiteralPath $stage).Path
    if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and [IO.Path]::GetDirectoryName($resolved) -ieq $stageRoot -and $item.Name -match '^chatgpt-coder-build-[0-9a-f]{32}$') {
      Remove-Item -LiteralPath $resolved -Recurse -Force
    } else { Write-Warning "Build staging directory was not removed: $stage" }
  }
}
 -and $env:GITHUB_RUN_ATTEMPT -match '^\d+
    & $npm run build
    if ($LASTEXITCODE -ne 0) { throw "Application build failed with exit code $LASTEXITCODE." }
    if (-not (Test-Path -LiteralPath (Join-Path $stage 'dist\index.js'))) { throw 'Compiled application entry point is missing.' }
    $prebuilt = Join-Path $stage 'prebuilt'
    New-Item -ItemType Directory -Path $prebuilt | Out-Null
    Move-Item -LiteralPath (Join-Path $stage 'dist') -Destination (Join-Path $prebuilt 'dist')
    if ($env:GITHUB_ACTIONS -eq 'true' -and $env:GITHUB_REPOSITORY -match '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$' -and $env:GITHUB_SHA -match '^[a-f0-9]{40}$' -and $env:GITHUB_RUN_ID -match '^\d+$' -and $env:GITHUB_RUN_ATTEMPT -match '^\d+$') {
      $sourceSha = $env:CHATGPT_CODER_SOURCE_SHA
      if (-not $sourceSha) { $sourceSha = $env:GITHUB_SHA }
      if ($sourceSha -notmatch '^[a-f0-9]{40}$') { throw 'Invalid release source commit SHA.' }
      if ($env:GITHUB_REF_NAME -eq 'main' -and $env:GITHUB_EVENT_NAME -ne 'pull_request') { $releaseTag = "build-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)" }
      elseif ($env:GITHUB_REF_NAME -eq 'pre-release' -and $env:GITHUB_EVENT_NAME -ne 'pull_request') { $releaseTag = "prerelease-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)" }
      else { $releaseTag = "ci-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)" }
      $releaseInfo = @{ repository = $env:GITHUB_REPOSITORY; tag = $releaseTag; commit = $sourceSha } | ConvertTo-Json -Compress
      [IO.File]::WriteAllText((Join-Path $prebuilt 'release-info.json'), $releaseInfo, (New-Object Text.UTF8Encoding $false))
    }
    Write-Host '[3/4] Compiling Windows launcher...'
    & $compiler /nologo /target:exe ("/out:" + (Join-Path $prebuilt 'chatgpt-coder.exe')) (Join-Path $stage 'scripts\windows-launcher.cs')
    if ($LASTEXITCODE -ne 0) { throw "Launcher build failed with exit code $LASTEXITCODE." }
    Write-Host '[4/4] Creating update ZIP...'
    New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($output)) | Out-Null
    $files = @($inputs + 'prebuilt') | ForEach-Object { Join-Path $stage $_ }
    Compress-Archive -LiteralPath $files -DestinationPath $output -CompressionLevel Optimal
    $size = (Get-Item -LiteralPath $output).Length
    if ($size -gt 100MB) { throw "Update exceeds the 100 MB limit: $output" }
    $sha = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash
    Write-Host "Update ZIP: $output"
    Write-Host "Version: $($package.version)"
    Write-Host "SHA-256: $sha"
    Write-Host 'In the installed harness use /update, select this ZIP, and run /update apply.'
  } finally { Pop-Location }
} catch {
  Write-Host ("Build failed: " + $_.Exception.Message) -ForegroundColor Red
  if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace }
  exit 1
} finally {
  if ($stage -and $stageRoot -and (Test-Path -LiteralPath $stage)) {
    $item = Get-Item -LiteralPath $stage -Force
    $resolved = (Resolve-Path -LiteralPath $stage).Path
    if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and [IO.Path]::GetDirectoryName($resolved) -ieq $stageRoot -and $item.Name -match '^chatgpt-coder-build-[0-9a-f]{32}$') {
      Remove-Item -LiteralPath $resolved -Recurse -Force
    } else { Write-Warning "Build staging directory was not removed: $stage" }
  }
}
) {
      $baseVersion = $package.version -replace '\+.*
    & $npm run build
    if ($LASTEXITCODE -ne 0) { throw "Application build failed with exit code $LASTEXITCODE." }
    if (-not (Test-Path -LiteralPath (Join-Path $stage 'dist\index.js'))) { throw 'Compiled application entry point is missing.' }
    $prebuilt = Join-Path $stage 'prebuilt'
    New-Item -ItemType Directory -Path $prebuilt | Out-Null
    Move-Item -LiteralPath (Join-Path $stage 'dist') -Destination (Join-Path $prebuilt 'dist')
    if ($env:GITHUB_ACTIONS -eq 'true' -and $env:GITHUB_REPOSITORY -match '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$' -and $env:GITHUB_SHA -match '^[a-f0-9]{40}$' -and $env:GITHUB_RUN_ID -match '^\d+$' -and $env:GITHUB_RUN_ATTEMPT -match '^\d+$') {
      $sourceSha = $env:CHATGPT_CODER_SOURCE_SHA
      if (-not $sourceSha) { $sourceSha = $env:GITHUB_SHA }
      if ($sourceSha -notmatch '^[a-f0-9]{40}$') { throw 'Invalid release source commit SHA.' }
      if ($env:GITHUB_REF_NAME -eq 'main' -and $env:GITHUB_EVENT_NAME -ne 'pull_request') { $releaseTag = "build-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)" }
      elseif ($env:GITHUB_REF_NAME -eq 'pre-release' -and $env:GITHUB_EVENT_NAME -ne 'pull_request') { $releaseTag = "prerelease-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)" }
      else { $releaseTag = "ci-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)" }
      $releaseInfo = @{ repository = $env:GITHUB_REPOSITORY; tag = $releaseTag; commit = $sourceSha } | ConvertTo-Json -Compress
      [IO.File]::WriteAllText((Join-Path $prebuilt 'release-info.json'), $releaseInfo, (New-Object Text.UTF8Encoding $false))
    }
    Write-Host '[3/4] Compiling Windows launcher...'
    & $compiler /nologo /target:exe ("/out:" + (Join-Path $prebuilt 'chatgpt-coder.exe')) (Join-Path $stage 'scripts\windows-launcher.cs')
    if ($LASTEXITCODE -ne 0) { throw "Launcher build failed with exit code $LASTEXITCODE." }
    Write-Host '[4/4] Creating update ZIP...'
    New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($output)) | Out-Null
    $files = @($inputs + 'prebuilt') | ForEach-Object { Join-Path $stage $_ }
    Compress-Archive -LiteralPath $files -DestinationPath $output -CompressionLevel Optimal
    $size = (Get-Item -LiteralPath $output).Length
    if ($size -gt 100MB) { throw "Update exceeds the 100 MB limit: $output" }
    $sha = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash
    Write-Host "Update ZIP: $output"
    Write-Host "Version: $($package.version)"
    Write-Host "SHA-256: $sha"
    Write-Host 'In the installed harness use /update, select this ZIP, and run /update apply.'
  } finally { Pop-Location }
} catch {
  Write-Host ("Build failed: " + $_.Exception.Message) -ForegroundColor Red
  if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace }
  exit 1
} finally {
  if ($stage -and $stageRoot -and (Test-Path -LiteralPath $stage)) {
    $item = Get-Item -LiteralPath $stage -Force
    $resolved = (Resolve-Path -LiteralPath $stage).Path
    if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and [IO.Path]::GetDirectoryName($resolved) -ieq $stageRoot -and $item.Name -match '^chatgpt-coder-build-[0-9a-f]{32}$') {
      Remove-Item -LiteralPath $resolved -Recurse -Force
    } else { Write-Warning "Build staging directory was not removed: $stage" }
  }
}
, ''
      $env:CHATGPT_CODER_BUILD_VERSION = "$baseVersion+build.$($env:GITHUB_RUN_ID).$($env:GITHUB_RUN_ATTEMPT)"
      & $node -e 'const fs = require("node:fs"); const version = process.env.CHATGPT_CODER_BUILD_VERSION; const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")); const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8")); pkg.version = version; lock.version = version; lock.packages[""].version = version; fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n"); fs.writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");'
      if ($LASTEXITCODE -ne 0) { throw 'Could not stamp the CI build version.' }
      $package.version = $env:CHATGPT_CODER_BUILD_VERSION
      Write-Host "CI release version: $($package.version)"
    }

    Write-Host '[2/4] Compiling application...'
    & $npm run build
    if ($LASTEXITCODE -ne 0) { throw "Application build failed with exit code $LASTEXITCODE." }
    if (-not (Test-Path -LiteralPath (Join-Path $stage 'dist\index.js'))) { throw 'Compiled application entry point is missing.' }
    $prebuilt = Join-Path $stage 'prebuilt'
    New-Item -ItemType Directory -Path $prebuilt | Out-Null
    Move-Item -LiteralPath (Join-Path $stage 'dist') -Destination (Join-Path $prebuilt 'dist')
    if ($env:GITHUB_ACTIONS -eq 'true' -and $env:GITHUB_REPOSITORY -match '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$' -and $env:GITHUB_SHA -match '^[a-f0-9]{40}$' -and $env:GITHUB_RUN_ID -match '^\d+$' -and $env:GITHUB_RUN_ATTEMPT -match '^\d+$') {
      $sourceSha = $env:CHATGPT_CODER_SOURCE_SHA
      if (-not $sourceSha) { $sourceSha = $env:GITHUB_SHA }
      if ($sourceSha -notmatch '^[a-f0-9]{40}$') { throw 'Invalid release source commit SHA.' }
      if ($env:GITHUB_REF_NAME -eq 'main' -and $env:GITHUB_EVENT_NAME -ne 'pull_request') { $releaseTag = "build-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)" }
      elseif ($env:GITHUB_REF_NAME -eq 'pre-release' -and $env:GITHUB_EVENT_NAME -ne 'pull_request') { $releaseTag = "prerelease-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)" }
      else { $releaseTag = "ci-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)" }
      $releaseInfo = @{ repository = $env:GITHUB_REPOSITORY; tag = $releaseTag; commit = $sourceSha } | ConvertTo-Json -Compress
      [IO.File]::WriteAllText((Join-Path $prebuilt 'release-info.json'), $releaseInfo, (New-Object Text.UTF8Encoding $false))
    }
    Write-Host '[3/4] Compiling Windows launcher...'
    & $compiler /nologo /target:exe ("/out:" + (Join-Path $prebuilt 'chatgpt-coder.exe')) (Join-Path $stage 'scripts\windows-launcher.cs')
    if ($LASTEXITCODE -ne 0) { throw "Launcher build failed with exit code $LASTEXITCODE." }
    Write-Host '[4/4] Creating update ZIP...'
    New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($output)) | Out-Null
    $files = @($inputs + 'prebuilt') | ForEach-Object { Join-Path $stage $_ }
    Compress-Archive -LiteralPath $files -DestinationPath $output -CompressionLevel Optimal
    $size = (Get-Item -LiteralPath $output).Length
    if ($size -gt 100MB) { throw "Update exceeds the 100 MB limit: $output" }
    $sha = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash
    Write-Host "Update ZIP: $output"
    Write-Host "Version: $($package.version)"
    Write-Host "SHA-256: $sha"
    Write-Host 'In the installed harness use /update, select this ZIP, and run /update apply.'
  } finally { Pop-Location }
} catch {
  Write-Host ("Build failed: " + $_.Exception.Message) -ForegroundColor Red
  if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace }
  exit 1
} finally {
  if ($stage -and $stageRoot -and (Test-Path -LiteralPath $stage)) {
    $item = Get-Item -LiteralPath $stage -Force
    $resolved = (Resolve-Path -LiteralPath $stage).Path
    if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and [IO.Path]::GetDirectoryName($resolved) -ieq $stageRoot -and $item.Name -match '^chatgpt-coder-build-[0-9a-f]{32}$') {
      Remove-Item -LiteralPath $resolved -Recurse -Force
    } else { Write-Warning "Build staging directory was not removed: $stage" }
  }
}
