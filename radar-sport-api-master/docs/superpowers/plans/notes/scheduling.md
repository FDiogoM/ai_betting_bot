# Daily Bulletin Scheduling — Status

**Date:** 2026-08-17
**Status:** Watchlist set. Live scheduling deliberately deferred at the owner's request.

## What's done

`config/bulletin.json`'s `leagues` array is populated with ten competitions, resolved to their
real API-Football IDs and current season via a live `/leagues` search (verified against a real
API key, not guessed):

| League | ID | Season |
|---|---|---|
| Primeira Liga (Portugal) | 94 | 2026 |
| Premier League (England) | 39 | 2026 |
| La Liga (Spain) | 140 | 2026 |
| Serie A (Italy) | 135 | 2026 |
| Serie A (Brazil) | 71 | 2026 |
| Bundesliga (Germany) | 78 | 2026 |
| Pro League (Saudi Arabia) | 307 | 2026 |
| UEFA Champions League | 2 | 2026 |
| UEFA Europa League | 3 | 2026 |
| UEFA Europa Conference League | 848 | 2026 |

`runHour` is `9` (09:00, machine-local time — not yet mapped to a specific timezone since no
schedule is registered).

## Why no schedule is registered yet

Two mechanisms were evaluated and both are wrong for this system:

1. **The `schedule` skill (cloud routines).** Its own instructions state routines run in an
   isolated cloud sandbox and "cannot access local files, local services, or local environment
   variables." This server is a local stdio process (`node server.js`), not a URL-reachable MCP
   endpoint — there is no `mcp_connections` entry that could reach it. The ledger is local disk;
   a routine's git checkout is a disconnected cloud clone. Using this mechanism would produce
   exactly the failure mode the plan warns against: a schedule that fires and fails silently
   every morning.
2. **`CronCreate`.** Session-only — the job is deleted when the Claude session that created it
   ends, and auto-expires after 7 days regardless. Not a standing daily job.

The correct mechanism is **native OS scheduling** (Windows Task Scheduler) invoking Claude Code
headlessly on the owner's own machine, where `.mcp.json`, the stdio server, and the real
`ledger/` directory already live.

**This was not set up**, for two reasons surfaced when asked directly:

- It is not yet confirmed whether the `claude` CLI is invokable headlessly from this machine
  (the owner primarily uses Claude Desktop, not a terminal).
- The owner explicitly chose to run `daily-bulletin dry-run` manually a few times first, before
  anything runs autonomously and unsupervised — a reasonable choice given the run writes real
  predictions to a permanent ledger, spends API-Football quota, and sends notifications.

## How to change it

Edit `config/bulletin.json`. `leagues`, `windowHours`, `minEdge`, `maxPicks`, `stakeFraction`,
`matchCount`, `runHour` and `lines` all take effect on the next run — no code change needed.

## Next steps, when ready to automate

1. Run the `daily-bulletin` skill manually (with and without `dry-run`) enough times to trust its
   output.
2. Confirm `claude` (or another local, non-interactive invocation path) actually runs from this
   machine outside an interactive session.
3. Register a Windows Task Scheduler entry that runs at `runHour` local time, working directory
   set to the repository root (so `.mcp.json` resolves), invoking the `daily-bulletin` skill.
4. Schedule one near-term test fire, confirm the bulletin publishes and the notification arrives,
   before trusting the daily cadence.
5. **Known limitation, true regardless of mechanism:** a machine that is off or asleep at
   `runHour` misses that day's bulletin entirely. This is not silently swept under the rug —
   `grade_pending_predictions` is idempotent and catches up whatever was missed on the next run,
   so a missed day costs a day of picks, never a corrupted or duplicated ledger.

## Disabling

Not applicable yet — no schedule is registered. Once one exists, disabling it means removing (or
disabling) the Task Scheduler entry; the config and ledger are untouched either way.
