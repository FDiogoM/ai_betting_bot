# Football Stats MCP Server

An MCP server providing deterministic corner baselines, prediction recording, and ledger analysis for football betting analysis.

## Setup

From the repository root, on a machine with nothing installed:

```
# Windows
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1

# macOS / Linux
sh scripts/setup.sh
```

The script checks for Node 18+, installs dependencies, creates `.env` from `.env.example`, and runs the test suite. It is safe to re-run and never overwrites an existing `.env`. Then put your API-Football key in `.env`:

```
API_FOOTBALL_KEY=your-key-here
```

Restart Claude Code in this folder and approve the `football-stats` server when prompted. `.mcp.json` at the repository root is what registers it; no per-machine editing of that file is needed, because every path in it is relative and the only variable it passes through is the key.

A key already exported in the environment also works and takes precedence over `.env`. Everything else — ledger location, cache location, timeouts — defaults correctly on any machine; see `.env.example` for the overrides.

## Registered Tools

### Reference Tools (Task 2)
- `get_api_status` — Reports the API plan, requests used today, and remaining requests, plus `server`: version, uptime, and whether this process is running code older than the repository. An MCP server over stdio loads its code once and never notices the disk moving on, so `server.stale` is the only way to tell from the outside. It is computed before the network call and survives a provider outage, because a warning that disappears when the API does is missing when it is most needed.
- `search_leagues` — Finds leagues by name and returns their IDs and available seasons.
- `search_teams` — Finds teams by name and returns their IDs.

### Fixture Tools (Task 6)
- `get_fixtures` — Lists a league's fixtures between two dates.
- `get_team_fixtures` — Returns a team's last N results or next N scheduled matches.
- `get_fixture` — Full detail for a single fixture ID, including status, teams, and score.
- `get_head_to_head` — Historical meetings between two teams, most recent first.
- `get_standings` — Current standings (league table) for a league and season.

### Statistics Tools (Task 8)
- `get_fixture_statistics` — Per-team statistics for one fixture (corners, cards, shots, possession).
- `get_team_season_statistics` — Aggregate season form for one team in one league.
- `get_team_corner_profile` — Corner analysis across a team's recent finished matches.

### Odds Tools (Task 9)
- `get_odds` — Pre-match odds for one fixture, by bookmaker and market.

### Baseline Tools (Tasks 10–11)
- `get_corner_baseline` — Deterministic corner baseline for one upcoming fixture using Poisson model.
- `get_goals_baseline` — The same for total goals, but the rate is estimated from shots on target × a pooled conversion rather than from goals scored: goals are the noisy outcome, shots the repeatable process. Check `signal` (`"shots"`, or `"goals"` when coverage was too thin to use them) and `comparison`, which carries what the goals-based model would have said. The empirical rate and dispersion are always computed from real goals, so they stay an independent check. Costs one request per match per team, usually already paid by the corner profile over the same matches.
- `get_market_probabilities` — Market's implied probabilities for one family (`corners` or `goals`), with the bookmaker margin removed. Reads the full-match total only.
- `evaluate_bet` — Pure arithmetic on a probability and a price: implied probability, edge, and expected value.
- `suggest_stake` — Sizes a bet: fractional Kelly capped at one unit, scaled down by what the baseline says about its own inputs (sample size, dispersion, model-versus-sample agreement, venue fallbacks, season boundaries, one-sided quotes). Derives the baseline itself. Returns every penalty and why, and 0 when the price does not cover the probability. Exists because stake size drives P&L and was the one lever nothing measured.

## Market Families

A family is declared once, in `markets/index.js`: its odds market name, where its observed total comes from at settlement, and which lines are standard. Everything downstream reads that declaration — the ledger schema builds one union variant per family, the odds parser takes the family as an argument, and settlement dispatches on it.

| Family | Count source | Cost per baseline | Odds market name |
|---|---|---|---|
| `corners` | `fixtures/statistics` → Corner Kicks | ~1 request per match per team | `Corners Over Under` |
| `goals` | shots on target × pooled conversion; goals for the empirical check | ~1 request per match per team, usually already paid by corners | `Goals Over/Under` |

Both market names were read off a real API response, not assumed, and both patterns are anchored: the same response carries `Goals Over/Under First Half`, `Goal Line`, `Home Corners Over/Under` and a dozen other near-misses that are different bets.

Adding a totals family is a registry entry plus its count source. A family with a different shape — 1X2 has three selections and no line — additionally needs a second variant in the schema union and its own settlement rule.

Scores are only comparable **within** a family, and each needs its own 30 settled predictions before `get_ledger_summary` returns a verdict rather than `insufficient`. Pass `market` to score one family.

### Ledger Tools (Task 12)
- `record_prediction` — Writes one prediction to the append-only ledger before kickoff. You pass the fixture, the selection and your own judgment; the baseline, market view, edge and expected value are DERIVED here rather than copied from what you read, so nothing in the record depends on a transcription. The result echoes back what was written.
- `grade_pending_predictions` — Grades every prediction whose match has finished (idempotent).
- `get_ledger_summary` — Scores the agent against the baseline AND against the de-vigged market consensus, which is the harder benchmark: Brier, log loss, calibration by band, P&L. Also reports `judgment`, which measures how far the agent actually moves from the baseline — if the typical prediction just restates it, the comparison is measuring nothing and this says so — and `blend.weight`, the model weight that would have scored best in hindsight, fitted in sample and deliberately not applied.

## Configuration

Secrets and per-machine overrides live in `.env` at the repository root (gitignored; template in `.env.example`). Everything the strategy needs to be reviewable lives in `config/bulletin.json`, which is committed.

The daily bulletin procedure is configured via `config/bulletin.json` at the repository root. This file specifies:
- `leagues` — The league watchlist (empty by default; fill with `{"id": <leagueId>, "season": <year>, "name": "<label>"}` entries).
- `windowHours` — Number of hours ahead to look for fixtures.
- `minEdge` — Minimum edge threshold for a selection to be included in the bulletin.
- `maxPicks` — Maximum number of picks per bulletin.
- `stakeFraction` — Stake as a fraction of the configured bankroll.
- `matchCount` — Number of recent finished matches per team behind each baseline.
- `runHour` — Hour of day (UTC) to run the bulletin procedure.
- `lines` — Market lines (half-integers) to price, keyed by family: `lines.corners` and `lines.goals`.

## Ledger

Predictions and settlement records are stored in `ledger/` at the repository root. This directory is git-tracked (not gitignored) because the ledger is the permanent record of the system. The ledger uses monthly JSONL files (e.g., `2026-08.jsonl`) and is append-only — no line is ever rewritten.

The ledger path resolves to the repository-root `ledger/` on any machine, via `paths.js`. `MCP_LEDGER_DIR` overrides it — the test suite points it at a temp directory — but no installation needs to set it.

## Daily Bulletin Procedure

Use the `.claude/skills/daily-bulletin/SKILL.md` skill to produce the daily bulletin. This skill:
1. Grades yesterday's predictions.
2. Computes corner baselines for upcoming fixtures.
3. Records judgments against baselines.
4. Publishes the bulletin as an HTML artifact.
5. Commits the ledger to git for an immutable record.

Run with `dry-run` argument to validate changes without writing predictions or publishing.

## System Design Spec

See `docs/superpowers/specs/2026-08-17-betting-analyst-system-design.md` (from the repository root) for the full system design and requirements.

## Legacy Library

This server once lived nested inside `radar-sport-api-master/`, a vendored copy of the
`radar-sport-api` library. That library is non-functional — every Sportradar S5 endpoint it calls
returns 403 Access Denied — and nothing here ever imported from it. It was deleted on 2026-08-18
and the server moved to the repository root; the plans under `docs/superpowers/plans/` predate the
move and still show the old paths, which is what they recorded at the time. The library remains
in git history if it is ever wanted.
