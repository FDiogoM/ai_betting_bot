# Football Stats MCP Server

An MCP server providing deterministic corner baselines, prediction recording, and ledger analysis for football betting analysis.

## Registered Tools

### Reference Tools (Task 2)
- `get_api_status` — Reports the API plan, requests used today, and remaining requests.
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

### Corner Baseline Tools (Tasks 10–11)
- `get_corner_baseline` — Deterministic corner baseline for one upcoming fixture using Poisson model.
- `get_market_probabilities` — Market's implied corner probabilities with bookmaker margin removed.
- `evaluate_bet` — Pure arithmetic on a probability and a price: implied probability, edge, and expected value.

### Ledger Tools (Task 12)
- `record_prediction` — Writes one prediction to the append-only ledger before kickoff.
- `grade_pending_predictions` — Grades every prediction whose match has finished (idempotent).
- `get_ledger_summary` — Scores the agent's probabilities against the baseline's: Brier, calibration, and P&L.

## Configuration

The daily bulletin procedure is configured via `config/bulletin.json` at the repository root. This file specifies:
- `leagues` — The league watchlist (empty by default; fill with `{"id": <leagueId>, "season": <year>, "name": "<label>"}` entries).
- `windowHours` — Number of hours ahead to look for fixtures.
- `minEdge` — Minimum edge threshold for a selection to be included in the bulletin.
- `maxPicks` — Maximum number of picks per bulletin.
- `stakeFraction` — Stake as a fraction of the configured bankroll.
- `matchCount` — Number of recent finished matches per team for corner profile analysis.
- `runHour` — Hour of day (UTC) to run the bulletin procedure.
- `lines` — Market lines (half-integers) to price in baselines.

## Ledger

Predictions and settlement records are stored in `ledger/` at the repository root. This directory is git-tracked (not gitignored) because the ledger is the permanent record of the system. The ledger uses monthly JSONL files (e.g., `2026-08.jsonl`) and is append-only — no line is ever rewritten.

The ledger directory path can be overridden with the `MCP_LEDGER_DIR` environment variable; if unset, it defaults to `../ledger` relative to the server's ledger module.

## Daily Bulletin Procedure

Use the `.claude/skills/daily-bulletin/SKILL.md` skill to produce the daily bulletin. This skill:
1. Grades yesterday's predictions.
2. Computes corner baselines for upcoming fixtures.
3. Records judgments against baselines.
4. Publishes the bulletin as an HTML artifact.
5. Commits the ledger to git for an immutable record.

Run with `dry-run` argument to validate changes without writing predictions or publishing.

## System Design Spec

See `docs/superpowers/specs/2026-08-17-betting-analyst-system-design.md` for the full system design and requirements.

## Legacy Library

The nested `radar-sport-api-master/` library (at `../../index.js` relative to this server) is non-functional — every Sportradar S5 endpoint it calls returns 403 Access Denied. This server replaces it with the API-Football provider and does not import from the legacy library.
