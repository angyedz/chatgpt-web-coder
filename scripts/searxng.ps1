#requires -version 5.1
<#
.SYNOPSIS
  Manage the local SearXNG instance used by chatgpt-coder's web_search tool.

.DESCRIPTION
  SearXNG runs as a Docker container inside the "archlinux" WSL2 distro.
  WSL2 stops the VM when the last session exits, so the container is kept
  alive by a hidden `sleep infinity` session. This script can start that
  session, (re)start the container and verify the JSON API.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/searxng.ps1 start
  powershell -ExecutionPolicy Bypass -File scripts/searxng.ps1 status
  powershell -ExecutionPolicy Bypass -File scripts/searxng.ps1 logs
#>
param(
  [ValidateSet("start", "stop", "status", "logs", "restart")]
  [string]$Action = "status",
  [string]$Distro = "archlinux",
  [string]$Container = "searxng",
  [int]$Port = 8888
)

$ErrorActionPreference = "Stop"
$BaseUrl = "http://127.0.0.1:$Port"

function Invoke-Wsl {
  param([string]$Command)
  & wsl.exe -d $Distro -e bash -lc $Command
}

function Test-KeepAlive {
  # Look for an existing `sleep infinity` session inside the distro.
  $out = & wsl.exe -d $Distro -e bash -lc "pgrep -f 'sleep infinity' >/dev/null && echo yes || echo no" 2>$null
  return ($out -join "").Trim() -eq "yes"
}

function Start-KeepAlive {
  if (-not (Test-KeepAlive)) {
    Start-Process -FilePath "wsl.exe" `
      -ArgumentList "-d", $Distro, "-e", "/bin/sleep", "infinity" `
      -WindowStyle Hidden | Out-Null
    Write-Host "WSL keep-alive session started ($Distro)."
  }
}

function Wait-Http {
  param([int]$Seconds = 60)
  for ($i = 0; $i -lt $Seconds; $i++) {
    try {
      $r = Invoke-WebRequest -Uri "$BaseUrl/search?q=ping&format=json" -UseBasicParsing -TimeoutSec 5
      if ($r.StatusCode -eq 200) { return $true }
    } catch { }
    Start-Sleep -Seconds 1
  }
  return $false
}

switch ($Action) {
  "start" {
    Start-KeepAlive
    $null = Invoke-Wsl "systemctl start docker 2>/dev/null || true"
    $running = (Invoke-Wsl "docker inspect -f '{{.State.Running}}' $Container 2>/dev/null || echo missing") -join ""
    if ($running.Trim() -eq "true") {
      Write-Host "Container '$Container' already running."
    } elseif ($running.Trim() -eq "false") {
      $null = Invoke-Wsl "docker start $Container"
      Write-Host "Container '$Container' started."
    } else {
      $null = Invoke-Wsl "mkdir -p /opt/searxng"
      $null = Invoke-Wsl "docker run -d --name $Container --restart unless-stopped -p 127.0.0.1:$Port`:8080 -v /opt/searxng:/etc/searxng:rw searxng/searxng:latest"
      Write-Host "Container '$Container' created."
    }
    if (Wait-Http) { Write-Host "SearXNG is up: $BaseUrl" } else { Write-Host "SearXNG did not answer within the timeout."; exit 1 }
  }
  "stop" {
    $null = Invoke-Wsl "docker stop $Container 2>/dev/null || true"
    Write-Host "Container '$Container' stopped."
  }
  "restart" {
    $null = Invoke-Wsl "docker restart $Container"
    if (Wait-Http) { Write-Host "SearXNG is up: $BaseUrl" } else { Write-Host "SearXNG did not answer within the timeout."; exit 1 }
  }
  "logs" {
    Invoke-Wsl "docker logs --tail 80 $Container 2>&1"
  }
  "status" {
    $alive = Test-KeepAlive
    Write-Host ("keep-alive: {0}" -f $(if ($alive) { "running" } else { "missing" }))
    Invoke-Wsl "docker ps -a --filter name=$Container --format '{{.Names}} | {{.Status}} | {{.Ports}}' 2>/dev/null || echo 'docker unavailable'"
    try {
      $r = Invoke-WebRequest -Uri "$BaseUrl/search?q=ping&format=json" -UseBasicParsing -TimeoutSec 10
      Write-Host ("json api: HTTP {0} at {1}" -f $r.StatusCode, $BaseUrl)
    } catch {
      Write-Host ("json api: unreachable at {0}" -f $BaseUrl)
      exit 1
    }
  }
}
