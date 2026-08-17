# One-command setup for Windows. Safe to re-run: it never overwrites an
# existing .env and never touches the ledger.
#
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1

$ErrorActionPreference = 'Stop'

$root      = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $root 'radar-sport-api-master\mcp-server'
$envFile   = Join-Path $root '.env'
$template  = Join-Path $root '.env.example'

function Say([string]$text)  { Write-Host $text }
function Ok([string]$text)   { Write-Host "  OK    $text" -ForegroundColor Green }
function Warn([string]$text) { Write-Host "  TODO  $text" -ForegroundColor Yellow }
function Die([string]$text)  { Write-Host "  FAIL  $text" -ForegroundColor Red; exit 1 }

Say ''
Say 'football-stats MCP server - setup'
Say '---------------------------------'

# 1. Node
Say ''
Say '[1/4] Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Say '  Node.js is not on PATH. Install it, then open a NEW terminal and re-run:'
  Say ''
  Say '      winget install OpenJS.NodeJS.LTS'
  Say ''
  Die 'Node.js missing.'
}
$version = (& node -v).TrimStart('v')
$major   = [int]($version.Split('.')[0])
if ($major -lt 18) { Die "Node $version is too old; this server needs 18 or newer." }
Ok "node $version"

# 2. Dependencies
Say ''
Say '[2/4] Dependencies'
Push-Location $serverDir
try {
  & npm install --no-audit --no-fund | Out-Null
  if ($LASTEXITCODE -ne 0) { Die 'npm install failed.' }
} finally {
  Pop-Location
}
Ok 'npm install'

# 3. The key
Say ''
Say '[3/4] API key'
if (-not (Test-Path $envFile)) {
  Copy-Item $template $envFile
  Ok 'created .env from .env.example'
}
$keyLine = Select-String -Path $envFile -Pattern '^\s*API_FOOTBALL_KEY\s*=\s*(\S.*)$' -ErrorAction SilentlyContinue
$hasKey  = $null -ne $keyLine
if (-not $hasKey -and $env:API_FOOTBALL_KEY) {
  Ok 'API_FOOTBALL_KEY found in the environment'
  $hasKey = $true
}
if ($hasKey) {
  Ok 'API_FOOTBALL_KEY is set'
} else {
  Warn "open .env and set API_FOOTBALL_KEY (get one at https://dashboard.api-football.com)"
}

# 4. Tests - offline, no key needed
Say ''
Say '[4/4] Tests'
Push-Location $serverDir
try {
  # No 2>&1 here: in Windows PowerShell that turns npm's stderr into
  # NativeCommandError records and fails a run that actually succeeded.
  # Output is held back rather than streamed - 157 passing lines bury the one
  # line that matters. A failure prints the tail, where the reason is.
  $output = & npm test
  if ($LASTEXITCODE -ne 0) {
    $output | Select-Object -Last 40 | ForEach-Object { Write-Host "  $_" }
    Die 'tests failed - do not register the server until this is green.'
  }
  $summary = $output | Where-Object { $_ -match '(tests|pass|fail)\s+\d+\s*$' }
  foreach ($line in $summary) { Say "        $($line.Trim())" }
} finally {
  Pop-Location
}
Ok 'test suite passed'

Say ''
Say 'Done. Restart Claude Code in this folder and approve the'
Say '"football-stats" server when it asks. If you use the CLI rather than'
Say 'the desktop app, "claude mcp list" confirms it.'
if (-not $hasKey) {
  Say ''
  Warn 'The server will start but every tool call fails until the key is set.'
}
Say ''
