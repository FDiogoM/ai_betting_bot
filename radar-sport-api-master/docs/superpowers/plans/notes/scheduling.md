# Daily Bulletin Scheduling — Status

**Date:** 2026-08-17
**Status:** Watchlist set. Scheduled and live — a Claude Desktop scheduled task fires daily at
09:05 local time. See *The mechanism actually used*.

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

## The mechanism actually used

**Claude Desktop scheduled tasks.** Registered 2026-08-17 as task `daily-bulletin`, cron
`0 9 * * *` (the app applies its own offset and reports the schedule as 09:05 local time). The
task prompt lives at `C:\Users\diogo\.claude\scheduled-tasks\daily-bulletin\SKILL.md` and is
self-contained — each run starts with no memory of the session that created it — but it defers to
`.claude/skills/daily-bulletin/SKILL.md` in this repository as the source of truth for the
procedure itself.

This mechanism was not considered in the original evaluation below. It is the right one because it
runs **locally, inside the desktop app**, so it reaches the stdio MCP server, the `.env`, the real
`ledger/` directory and the local git checkout — everything a cloud routine cannot.

Its limitation: it runs only while the app is open. A task due while the app is closed runs at the
next launch. The owner keeps this machine on, which reduces but does not remove the exposure — the
app itself must also be running.

The server is registered twice, and both registrations matter: `.mcp.json` at the repository root
covers Claude Code opened on this folder, and the `mcpServers` block in
`%APPDATA%\Claude\claude_desktop_config.json` (absolute paths, no secrets — the key is read from
`.env` by the server itself) covers the app-level sessions a scheduled task runs in.

## Why the other mechanisms were rejected

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

3. **Windows Task Scheduler invoking the `claude` CLI headlessly.** This was the recommendation in
   the original version of this note. It is now ruled out on a checked fact rather than an open
   question: **the `claude` CLI is not installed on this machine.** Verified 2026-08-17 — absent
   from `PATH`, from `%APPDATA%\npm`, and from `%USERPROFILE%\.local\bin`. The owner uses the
   desktop app only. This path would require installing the CLI first, and the desktop scheduled
   task above makes that unnecessary.

## What changed the owner's earlier deferral

The original note recorded a deliberate decision to run `daily-bulletin` manually — including
`dry-run` — several times before automating, given that a run writes permanent predictions, spends
quota and sends notifications. That decision was superseded on 2026-08-17: one full (non-dry) run
was executed and reviewed, and the owner then asked for the schedule directly. The caution behind
the original decision still applies to whoever reviews the output: the first automated runs deserve
watching.

## How to change it

Edit `config/bulletin.json`. `leagues`, `windowHours`, `minEdge`, `maxPicks`, `stakeFraction`,
`matchCount` and `lines` all take effect on the next run — no code change needed.

**`runHour` is now decorative.** The firing time lives in the scheduled task's cron expression, not
in the config. Changing `runHour` alone changes nothing; use `update_scheduled_task` (or the
Scheduled section of the app's sidebar) and keep `runHour` in step by hand so the two do not
contradict each other.

To change what the run *does*, edit `.claude/skills/daily-bulletin/SKILL.md` — the task prompt
defers to it deliberately, so the procedure stays version-controlled in this repository rather than
frozen in a copy under `~/.claude/scheduled-tasks/`.

## Known limitations

1. **The app must be open.** True of this mechanism specifically: a task due while Claude Desktop
   is closed runs at next launch, not at the scheduled minute. Keeping the machine on is not
   sufficient on its own.
2. **A missed day costs a day of picks, never the record.** True regardless of mechanism.
   `grade_pending_predictions` is idempotent and settles everything outstanding on the next run,
   so nothing is corrupted or duplicated by a skipped morning.
3. **Tool approvals.** Approvals granted during a run are stored on the task and reapplied to later
   runs. A first run that pauses on a permission prompt while nobody is watching simply waits, so
   it is worth triggering one run manually to pre-approve what the task needs.

## Disabling

Disable or delete the `daily-bulletin` task from the Scheduled section of the app's sidebar, or with
`delete_scheduled_task`. The config, the skill and the ledger are untouched either way — stopping
the schedule stops new predictions being written, and nothing already recorded changes.
