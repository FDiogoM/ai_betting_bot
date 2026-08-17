# Radar Sport MCP Server — Design

**Date:** 2026-08-17
**Status:** Approved for implementation planning

## Goal

Expose the data-retrieval capabilities of the `radar-sport-api` library as an
MCP (Model Context Protocol) server, so that an AI agent can fetch sports
statistics — league, team, match, and player level — and reason over them to
support betting analysis, including derivative markets such as corners.

This spec covers the MCP server only. The reasoning/judgment layer (a skill that
tells an agent *how* to analyze the data for betting purposes) is a separate,
later piece of work.

## Non-goals

- **No bet placement.** The server retrieves and returns data. It does not
  submit wagers, authenticate to bookmaker accounts, or move money.
- **No odds.** The underlying library returns statistics only; there is no odds
  endpoint in it. Value-vs-price analysis is out of scope for this build. If
  odds are wanted later, they need a separate source.
- **No new statistical modelling.** The server returns the upstream data,
  normalized and aggregated where useful. Prediction is the agent's job.

## Context: the existing library

`index.js` exports two classes, both thin `axios` wrappers over Sportradar's
internal "S5" widget endpoints (`stats.fn.sportradar.com`, `s5.sir.sportradar.com`):

- **`sportApi(bettingHouse)`** — fixed-purpose methods: `allDefinitions`,
  `modalData`, `localData`, `liague`, `liagueSummary`, `seasonGoals`,
  `leagueFixtures`.
- **`sportData(bettingHouse, configs)`** — generic access: `getInfo(region,
  method, values)` (builds `{house}/{lang}/{region}/{server}/{method}/{values}`
  and returns `data.doc[0]`), plus `getByPath(path)` and `getByUrl(url)`.

URL shape for the generic call:

```
{bettingHouse}/{lang}/{region}/{server}/{method}/{values}
e.g. bet365/en/Europe:Berlin/gismo/stats_season_meta/76415
```

`stats_season_meta` is the only method name documented as working. The README's
`statscoverage` response block advertises far more available data
(`matchdetails`, `lineups`, `formations`, `topgoals`, `topassists`,
`disciplinary`, `redcards`, `yellowcards`, `goalminute`, `substitutions`,
`livescoreeventcornerkick`, `livescoreeventpossesion`, `referee`, …) but the
corresponding method strings are not documented anywhere in the repo.

**Implication:** the exact set of tools this server can offer is not fully
knowable from the code. It must be discovered empirically. This drives the
phased implementation below.

## Architecture

A new `mcp-server/` directory inside this repository.

```
radar-sport-api-master/
  index.js                 # existing library (unchanged)
  mcp-server/
    package.json           # adds @modelcontextprotocol/sdk, zod
    server.js              # tool registration + stdio transport
    client.js              # library wiring, betting-house handling, timeouts
    tools/                 # one module per tool group
      discovery.js
      league.js
      team.js
      match.js
      player.js
      raw.js
    endpoints.md           # findings from the Phase 0 probe
    README.md              # setup + Claude Code registration
```

**Decisions:**

- **Plain CommonJS JavaScript**, matching the existing library's style. No build
  step.
- **Local dependency.** `mcp-server/` `require`s `../index.js` by relative path.
  The library is not published or linked as a package.
- **stdio transport.** The server runs locally and is registered with Claude
  Code via `.mcp.json`. It is not exposed over a network — no HTTP transport, no
  auth layer needed.
- **The existing `index.js` is not modified** as part of this work, except for
  one possible small fix (see Open Question 2).

### Betting house selection

Every tool that queries betting-house data takes a `bettingHouse` parameter,
constrained by schema enum to exactly three values:

```
betano | bet365 | betclic
```

Enum rather than free string, so a typo fails validation instead of producing a
confusing 404 from upstream. Selectable per call rather than fixed at startup,
so an agent can cross-check the same query against a second house when a
response looks wrong or incomplete.

**Note on the library's fixed-purpose methods.** Several `sportApi` methods
hardcode values that this design needs to be caller-controlled:
`liagueSummary` hardcodes the path prefix `common/` instead of using the betting
house at all, and `liague` / `seasonGoals` / `leagueFixtures` hardcode the region
`America:Argentina:Buenos_Aires`. Wrapping those methods directly would make the
`bettingHouse` and `region` parameters silently ineffective.

Therefore **all league/team/match/player tools are implemented over
`sportData.getInfo(region, method, values)`**, which builds the URL from
caller-supplied house, region, and method. The `sportApi` fixed methods are used
only as a reference for which method names and ID types are known to work. The
two `browse_*` discovery tools are the exception — they wrap `modalData` /
`localData`, whose `config_tree_mini` path shape has no `getInfo` equivalent.

### Region and language

The library takes a `region` (timezone) argument that affects returned match
times. Supported values per the README: `Europe:Berlin` (GMT+2) and
`America:Argentina:Buenos_Aires` (GMT-3). Region defaults to `Europe:Berlin`
and is an optional parameter on tools where it applies. Language is fixed to
`en`.

## Implementation phases

### Phase 0 — Endpoint discovery probe (must run first)

Before any tool beyond the known-good set is written, probe the live API using
`getInfo` / `getByPath` to establish which method names actually exist and what
they return.

**Method:** the one confirmed endpoint follows a `stats_<scope>_<thing>`
convention (`stats_season_meta`, and the library's own unused-but-plausible
`stats_season_leaguesummary`, `stats_season_goals`, `stats_season_fixtures2`).
Probe that pattern space across scopes (`season`, `team`, `match`, `player`) and
things suggested by the `statscoverage` flags.

Candidate names to test (non-exhaustive):

| Scope | Candidates |
|---|---|
| Match | `stats_match_details`, `stats_match_get`, `stats_match_situation`, `stats_match_timeline`, `stats_match_lineups`, `stats_match_form` |
| Team | `stats_team_lastx`, `stats_team_nextx`, `stats_team_versusrecent`, `stats_team_squad`, `stats_team_info`, `stats_team_seasons` |
| Season | `stats_season_tables`, `stats_season_topgoals`, `stats_season_topassists`, `stats_season_odds`, `stats_season_overunder`, `stats_season_disciplinary` |
| Player | `stats_player_info`, `stats_player_lastx`, `stats_player_seasons` |

**Output:** `mcp-server/endpoints.md` recording, for each probed name: whether
it responded, the ID type it expects, and a trimmed sample of the response
shape. This document is the input to Phase 2.

**Reporting gate:** the probe results are reported before the full tool set is
built. Tools are written only for endpoints confirmed to return real data. Any
planned capability that the probe cannot reach — including, potentially,
per-match corner statistics — is reported as unavailable rather than shipped as
a tool that returns empty objects.

### Phase 1 — Server skeleton + known-good tools

Stand up the MCP server with the tools that wrap already-written library
methods, and verify end-to-end against a real Claude Code registration before
expanding. Includes the raw escape hatches, which are what make the server
useful even if later phases find less than hoped.

### Phase 2 — Discovered tools

Build the team / match / player tools that Phase 0 confirmed, including the
aggregating history tool.

## Tool catalog

Tools are grouped by confidence:

- **Confirmed** — the method name appears in the existing library, so it is known
  to have worked at some point. Only `stats_season_meta` is documented with a
  sample response; the other three league methods are taken from library code
  that the repo's `test.js` leaves commented out. Phase 0 therefore smoke-tests
  these too, but they are not expected to need discovery.
- **Provisional** — no known method name yet. Depends entirely on Phase 0
  findings; the names and parameters below are intent, not commitment.

### Discovery (confirmed)

| Tool | Wraps | Purpose |
|---|---|---|
| `list_sport_ids` | static table | Returns the README's sport-name → ID map (Futebol 1, Tenis 5, Basquetebol 2, …). No network call. Lets an agent resolve "football" → `1` without guessing. |
| `browse_sport_categories` | `modalData(sportId, 'categories')` | Top-level categories (countries/regions) for a sport. Entry point for name → ID resolution. |
| `browse_local` | `localData(sportId, localId)` | Drills into a category to reveal its leagues/tournaments and their numeric IDs. |

Rationale: no upstream endpoint searches by name. Without these, every other
tool is unusable unless the caller already knows numeric IDs.

### League / season (confirmed)

| Tool | Wraps | Purpose |
|---|---|---|
| `get_league_meta` | `stats_season_meta` | Season identity: name, year, dates, tournament IDs, and the `statscoverage` block (useful for telling the agent what data exists for this league). |
| `get_league_summary` | `stats_season_leaguesummary` | League summary / standings. |
| `get_league_fixtures` | `stats_season_fixtures2` | Scheduled and completed matches for a season. Source of match IDs for match-level tools. |
| `get_season_goals` | `stats_season_goals` | Season scoring stats — feeds over/under and scoring-pattern reasoning. |

### Team (provisional)

| Tool | Purpose |
|---|---|
| `get_team_recent_matches` | A team's last N matches with results — form. |
| `get_team_next_matches` | A team's upcoming fixtures. |
| `get_team_squad` | Squad list with player IDs — the bridge to player-level tools. |
| `get_head_to_head` | Historical meetings between two teams. |
| `get_team_match_stats_history` | **Aggregating tool.** Given a team ID and a match count, fetches recent fixtures *and* each one's match statistics server-side, returning one consolidated result: per-match corners, cards, shots, possession. |

`get_team_match_stats_history` exists because corner and card analysis is
inherently multi-request — a team's corner tendency requires per-match stats
across many fixtures. Left to per-match tools, an agent would need ~30
round-trips for one question. Server-side aggregation makes it one call.
Bounded by an explicit `matchCount` (default 10, capped) so a single call cannot
fan out unboundedly. Requests within the aggregation are issued with limited
concurrency and partial failures are reported per-match rather than failing the
whole call.

### Match (provisional)

| Tool | Purpose |
|---|---|
| `get_match_details` | Full detail for one event ID. |
| `get_match_statistics` | Per-match stats: **corners**, cards, shots on/off target, possession, offsides, fouls. The core corner-market tool. |
| `get_match_lineups` | Lineups and formations. |

### Player (provisional)

| Tool | Purpose |
|---|---|
| `get_season_top_scorers` | Top goals for a season. |
| `get_season_top_assists` | Top assists for a season. |
| `get_player_stats` | Season statistics for one player — player-prop markets. |

### Raw escape hatches (confirmed)

| Tool | Wraps | Purpose |
|---|---|---|
| `get_by_path` | `getByPath` | Any S5 path directly, e.g. `en/Europe:Berlin/gismo/config_tree_mini/41/0/1`. |
| `get_info` | `getInfo(region, method, values)` | Generic call by method name + ID, matching the README's documented pattern. |

These matter disproportionately: they cover whatever the named tools miss, and
they are the mitigation if upstream changes break a specific tool.

## Data flow

Typical agent path for a corner-market question:

```
list_sport_ids                → football = 1
browse_sport_categories(1)    → find country/category ID
browse_local(1, categoryId)   → find league ID
get_league_meta(leagueId)     → confirm season + check statscoverage
get_league_fixtures(leagueId) → find the match, get team IDs + match ID
get_team_match_stats_history(teamId, 10)  → corner history, both teams
get_match_statistics(matchId)             → live/final stats if in progress
```

Escape hatches short-circuit this entirely when the caller already knows the
exact endpoint and ID.

## Error handling

- **Input validation** via zod schemas before any request is issued. Invalid
  betting house, missing ID, or out-of-range `matchCount` fails fast with a clear
  message.
- **Timeouts.** The library's axios instance sets none, so a hung upstream would
  hang a tool call indefinitely. The MCP server's calls use an explicit timeout
  (10s default, configurable by env var).
- **Failures are returned, not thrown.** Network errors, non-2xx responses, and
  unexpected payload shapes are caught and returned as MCP tool errors
  (`isError: true`) with a readable message including the attempted method and
  ID. A failing tool call must never crash the server process.
- **Empty vs. missing.** A 200 response with no usable data is reported
  distinctly from a failed request, so an agent can tell "this league has no
  corner data" from "the request broke".
- **Aggregation partial failure.** `get_team_match_stats_history` returns
  successfully-fetched matches plus an explicit list of the ones that failed,
  rather than discarding everything.

## Testing

Two layers, because the upstream endpoints are third-party and undocumented:

1. **Unit tests with mocked axios** — the primary, deterministic layer. For each
   tool: asserts the correct URL is constructed (house, region, method, ID all in
   the right positions), that schema validation rejects bad input, that upstream
   errors become MCP tool errors, and that the aggregator handles partial
   failure. These pass regardless of whether the endpoints are up.
2. **Live smoke tests** — a manually-run script (not part of the default test
   run, since it depends on a third party being reachable) that calls each tool
   once against real endpoints and reports which respond. Doubles as an
   ongoing "has upstream broken?" check.

Phase 1 is verified end-to-end through an actual Claude Code MCP registration,
not just unit tests — a server that passes tests but fails to handshake is not
working.

## Risks

| Risk | Mitigation |
|---|---|
| Undocumented endpoints change or disappear without notice | Raw escape-hatch tools; live smoke script to detect breakage; `endpoints.md` records what was verified and when |
| Phase 0 finds no corner-level data | Reported explicitly before building dependent tools; league/team-level analysis still delivered |
| Aggregating tool causes heavy upstream request volume | Explicit capped `matchCount`, limited concurrency, per-match failure reporting |
| Response shapes vary by sport / league / betting house | Tools return upstream data without over-normalizing; `statscoverage` from `get_league_meta` tells the agent what to expect |

## Open questions

1. **Which provisional endpoints actually exist.** Resolved by Phase 0. The
   tool catalog above is intent for the team/match/player tiers.
2. **The `Headers` typo in `index.js:7`.** The axios config sets `Headers`
   (capital H); axios reads lowercase `headers`, so no custom headers are
   currently sent. These appear to be public widget-embed endpoints so this may
   be harmless. To be verified during Phase 0 — if upstream turns out to require
   a user-agent or referer, the fix is small and belongs in the MCP server's own
   axios configuration rather than a change to the shared library.
3. **Repository is not currently under git.** The working directory is not a git
   repo, so this spec cannot be committed as the normal workflow expects. Worth
   initializing before implementation so the work is tracked.
