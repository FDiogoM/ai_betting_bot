# Betting Analyst

A football betting analyst that writes down what it thinks *before* the match, and then scores
itself against a deterministic baseline. The point is not to produce picks. The point is to find
out, with evidence, whether the judgment layered on top of the arithmetic is worth anything — and
to make it impossible to pretend otherwise afterwards.

Two market families are covered today: **total corners** and **total goals**.

## How it works

The system deliberately splits into two halves that cannot be confused for one another.

**The arithmetic** lives in an MCP server (`mcp-server/`). It fetches data from API-Football,
blends each team's rate with the opponent's, fits a Poisson, prices every standard line, strips the
bookmaker margin off the market's own odds, and computes edge and expected value. It is pure and
deterministic: it has no opinion about whether a price is worth taking, and it says so.

**The judgment** is the agent's, following `.claude/skills/daily-bulletin/SKILL.md`. It reads the
baseline, disagrees with it or doesn't, and states its own probability as a number. If it differs
from the baseline by more than 0.03 it must give a concrete reason naming something real — a venue
sample, a dispersion ratio, a head-to-head. `record_prediction` refuses the write without one.

**The ledger** (`ledger/*.jsonl`) is append-only and git-tracked. Every prediction stores the
baseline's probability beside the agent's, so the two are scored over exactly the same settled
matches — Brier, log loss, calibration by band. Below 30 settled predictions in a family the
verdict is `insufficient` rather than a number that looks meaningful. If the baseline is winning,
the bulletin has to say so at the top.

The git history is what attests that each prediction was written before its match, not after.

## Setup

From the repository root, on a machine with nothing installed:

```bash
sh scripts/setup.sh
```

On Windows:

```bash
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

The script checks for Node 18+, installs dependencies, creates `.env` from `.env.example`, and runs
the test suite. It is safe to re-run and never overwrites an existing `.env` or touches the ledger.

Then put an [API-Football](https://dashboard.api-football.com) key in `.env`:

```
API_FOOTBALL_KEY=your-key-here
```

Restart Claude Code in this folder and approve the `football-stats` server when prompted.
`.mcp.json` registers it; every path in it is relative, so no per-machine editing is needed. A key
already exported in the environment also works and takes precedence over `.env`. Everything else —
ledger location, cache location, timeouts — defaults correctly on any machine; see `.env.example`.

## Layout

```
.mcp.json                 registers the MCP server with Claude Code
.env                      your API key (gitignored; template in .env.example)
config/bulletin.json      the watchlist and the run's thresholds
ledger/YYYY-MM.jsonl      the record: predictions and settlements, append-only
bulletin/                 the published HTML rendering (gitignored — the ledger is the record)
mcp-server/               the arithmetic; see mcp-server/README.md for the tool catalog
scripts/                  one-command setup
docs/superpowers/
  specs/                  system design — read betting-analyst-system-design.md first
  plans/                  historical execution records; paths in them predate the 2026-08-18 move
.claude/skills/           the daily-bulletin procedure
```

## The daily run

A Claude Desktop scheduled task fires `daily-bulletin` every morning. In order, it grades whatever
has played, reads the record, sweeps the watchlist for fixtures, computes both baselines, reads the
market, judges, filters on `minEdge`, records, publishes an HTML bulletin to a stable URL, and
commits the ledger.

Pass `dry-run` to execute every step without recording predictions and without publishing. Use it
whenever changing the procedure — a test prediction in the ledger contaminates the measurement the
system exists to produce.

See `docs/superpowers/plans/notes/scheduling.md` for how the schedule is registered and its two
real limitations: the desktop app must be open, and a first unattended run can stall on a tool
permission prompt.

## Configuration

Everything tunable is in `config/bulletin.json` and takes effect on the next run:

| Key | What it does |
|---|---|
| `leagues` | The watchlist. Empty means the run stops rather than guessing. |
| `windowHours` | How far ahead to look for fixtures. |
| `matchCount` | Recent matches per team behind each baseline. |
| `lines` | Market lines to price, per family. |
| `minEdge` | Minimum edge to keep a selection. |
| `maxPicks` | Ceiling on selections per bulletin. Zero picks is a valid bulletin. |
| `stakeFraction` | What one unit of stake means as a fraction of bankroll. |

`runHour` is decorative — the firing time lives in the scheduled task's cron expression.

## Tests

```bash
cd mcp-server && npm test
```

179 tests, no network: provider responses are stubbed with `nock`, so the suite needs no API key
and spends no quota. GitHub Actions runs it on every push, on Node 18 and 22. `npm run smoke` runs
a single live probe against the real API and does need a key.

## What this is not

It is not a tipster service and it has no view on whether you should bet at all. The baseline
declares its own simplifications in a `caveats` array on every response — no league normalisation,
no recency decay, a venue sample that silently falls back when it is too thin — and those caveats
are stored in the ledger with each prediction rather than dropped. The recorded P&L is theoretical:
it assumes the best quoted price was actually available and taken.

Betting is a negative-sum game against a margin. This system is built to measure whether it is
beating that margin, and to be honest when it isn't.
