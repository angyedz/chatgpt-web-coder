#requires -version 5.1
param(
  [string]$OutputPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist\chatgpt-coder-windows-setup.zip')
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$output = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $output) { throw "Output already exists: $output. Choose a different -OutputPath." }
$files = @('install.cmd', 'package.json', 'package-lock.json', 'tsconfig.json', 'README.md', '.gitignore', '.env.example', 'harness.config.example.json', 'src', 'scripts', 'docs') | ForEach-Object {
  $file = Join-Path $root $_
  if (-not (Test-Path -LiteralPath $file)) { throw "Missing package input: $file" }
  $file
}
New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($output)) | Out-Null
Compress-Archive -LiteralPath $files -DestinationPath $output -CompressionLevel Optimal
Write-Host "Created $output"
