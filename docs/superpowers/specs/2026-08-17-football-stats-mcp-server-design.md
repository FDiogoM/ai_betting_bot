# Football Stats MCP Server — Design (v2)

**Date:** 2026-08-17
**Status:** Awaiting review
**Supersedes:** `2026-08-17-radar-sport-mcp-server-design.md`

## Why this replaces v1

The v1 design was built on this repository's `radar-sport-api` library, which calls Sportradar's internal S5 widget endpoints. Those endpoints now return `403 Access Denied` — verified on 2026-08-17 across every host, path, and betting house tested:

```
403  bet365 stats_season_meta   <HTML><HEAD><TITLE>Access Denied</TITLE>...
403  betano stats_season_meta   <HTML><HEAD><TITLE>Access Denied</TITLE>...
403  bet365 config_tree_mini    <HTML><HEAD><TITLE>Access Denied</TITLE>...
403  s5 host root               <HTML><HEAD><TITLE>Access Denied</TITLE>...
```

The library dates from 2020; the endpoints have since been placed behind an edge access control. The only way to make those requests succeed would be to impersonate an authorized embedded widget (spoofed `User-Agent` plus `Referer`/`Origin` matching a bookmaker's site). **That is out of scope and will not be built** — it circumvents an access control on a third-party service we have no authorization to use.

The existing library is therefore not a viable data source. This design keeps v1's architecture, which was never coupled to the data source, and replaces the fetch layer with a licensed API.

**v1 artifacts that carry over unchanged:** the `register(server)` tool-module pattern, the result-shaping helpers, stdio transport, and nock-based unit testing. **v1 artifacts that are dropped:** the entire Phase 0 endpoint-discovery probe (unnecessary against a documented API), the betting-house enum, and the region/timezone parameter.

## Goal

An MCP server exposing football statistics — league, team, match, and player level, including **corner statistics** and **odds** — so an agent can retrieve them and reason over them for betting analysis.

## Non-goals

- **No bet placement.** Retrieval only. No bookmaker authentication, no wagering, no movement of money.
- **No access-control circumvention.** No scraping, no header spoofing, no impersonation of a browser or embedded widget. Data comes from an API we are licensed to call, under its terms.
- **No statistical modelling.** The server returns data. Prediction and judgment belong to the agent (and to the later analysis skill).

## Data source

**API-Football** (`api-sports.io`), REST v3.

- **Host:** `v3.football.api-sports.io`
- **Auth:** `x-apisports-key` request header. Key supplied via the `API_FOOTBALL_KEY` environment variable; never committed, never logged.
- **Free tier:** 100 requests/day, all endpoints, limited historical seasons.

**Selection rationale.** football-data.org gates corner statistics behind a €15/mo Statistic Add-On which — per their pricing page, *"Add-Ons can only be booked on top of a regular subscription plan"* — is unavailable on the free tier, putting corners at roughly €27/mo minimum. API-Football's free tier reportedly carries all endpoints with no per-feature add-ons.

**Unverified.** API-Football's site returns 403 to automated fetches, so its free-tier feature set and the exact response shape of `fixtures/statistics` could not be confirmed from primary sources. Task 1 of the implementation plan verifies both with two live calls before anything is built on them. If corners prove gated, the fallback is football-data.org at ~€27/mo; only `provider/apiFootball.js` changes.

## The quota constraint drives the architecture

100 requests/day is a hard architectural constraint, not a footnote.

A single question — "how do both teams in Saturday's match perform on corners?" — decomposes into roughly 22 requests without caching: two teams × ten recent fixtures × one statistics call each, plus fixture lookups. That is a quarter of the daily free budget for one match.

**Therefore caching is a first-class component,** not an optimization. Two properties make it effective:

1. **Finished-match data is immutable.** A completed fixture's statistics never change, so they can be cached permanently. Corner analysis is almost entirely reads of finished matches — exactly the workload caching serves best.
2. **The expensive access pattern is repetitive.** Analyzing several matches in one league re-reads the same teams' recent fixtures.

With a warm cache, the second question about the same team costs zero requests.

### Cache design

- **Storage:** JSON files on disk under `mcp-server/.cache/`, one file per entry, git-ignored. No database; the working set is small and a restart should not discard it.
- **Key:** SHA-256 of the endpoint path plus sorted query parameters.
- **TTL by data class:**

| Data | TTL | Why |
|---|---|---|
| Finished-fixture statistics, lineups, events | permanent | Immutable once played |
| Finished-fixture details | permanent | Immutable |
| Scheduled/live fixtures | 5 minutes | Changes as matches progress |
| Standings, team season statistics | 6 hours | Changes only on matchdays |
| Leagues, teams, squads | 7 days | Near-static reference data |
| Odds | 15 minutes | Moves continuously pre-match |
| Account status | never cached | Must reflect live quota |

- **Cache-first, network-second.** Every read checks the cache before issuing a request.
- **`force_refresh`** is available per tool to bypass a cached entry deliberately.

### Quota management

- Every response's remaining-quota headers are recorded to `mcp-server/.cache/quota.json`.
- A `get_api_status` tool reports plan, requests used, and requests remaining, so an agent can check its budget before an expensive aggregation.
- The aggregating tool **estimates its cost before running** and refuses to exceed a configurable per-call ceiling (default 25 requests), reporting what it would have cost instead of silently burning the day's quota.
- HTTP 429 is surfaced as a distinct, clearly-worded tool error naming quota exhaustion — never a generic failure.

## Architecture

Layout as built. The server was originally nested inside the vendored
`radar-sport-api-master/` library, which was deleted on 2026-08-18 once it was confirmed nothing
imported from it; the tree below reflects the current, flattened layout.

```
  mcp-server/
    package.json
    server.js                 # registers tools, connects stdio transport
    http.js                   # axios instance: base URL, auth header, timeout, error normalization
    cache.js                  # disk cache: get/set, TTL policy, key hashing
    quota.js                  # quota tracking and the per-call request ceiling
    provider/
      apiFootball.js          # the ONLY module that knows API-Football's endpoints and shapes
    tools/
      reference.js            # search_leagues, search_teams, get_api_status
      fixtures.js             # fixtures, head-to-head, standings
      stats.js                # match statistics, team season stats, corner aggregation
      players.js              # squads, player statistics
      odds.js                 # pre-match odds
    test/*.test.js
    README.md
```

- **Plain CommonJS**, Node >= 18, no build step. Matches the repo.
- **stdio transport**, registered with Claude Code via `.mcp.json`. Not network-exposed.
- **Provider isolation.** Endpoint paths, parameter names, and response unwrapping live only in `provider/apiFootball.js`. Tools speak in domain terms (league, team, fixture, corners). Swapping providers touches one file. This is a boundary the requirements already justify, given corner availability is unconfirmed — not speculative abstraction.

## Tool catalog

Every tool accepts an optional `force_refresh` boolean. Endpoint paths below are **provisional pending Task 1 verification** — the docs could not be fetched.

### Reference & discovery

| Tool | Endpoint | Purpose |
|---|---|---|
| `get_api_status` | `/status` | Plan, requests used, requests remaining. Costs nothing against analysis budget; call before aggregations. |
| `search_leagues` | `/leagues?search=` | Resolve a league name to its ID and available seasons. |
| `search_teams` | `/teams?search=` | Resolve a team name to its ID. |

### Fixtures & tables

| Tool | Endpoint | Purpose |
|---|---|---|
| `get_fixtures` | `/fixtures?league=&season=&from=&to=` | Fixtures in a date range. Entry point for "what's on this weekend". |
| `get_team_fixtures` | `/fixtures?team=&last=` / `&next=` | A team's recent results or upcoming matches — form. |
| `get_fixture` | `/fixtures?id=` | One fixture's detail. |
| `get_head_to_head` | `/fixtures/headtohead?h2h=A-B` | Historical meetings between two teams. |
| `get_standings` | `/standings?league=&season=` | League table. |

### Statistics — the corner-market core

| Tool | Endpoint | Purpose |
|---|---|---|
| `get_fixture_statistics` | `/fixtures/statistics?fixture=` | Per-match statistics: **corner kicks**, cards, shots on/off target, possession, offsides, fouls. |
| `get_team_season_statistics` | `/teams/statistics?league=&season=&team=` | Aggregate season form in one request — cheap, and often enough on its own. |
| `get_team_corner_profile` | *aggregate* | **The headline tool.** Given a team and a match count, fetches recent fixtures and each one's statistics, returning a consolidated per-match breakdown of corners for and against, with totals and averages. |

`get_team_corner_profile` exists because corner analysis is inherently multi-request and an agent orchestrating it by hand would spend the entire daily quota on one question. It is bounded by an explicit `matchCount` (default 10, hard cap 20), refuses to exceed the per-call request ceiling, runs at a concurrency of 3, and reports partial failures per match rather than discarding everything. Cached finished-match statistics make repeat calls nearly free.

### Players & odds

| Tool | Endpoint | Purpose |
|---|---|---|
| `get_squad` | `/players/squads?team=` | Squad with player IDs. |
| `get_player_statistics` | `/players?id=&season=` | Season statistics for one player — player-prop markets. |
| `get_odds` | `/odds?fixture=` | Pre-match odds by bookmaker and market. |

Odds matter beyond convenience: with both odds and statistics from one provider, an agent can compare an implied probability against observed form — the thing v1 could not do at all.

## Error handling

- **Input validated** with zod before any request. Unknown league/team IDs fail fast.
- **Timeouts** on every request: 10s default, `MCP_HTTP_TIMEOUT_MS` overrides.
- **No tool throws.** Every failure returns an MCP error result (`isError: true`); a failing call never crashes the server.
- **Distinct, actionable messages** for the failure modes that differ in what the user should do: missing/invalid API key (401/403), quota exhausted (429), upstream unavailable (5xx), and unknown identifier (empty result).
- **Empty is not an error.** API-Football returns `200` with an empty `response` array for valid-but-unmatched queries. That is reported as an explicit empty result so an agent can distinguish "no corner data for this fixture" from "the request failed".
- **Partial aggregation failure** returns the fixtures that succeeded plus an explicit list of those that did not.
- **The API key is never echoed** into an error message, log line, or cache file.

## Testing

1. **Unit tests, nock-mocked** — the primary layer, no key and no network required. Per tool: correct endpoint and parameters, auth header present, cache hit avoids a second request, TTL expiry triggers a refetch, 401/429/5xx map to their distinct messages, aggregation handles partial failure and refuses to exceed its ceiling.
2. **Live smoke test** — a manually-run script needing a real key, not part of `npm test`. Confirms the endpoint shapes actually match the provider module. Deliberately small: a handful of requests, mindful of the 100/day budget.
3. **End-to-end** — verified through a real Claude Code MCP registration, not just unit tests.

## Implementation sequencing

Fourteen tools plus caching, quota, and HTTP layers is more than one plan should carry. Two plans, each ending in a working server:

- **Plan 1 — foundation and corners.** Provider verification, `http.js`, `cache.js`, `quota.js`, `provider/apiFootball.js`, plus the reference, fixtures, and statistics tools including `get_team_corner_profile`. This delivers the capability that motivated the project.
- **Plan 2 — players and odds.** `players.js` and `odds.js` on top of the finished foundation, where the remaining work is tool definitions rather than new infrastructure.

## Disposition of the existing library

`index.js` and `test.js` are now dead code: every endpoint they target returns 403, and `test.js` crashes on an unhandled rejection as shipped. This design does not delete them — that is a separate decision for the repo owner. The MCP server does not depend on them, and the README should state that the legacy library is non-functional so nobody rediscovers the 403 the hard way.

## Risks

| Risk | Mitigation |
|---|---|
| API-Football's free tier gates corners or odds | Task 1 verifies before anything is built on it; fallback is football-data.org at ~€27/mo, changing one module |
| 100 req/day proves too tight in practice | Caching (permanent for finished matches), per-call ceiling, `get_api_status`; if still tight, Pro tier is $19/mo |
| Provisional endpoint paths are wrong | Task 1 confirms against live responses; all of them live in one module |
| Cache serves stale pre-match data | Short TTLs for live/scheduled/odds; `force_refresh` on every tool |
| API key leaks into logs or cache files | Explicit non-goal; header never serialized, covered by a unit test |

## Open questions

1. **Does the free tier return corner statistics?** Resolved by Task 1, before dependent work. If not, the choice between paying ~€19-27/mo and dropping corner markets is the repo owner's.
2. **An API key is required for live verification.** It cannot be self-obtained — the account must be created by the repo owner and the key supplied via `API_FOOTBALL_KEY`. All unit-tested work proceeds without it.
