#!/usr/bin/env sh
# One-command setup for macOS/Linux. Safe to re-run: it never overwrites an
# existing .env and never touches the ledger.
#
#   sh scripts/setup.sh

set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
server_dir="$root/radar-sport-api-master/mcp-server"
env_file="$root/.env"
template="$root/.env.example"

ok()   { printf '  OK    %s\n' "$1"; }
warn() { printf '  TODO  %s\n' "$1"; }
die()  { printf '  FAIL  %s\n' "$1"; exit 1; }

printf '\nfootball-stats MCP server - setup\n'
printf -- '---------------------------------\n'

printf '\n[1/4] Node.js\n'
if ! command -v node >/dev/null 2>&1; then
  printf '  Node.js is not on PATH. Install it (https://nodejs.org or your\n'
  printf '  package manager), then re-run this script.\n'
  die 'Node.js missing.'
fi
version=$(node -v | sed 's/^v//')
major=${version%%.*}
[ "$major" -ge 18 ] || die "Node $version is too old; this server needs 18 or newer."
ok "node $version"

printf '\n[2/4] Dependencies\n'
(cd "$server_dir" && npm install --no-audit --no-fund >/dev/null) || die 'npm install failed.'
ok 'npm install'

printf '\n[3/4] API key\n'
if [ ! -f "$env_file" ]; then
  cp "$template" "$env_file"
  ok 'created .env from .env.example'
fi
has_key=no
if grep -Eq '^[[:space:]]*API_FOOTBALL_KEY[[:space:]]*=[[:space:]]*[^[:space:]]' "$env_file"; then
  has_key=yes
elif [ -n "${API_FOOTBALL_KEY:-}" ]; then
  ok 'API_FOOTBALL_KEY found in the environment'
  has_key=yes
fi
if [ "$has_key" = yes ]; then
  ok 'API_FOOTBALL_KEY is set'
else
  warn 'open .env and set API_FOOTBALL_KEY (get one at https://dashboard.api-football.com)'
fi

printf '\n[4/4] Tests\n'
# Held back rather than streamed: 157 passing lines bury the one that matters.
# A failure prints the tail, where the reason is.
log=$(mktemp)
if ! (cd "$server_dir" && npm test) >"$log" 2>&1; then
  tail -n 40 "$log" | sed 's/^/  /'
  rm -f "$log"
  die 'tests failed - do not register the server until this is green.'
fi
grep -E '^[^a-zA-Z0-9]+(tests|pass|fail) [0-9]+$' "$log" | sed 's/^/        /'
rm -f "$log"
ok 'test suite passed'

printf '\nDone. Restart Claude Code in this folder and approve the\n'
printf '"football-stats" server when it asks. Verify with: claude mcp list\n'
if [ "$has_key" != yes ]; then
  printf '\n'
  warn 'The server will start but every tool call fails until the key is set.'
fi
printf '\n'
