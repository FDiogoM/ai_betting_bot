# Radar Sport MCP Server — Phase 0 & 1 Implementation Plan

> **SUPERSEDED — do not execute.** The Sportradar S5 endpoints this plan targets
> return `403 Access Denied`; see `docs/superpowers/specs/2026-08-17-football-stats-mcp-server-design.md`
> for the replacement design and its plan. Retained for the record.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover which Sportradar S5 endpoints are actually reachable, then ship a working MCP server exposing the confirmed league-level, discovery, and raw-access tools over stdio.

**Architecture:** A `mcp-server/` package inside this repo that `require`s the parent `index.js` library by relative path. `client.js` centralizes betting-house/region handling, timeouts, and error normalization; `result.js` centralizes MCP result shaping; one module per tool group under `tools/`; `server.js` registers tools and connects a stdio transport. All stats tools are built over the library's generic `sportData.getInfo`, never the fixed-purpose `sportApi` methods (see Global Constraints for why).

**Tech Stack:** Node.js (CommonJS), `@modelcontextprotocol/sdk` 1.30.x, `zod` 3.25.x, `nock` 14.x (dev), Node's built-in `node --test` runner (no test framework dependency).

**Spec:** `docs/superpowers/specs/2026-08-17-radar-sport-mcp-server-design.md`

## Scope

This plan covers **Phase 0 (endpoint discovery probe)** and **Phase 1 (server skeleton + confirmed tools)** from the spec.

**Phase 2 (team / match / player tools, including corners) is deliberately NOT in this plan.** Those tools depend on endpoint names that Phase 0 discovers. Planning them now would require placeholder tasks. After Task 1 completes and its findings are reported, a second plan gets written from the actual probe results.

On completion of this plan you have a registerable, working MCP server — not a stub.

## Global Constraints

- **Node.js >= 18.** Development and verification target is the installed v26.5.0.
- **CommonJS only.** No `"type": "module"`, no build step, no TypeScript. Matches the existing library. Verified: `@modelcontextprotocol/sdk` 1.30.0 exposes a `require` condition resolving to `dist/cjs/`, so `require()` works.
- **Betting house enum — exactly these three values:** `betano`, `bet365`, `betclic`. Never accept a free-form string.
- **Region enum — exactly these two values:** `Europe:Berlin` (default), `America:Argentina:Buenos_Aires`.
- **Language is fixed to `en`. Server is fixed to `gismo`.** Not caller-controllable.
- **Never use the `sportApi` fixed-purpose methods for stats tools.** `liagueSummary` hardcodes a `common/` path prefix and ignores the betting house entirely; `liague`, `seasonGoals`, and `leagueFixtures` hardcode the region to `America:Argentina:Buenos_Aires`. Wrapping them makes the `bettingHouse`/`region` parameters silently ineffective. Use `sportData.getInfo(region, method, values)` instead. The two `browse_*` tools are the only exception — they wrap `modalData`/`localData`, whose `config_tree_mini` path shape has no `getInfo` equivalent.
- **Do not modify the parent `index.js`** in this plan. Findings that suggest changes to it get recorded in `endpoints.md` and raised, not applied.
- **Every tool call must be timeout-guarded.** Default 10000ms, overridable via `RADAR_MCP_TIMEOUT_MS`.
- **No tool may throw.** All failures return an MCP error result (`isError: true`). A failing call must never crash the server process.
- **No bet placement, no odds, no wagering actions.** This server retrieves statistics only.

## Known library hazard (drives the timeout design)

`sportData.getInfo` resolves with `data.data.doc[0]`. If a 200 response has no `doc` array, that expression throws a `TypeError` **inside a `.then()` callback**, which rejects the derived promise — but `resolve` was never called and nothing rejects the outer promise. **The returned promise stays pending forever.**

A caller-side `Promise.race` timeout is therefore not just for slow networks; it is the only thing preventing a permanent hang on an unexpected payload shape. It abandons the pending promise rather than aborting the socket — acceptable for a local stdio server, and it avoids duplicating the library's URL construction.

## File Structure

| File | Responsibility |
|---|---|
| `mcp-server/package.json` | Package manifest, deps, test script |
| `mcp-server/probe.js` | Phase 0 only. Standalone discovery script. Not part of the server runtime. |
| `mcp-server/endpoints.md` | Phase 0 findings. Input to the Phase 2 plan. |
| `mcp-server/client.js` | Betting-house/region constants, timeout guard, error normalization, thin `getInfo`/`getByPath`/`browse` wrappers |
| `mcp-server/result.js` | MCP result shaping: `ok` / `fail` / `empty` / `run` |
| `mcp-server/sports.js` | Static sport-name → ID table from the README |
| `mcp-server/tools/discovery.js` | `list_sport_ids`, `browse_sport_categories`, `browse_local` |
| `mcp-server/tools/raw.js` | `get_by_path`, `get_info` |
| `mcp-server/tools/league.js` | `get_league_meta`, `get_league_summary`, `get_league_fixtures`, `get_season_goals` |
| `mcp-server/server.js` | Registers every tool group, connects stdio transport |
| `mcp-server/smoke.js` | Manually-run live check of every tool against real endpoints |
| `mcp-server/test/*.test.js` | `node --test` suites, HTTP intercepted with nock |
| `mcp-server/README.md` | Setup + Claude Code registration |

---

### Task 1: Phase 0 — Endpoint discovery probe

**Why this task is not TDD.** Every other task asserts known-correct behavior. This one discovers facts we do not have — there is no expected value to assert against. Its deliverable is evidence, not code that ships. `probe.js` is a research instrument that stays in the repo so the probe can be re-run when upstream changes.

**Files:**
- Create: `mcp-server/probe.js`
- Create: `mcp-server/endpoints.md`

**Interfaces:**
- Consumes: `sportData` from `../index.js`
- Produces: `endpoints.md` — the authoritative record of which method names work, what ID type each expects, and what shape each returns. The Phase 2 plan is written from this file.

- [ ] **Step 1: Write the probe script**

Create `mcp-server/probe.js`:

```js
'use strict';

// Phase 0 discovery instrument. Not part of the server runtime.
// Usage: node probe.js [bettingHouse]   e.g. node probe.js bet365

const { sportData } = require('../index');
const fs = require('fs');
const path = require('path');

const HOUSE = process.argv[2] || 'bet365';
const REGION = 'Europe:Berlin';
const TIMEOUT_MS = 12000;

// Known-good reference season from the repo README: Brasileiro Serie A 2020.
const REFERENCE_SEASON_ID = 76415;

const client = new sportData(HOUSE, {
  languageId: '514d1e14ad5c11eeebf17ba7f5dc97ad',
  server: 'gismo',
  getCommonContents: false,
  lang: 'en'
});

// getInfo can hang forever on an unexpected payload shape (see plan).
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function summarize(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return depth >= 2 ? `array(${value.length})`
      : `array(${value.length}) of ${value.length ? summarize(value[0], depth + 1) : '?'}`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    return depth >= 2 ? `object{${keys.length} keys}`
      : `object{${keys.slice(0, 25).join(', ')}${keys.length > 25 ? ', ...' : ''}}`;
  }
  return typeof value;
}

async function probe(method, values) {
  const started = Date.now();
  try {
    const data = await withTimeout(client.getInfo(REGION, method, values), TIMEOUT_MS);
    return {
      method, values, status: 'OK', ms: Date.now() - started,
      shape: summarize(data),
      sample: JSON.stringify(data).slice(0, 600)
    };
  } catch (err) {
    const status = err.response ? `HTTP ${err.response.status}` : err.message;
    return { method, values, status: `FAIL: ${status}`, ms: Date.now() - started };
  }
}

const SEASON_SCOPE = [
  'stats_season_meta', 'stats_season_leaguesummary', 'stats_season_goals',
  'stats_season_fixtures2', 'stats_season_fixtures', 'stats_season_tables',
  'stats_season_topgoals', 'stats_season_topassists', 'stats_season_topcards',
  'stats_season_overunder', 'stats_season_teams', 'stats_season_teampositions',
  'stats_season_odds', 'stats_season_uniqueteamstats'
];

const MATCH_SCOPE = [
  'stats_match_details', 'stats_match_get', 'stats_match_info',
  'stats_match_situation', 'stats_match_timeline', 'stats_match_lineups',
  'stats_match_form', 'stats_match_odds', 'match_details', 'match_timelinedelta'
];

const TEAM_SCOPE = [
  'stats_team_info', 'stats_team_lastx', 'stats_team_nextx',
  'stats_team_versus', 'stats_team_versusrecent', 'stats_team_squad',
  'stats_team_seasons', 'stats_team_fixtures', 'stats_team_overunder'
];

const PLAYER_SCOPE = [
  'stats_player_info', 'stats_player_lastx', 'stats_player_seasons'
];

function extractIds(fixtures) {
  // Fixture payload shapes vary; walk the tree for the first plausible
  // match id and the team ids attached to it.
  const found = { matchId: null, teamIds: [] };
  const visit = (node) => {
    if (!node || typeof node !== 'object' || found.matchId) return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (node._doc === 'match' && node._id) {
      found.matchId = node._id;
      for (const side of ['teams', 'team']) {
        const teams = node[side];
        if (teams && typeof teams === 'object') {
          for (const t of Object.values(teams)) {
            if (t && t._id) found.teamIds.push(t._id);
          }
        }
      }
      return;
    }
    Object.values(node).forEach(visit);
  };
  visit(fixtures);
  return found;
}

async function main() {
  const results = [];

  console.error(`# Stage A — season scope (house=${HOUSE}, seasonId=${REFERENCE_SEASON_ID})`);
  for (const method of SEASON_SCOPE) {
    const r = await probe(method, REFERENCE_SEASON_ID);
    results.push(r);
    console.error(`${r.status.padEnd(28)} ${r.method}`);
  }

  console.error('\n# Stage B — resolving real match/team ids from fixtures');
  let ids = { matchId: null, teamIds: [] };
  const fixtures = results.find((r) => r.method.startsWith('stats_season_fixtures') && r.status === 'OK');
  if (fixtures) {
    try {
      const data = await withTimeout(client.getInfo(REGION, fixtures.method, REFERENCE_SEASON_ID), TIMEOUT_MS);
      ids = extractIds(data);
    } catch (err) {
      console.error(`could not re-fetch fixtures: ${err.message}`);
    }
  }
  console.error(`matchId=${ids.matchId} teamIds=${ids.teamIds.slice(0, 2).join(',') || 'none'}`);

  if (ids.matchId) {
    console.error('\n# Stage C — match scope');
    for (const method of MATCH_SCOPE) {
      const r = await probe(method, ids.matchId);
      results.push(r);
      console.error(`${r.status.padEnd(28)} ${r.method}`);
    }
  }

  if (ids.teamIds.length) {
    console.error('\n# Stage D — team scope');
    for (const method of TEAM_SCOPE) {
      // lastx-style endpoints usually need a count suffix; try bare then /5.
      const r = await probe(method, ids.teamIds[0]);
      results.push(r);
      console.error(`${r.status.padEnd(28)} ${r.method}`);
      if (r.status !== 'OK') {
        const r2 = await probe(method, `${ids.teamIds[0]}/5`);
        results.push(r2);
        console.error(`${r2.status.padEnd(28)} ${r2.method} (with /5)`);
      }
    }
    if (ids.teamIds.length > 1) {
      const h2h = await probe('stats_team_versus', `${ids.teamIds[0]}/${ids.teamIds[1]}`);
      results.push(h2h);
      console.error(`${h2h.status.padEnd(28)} stats_team_versus (pair)`);
    }
  }

  console.error('\n# Stage E — player scope (ids unknown; expected to mostly fail)');
  for (const method of PLAYER_SCOPE) {
    const r = await probe(method, REFERENCE_SEASON_ID);
    results.push(r);
    console.error(`${r.status.padEnd(28)} ${r.method}`);
  }

  const out = path.join(__dirname, 'probe-results.json');
  fs.writeFileSync(out, JSON.stringify({ house: HOUSE, region: REGION, ranAt: new Date().toISOString(), ids, results }, null, 2));
  console.error(`\nWrote ${out} (${results.filter((r) => r.status === 'OK').length}/${results.length} OK)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Install dependencies and run the probe**

The parent package already depends on axios; install if `node_modules` is absent.

```bash
cd radar-sport-api-master && npm install && node mcp-server/probe.js bet365
```

Expected: a per-method OK/FAIL table on stderr, and `mcp-server/probe-results.json` written. At minimum `stats_season_meta` should report OK — if even that fails, upstream is unreachable or blocking us, which is itself the finding and must be reported before continuing.

- [ ] **Step 3: Re-run against the other two houses**

```bash
node mcp-server/probe.js betano && node mcp-server/probe.js betclic
```

Move each `probe-results.json` aside between runs (e.g. `probe-results-betano.json`) so results are not overwritten. Purpose: confirm the three houses expose the same method surface. If they differ, that is a significant finding — it means tool availability is house-dependent.

- [ ] **Step 4: Answer Open Question 2 (the `Headers` typo)**

`index.js:7` sets `Headers` (capital H); axios reads lowercase `headers`, so no custom headers are currently sent. The probe results already tell us whether upstream accepts header-less requests. Record the answer explicitly in `endpoints.md`: if everything returned OK, no headers are needed and the typo is harmless; if requests were rejected, note which header upstream wants and that the fix belongs in `mcp-server/client.js`, **not** in the shared library.

- [ ] **Step 5: Write up findings**

Create `mcp-server/endpoints.md` with: the date and houses probed; a table of every method with its status, the ID type it takes, and its response shape; the resolved answer to Open Question 2; and an explicit **"Not reachable"** section listing what could not be found. Corner-level match statistics get called out by name — if no match-statistics endpoint responded, say so plainly here.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/probe.js mcp-server/endpoints.md mcp-server/probe-results*.json
git commit -m "chore(mcp): probe S5 endpoints and record findings"
```

- [ ] **Step 7: STOP and report findings**

Report to the user before proceeding: which endpoints work, which do not, and specifically whether corner data is reachable. Phase 2 planning depends on this. Tasks 2-6 do not depend on it and may proceed regardless.

---

### Task 2: Package scaffold, client, and result helpers

**Files:**
- Create: `mcp-server/package.json`
- Create: `mcp-server/client.js`
- Create: `mcp-server/result.js`
- Test: `mcp-server/test/client.test.js`

**Interfaces:**
- Consumes: `sportData` from `../index.js`
- Produces:
  - `client.js` exports `BETTING_HOUSES: string[]`, `REGIONS: string[]`, `DEFAULT_REGION: string`, `UpstreamError`, `getInfo({bettingHouse, region?, method, values}) -> Promise<any>`, `getByPath({bettingHouse, path}) -> Promise<any>`, `browse({bettingHouse, sportId, localId?}) -> Promise<any>`
  - `result.js` exports `ok(data)`, `fail(message)`, `empty(reason)`, `run(label, fn) -> Promise<ToolResult>`

- [ ] **Step 1: Create the package manifest**

Create `mcp-server/package.json`:

```json
{
  "name": "radar-sport-mcp-server",
  "version": "0.1.0",
  "private": true,
  "description": "MCP server exposing radar-sport-api statistics as tools",
  "main": "server.js",
  "scripts": {
    "test": "node --test test/",
    "start": "node server.js",
    "smoke": "node smoke.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "nock": "^14.0.0"
  }
}
```

```bash
cd radar-sport-api-master/mcp-server && npm install
```

- [ ] **Step 2: Write the failing test**

Create `mcp-server/test/client.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const nock = require('nock');

const client = require('../client');

const BASE = 'https://stats.fn.sportradar.com';

test.beforeEach(() => { nock.cleanAll(); });

test('getInfo builds the URL from house, region, method and id', async () => {
  const scope = nock(BASE)
    .get('/bet365/en/Europe:Berlin/gismo/stats_season_meta/76415')
    .reply(200, { doc: [{ event: 'stats_season_meta', data: { season: { name: 'BSA' } } }] });

  const data = await client.getInfo({ bettingHouse: 'bet365', method: 'stats_season_meta', values: 76415 });

  assert.strictEqual(data.event, 'stats_season_meta');
  assert.ok(scope.isDone(), 'expected the constructed URL to be requested');
});

test('getInfo honours a caller-supplied region', async () => {
  const scope = nock(BASE)
    .get('/betano/en/America:Argentina:Buenos_Aires/gismo/stats_season_goals/76415')
    .reply(200, { doc: [{ event: 'stats_season_goals' }] });

  await client.getInfo({
    bettingHouse: 'betano',
    region: 'America:Argentina:Buenos_Aires',
    method: 'stats_season_goals',
    values: 76415
  });

  assert.ok(scope.isDone(), 'region must reach the URL, not be hardcoded');
});

test('an upstream HTTP error becomes an UpstreamError naming the status', async () => {
  nock(BASE).get('/betclic/en/Europe:Berlin/gismo/stats_season_meta/1').reply(404);

  await assert.rejects(
    () => client.getInfo({ bettingHouse: 'betclic', method: 'stats_season_meta', values: 1 }),
    (err) => err instanceof client.UpstreamError && /404/.test(err.message)
  );
});

test('a 200 with no doc array rejects instead of hanging forever', async () => {
  nock(BASE).get('/bet365/en/Europe:Berlin/gismo/stats_season_meta/2').reply(200, { unexpected: true });

  process.env.RADAR_MCP_TIMEOUT_MS = '300';
  try {
    await assert.rejects(
      () => client.getInfo({ bettingHouse: 'bet365', method: 'stats_season_meta', values: 2 }),
      (err) => err instanceof client.UpstreamError && /timed out/.test(err.message)
    );
  } finally {
    delete process.env.RADAR_MCP_TIMEOUT_MS;
  }
});

test('browse targets the config_tree_mini path', async () => {
  const scope = nock(BASE)
    .get('/bet365/en/Europe:Berlin/gismo/config_tree_mini/41/0/1')
    .reply(200, { doc: [{ data: [{}] }] });

  await client.browse({ bettingHouse: 'bet365', sportId: 1 });

  assert.ok(scope.isDone());
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd radar-sport-api-master/mcp-server && npm test
```

Expected: FAIL — `Cannot find module '../client'`.

**If tests fail on URL mismatch rather than the missing module** once `client.js` exists, the cause is almost certainly colon encoding: `Europe:Berlin` contains colons, and if axios percent-encodes them the nock path literal will not match. Confirm by reading nock's "no match for request" diagnostic, then switch the affected interceptors to a regex matcher, e.g. `.get(/gismo\/stats_season_meta\/76415$/)`. Do not "fix" this by loosening the assertion to the point that region and house are no longer verified.

- [ ] **Step 4: Write the client**

Create `mcp-server/client.js`:

```js
'use strict';

const { sportData, sportApi } = require('../index');

const BETTING_HOUSES = ['betano', 'bet365', 'betclic'];
const REGIONS = ['Europe:Berlin', 'America:Argentina:Buenos_Aires'];
const DEFAULT_REGION = 'Europe:Berlin';
const DEFAULT_TIMEOUT_MS = 10000;

class UpstreamError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'UpstreamError';
    this.details = details || {};
  }
}

function timeoutMs() {
  const raw = Number(process.env.RADAR_MCP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

// The library's getInfo resolves with data.data.doc[0]. On a 200 whose body has
// no doc array that throws inside a .then callback, leaving the outer promise
// pending forever. This race is the only guard against a permanent hang.
function withTimeout(promise, label) {
  const ms = timeoutMs();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new UpstreamError(`Request timed out after ${ms}ms (${label})`, { label, timeoutMs: ms })),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function normalize(err, label) {
  if (err instanceof UpstreamError) return err;
  if (err && err.response) {
    return new UpstreamError(`Upstream returned HTTP ${err.response.status} (${label})`, {
      label, status: err.response.status
    });
  }
  if (err && err.request) {
    return new UpstreamError(`No response from upstream (${label}): ${err.message}`, { label });
  }
  return new UpstreamError(`Request failed (${label}): ${err && err.message ? err.message : String(err)}`, { label });
}

function dataClient(bettingHouse) {
  // Pass every config key: the constructor default is replaced wholesale, not merged.
  return new sportData(bettingHouse, {
    languageId: '514d1e14ad5c11eeebf17ba7f5dc97ad',
    server: 'gismo',
    getCommonContents: false,
    lang: 'en'
  });
}

async function guard(label, fn) {
  try {
    return await withTimeout(fn(), label);
  } catch (err) {
    throw normalize(err, label);
  }
}

function getInfo({ bettingHouse, region = DEFAULT_REGION, method, values }) {
  const label = `${bettingHouse}/${region}/${method}/${values}`;
  return guard(label, () => dataClient(bettingHouse).getInfo(region, method, values));
}

function getByPath({ bettingHouse, path }) {
  const label = `${bettingHouse}/${path}`;
  return guard(label, () => dataClient(bettingHouse).getByPath(path));
}

// config_tree_mini has no getInfo equivalent, so this is the one place the
// sportApi fixed methods are used. sportApi hardcodes Europe:Berlin here, which
// is the default region anyway, so nothing is silently lost.
function browse({ bettingHouse, sportId, localId }) {
  const api = new sportApi(bettingHouse);
  const label = `${bettingHouse}/config_tree_mini/${sportId}${localId != null ? `/${localId}` : ''}`;
  return guard(label, () =>
    localId != null ? api.localData(sportId, localId, 'all') : api.modalData(sportId, 'all')
  );
}

module.exports = {
  BETTING_HOUSES, REGIONS, DEFAULT_REGION, UpstreamError,
  getInfo, getByPath, browse
};
```

- [ ] **Step 5: Write the result helpers**

Create `mcp-server/result.js`:

```js
'use strict';

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

// A successful request that carried no usable data is NOT an error — the agent
// must be able to tell "this league has no such data" from "the request broke".
function empty(reason) {
  return { content: [{ type: 'text', text: JSON.stringify({ empty: true, reason }, null, 2) }] };
}

// Every tool handler wraps its work in this. Nothing else may throw.
async function run(label, fn) {
  try {
    const data = await fn();
    if (data === undefined || data === null) return empty(`${label} returned no data`);
    if (Array.isArray(data) && data.length === 0) return empty(`${label} returned an empty list`);
    return ok(data);
  } catch (err) {
    return fail(`${label} failed: ${err && err.message ? err.message : String(err)}`);
  }
}

module.exports = { ok, fail, empty, run };
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd radar-sport-api-master/mcp-server && npm test
```

Expected: PASS, 5/5.

- [ ] **Step 7: Commit**

```bash
git add mcp-server/package.json mcp-server/package-lock.json mcp-server/client.js mcp-server/result.js mcp-server/test/client.test.js
git commit -m "feat(mcp): add client wrapper with timeout guard and result helpers"
```

---

### Task 3: Discovery tools and a runnable server

Delivers the first end-to-end runnable server. Registration wiring lives here because the discovery tools are the first thing worth registering.

**Files:**
- Create: `mcp-server/sports.js`
- Create: `mcp-server/tools/discovery.js`
- Create: `mcp-server/server.js`
- Test: `mcp-server/test/discovery.test.js`

**Interfaces:**
- Consumes: `client.getInfo`/`client.browse`/`client.BETTING_HOUSES`, `result.run`
- Produces:
  - `sports.js` exports `SPORTS: Array<{name: string, id: number}>`
  - `tools/discovery.js` exports `register(server)` — the shape every tool module follows. Tasks 4 and 5 export the same `register(server)` signature.

- [ ] **Step 1: Write the failing test**

Create `mcp-server/test/discovery.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const nock = require('nock');

const { SPORTS } = require('../sports');
const discovery = require('../tools/discovery');

const BASE = 'https://stats.fn.sportradar.com';

// Minimal stand-in for McpServer, capturing what a module registers.
function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, config, handler) { tools.set(name, { config, handler }); }
  };
}

test.beforeEach(() => { nock.cleanAll(); });

test('the sport table maps football to id 1', () => {
  const football = SPORTS.find((s) => s.name === 'Futebol');
  assert.strictEqual(football.id, 1);
});

test('list_sport_ids returns the table without any network call', async () => {
  const server = fakeServer();
  discovery.register(server);

  const result = await server.tools.get('list_sport_ids').handler({});

  assert.ok(!result.isError);
  assert.match(result.content[0].text, /Futebol/);
});

test('browse_sport_categories requests the config tree for the sport', async () => {
  const scope = nock(BASE)
    .get('/bet365/en/Europe:Berlin/gismo/config_tree_mini/41/0/1')
    .reply(200, { doc: [{ data: [{ name: 'Brazil' }] }] });

  const server = fakeServer();
  discovery.register(server);

  const result = await server.tools.get('browse_sport_categories')
    .handler({ bettingHouse: 'bet365', sportId: 1 });

  assert.ok(!result.isError, result.content[0].text);
  assert.ok(scope.isDone());
});

test('browse_local drills into a category', async () => {
  const scope = nock(BASE)
    .get('/betano/en/Europe:Berlin/gismo/config_tree_mini/41/0/1/18')
    .reply(200, { doc: [{ data: [{ name: 'Serie A' }] }] });

  const server = fakeServer();
  discovery.register(server);

  await server.tools.get('browse_local').handler({ bettingHouse: 'betano', sportId: 1, localId: 18 });

  assert.ok(scope.isDone());
});

test('an upstream failure is returned as a tool error, never thrown', async () => {
  nock(BASE).get('/betclic/en/Europe:Berlin/gismo/config_tree_mini/41/0/1').reply(500);

  const server = fakeServer();
  discovery.register(server);

  const result = await server.tools.get('browse_sport_categories')
    .handler({ bettingHouse: 'betclic', sportId: 1 });

  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /500/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd radar-sport-api-master/mcp-server && npm test
```

Expected: FAIL — `Cannot find module '../sports'`.

- [ ] **Step 3: Write the sport table**

Create `mcp-server/sports.js` (transcribed from the README's sport ID table):

```js
'use strict';

// Sport name -> id, transcribed from the repository README.
// Note: the README lists id 11 for both "Corrida de Motos" and "DOTA", and
// id 7 for both "Ciclismo" and "FloorBall". Both collisions are reproduced
// verbatim rather than guessed at; verify against browse_sport_categories
// before relying on either.
const SPORTS = [
  { name: 'Futebol Americano', id: 16 },
  { name: 'Futebol Australiano', id: 13 },
  { name: 'Andebol', id: 6 },
  { name: 'Badminton', id: 31 },
  { name: 'Bandy', id: 15 },
  { name: 'Basebal', id: 3 },
  { name: 'Basquetebol', id: 2 },
  { name: 'Ciclismo', id: 7 },
  { name: 'Corridas Motorizadas', id: 190 },
  { name: 'Corridas Touring Car', id: 188 },
  { name: 'Corridas de Stock Car', id: 191 },
  { name: 'Counter-Strike', id: 109 },
  { name: 'Cricket', id: 21 },
  { name: 'Dardos', id: 22 },
  { name: 'Corrida de Motos', id: 11 },
  { name: 'DOTA', id: 11 },
  { name: 'FloorBall', id: 7 },
  { name: 'Futebol', id: 1 },
  { name: 'Futebol de praia', id: 60 },
  { name: 'Futsal', id: 29 },
  { name: 'Formula 1', id: 40 },
  { name: 'Hoquei de Campo', id: 24 },
  { name: 'Hoquei de gelo', id: 4 },
  { name: 'Corrida Indy', id: 129 },
  { name: 'League Of Legends', id: 110 },
  { name: 'Polo Aquatico', id: 26 },
  { name: 'Rugby', id: 12 },
  { name: 'Speedway', id: 131 },
  { name: 'Tenis', id: 5 },
  { name: 'Tenis de mesa', id: 20 },
  { name: 'Volei', id: 23 },
  { name: 'Volei de praia', id: 34 }
];

module.exports = { SPORTS };
```

- [ ] **Step 4: Write the discovery tools**

Create `mcp-server/tools/discovery.js`:

```js
'use strict';

const { z } = require('zod');
const client = require('../client');
const { run, ok } = require('../result');
const { SPORTS } = require('../sports');

const bettingHouse = z.enum(client.BETTING_HOUSES)
  .describe('Which betting house feed to query.');

function register(server) {
  server.registerTool(
    'list_sport_ids',
    {
      title: 'List sport IDs',
      description: 'Returns the sport name to numeric ID mapping. No network call. '
        + 'Use this first to turn a sport name such as football into the ID other tools need.',
      inputSchema: {}
    },
    async () => ok(SPORTS)
  );

  server.registerTool(
    'browse_sport_categories',
    {
      title: 'Browse sport categories',
      description: 'Lists the top-level categories (countries/regions) for a sport. '
        + 'Start here to resolve a league name into the numeric ID the stats tools require.',
      inputSchema: {
        bettingHouse,
        sportId: z.number().int().positive().describe('Sport ID from list_sport_ids, e.g. 1 for football.')
      }
    },
    async ({ bettingHouse, sportId }) =>
      run(`browse_sport_categories(${sportId})`, () => client.browse({ bettingHouse, sportId }))
  );

  server.registerTool(
    'browse_local',
    {
      title: 'Browse a category',
      description: 'Drills into one category to reveal its leagues/tournaments and their numeric IDs.',
      inputSchema: {
        bettingHouse,
        sportId: z.number().int().positive().describe('Sport ID from list_sport_ids.'),
        localId: z.number().int().positive().describe('Category ID from browse_sport_categories.')
      }
    },
    async ({ bettingHouse, sportId, localId }) =>
      run(`browse_local(${sportId}/${localId})`, () => client.browse({ bettingHouse, sportId, localId }))
  );
}

module.exports = { register };
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd radar-sport-api-master/mcp-server && npm test
```

Expected: PASS, 10/10 (5 from Task 2, 5 here).

- [ ] **Step 6: Write the server entry point**

Create `mcp-server/server.js`:

```js
'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const discovery = require('./tools/discovery');

const server = new McpServer({ name: 'radar-sport', version: '0.1.0' });

discovery.register(server);

async function main() {
  // stdout is the MCP transport. Diagnostics must go to stderr or they
  // corrupt the protocol stream.
  await server.connect(new StdioServerTransport());
  console.error('radar-sport MCP server ready on stdio');
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 7: Verify the server starts and speaks MCP**

```bash
cd radar-sport-api-master/mcp-server && printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node server.js
```

Expected: two JSON-RPC responses on stdout — an `initialize` result, then a `tools/list` result naming `list_sport_ids`, `browse_sport_categories`, and `browse_local`. The readiness line appears on stderr, not stdout.

- [ ] **Step 8: Commit**

```bash
git add mcp-server/sports.js mcp-server/tools/discovery.js mcp-server/server.js mcp-server/test/discovery.test.js
git commit -m "feat(mcp): add discovery tools and stdio server entry point"
```

---

### Task 4: Raw escape-hatch tools

These matter disproportionately: they cover whatever the named tools miss and are the mitigation when upstream changes break a specific tool.

**Files:**
- Create: `mcp-server/tools/raw.js`
- Modify: `mcp-server/server.js`
- Test: `mcp-server/test/raw.test.js`

**Interfaces:**
- Consumes: `client.getInfo`, `client.getByPath`, `client.BETTING_HOUSES`, `client.REGIONS`, `client.DEFAULT_REGION`, `result.run`
- Produces: `tools/raw.js` exports `register(server)`

- [ ] **Step 1: Write the failing test**

Create `mcp-server/test/raw.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const nock = require('nock');

const raw = require('../tools/raw');

const BASE = 'https://stats.fn.sportradar.com';

function fakeServer() {
  const tools = new Map();
  return { tools, registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
}

test.beforeEach(() => { nock.cleanAll(); });

test('get_by_path passes the path through verbatim', async () => {
  const scope = nock(BASE)
    .get('/bet365/en/Europe:Berlin/gismo/config_tree_mini/41/0/16')
    .reply(200, { doc: [{ ok: true }] });

  const server = fakeServer();
  raw.register(server);

  const result = await server.tools.get('get_by_path').handler({
    bettingHouse: 'bet365',
    path: 'en/Europe:Berlin/gismo/config_tree_mini/41/0/16'
  });

  assert.ok(!result.isError, result.content[0].text);
  assert.ok(scope.isDone());
});

test('get_info defaults the region to Europe:Berlin', async () => {
  const scope = nock(BASE)
    .get('/bet365/en/Europe:Berlin/gismo/stats_season_meta/76415')
    .reply(200, { doc: [{ event: 'stats_season_meta' }] });

  const server = fakeServer();
  raw.register(server);

  await server.tools.get('get_info').handler({
    bettingHouse: 'bet365', method: 'stats_season_meta', values: '76415'
  });

  assert.ok(scope.isDone());
});

test('get_by_path rejects a leading slash rather than building a broken URL', async () => {
  const server = fakeServer();
  raw.register(server);

  const result = await server.tools.get('get_by_path').handler({
    bettingHouse: 'bet365', path: '/en/Europe:Berlin/gismo/x/1'
  });

  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /leading slash/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd radar-sport-api-master/mcp-server && npm test
```

Expected: FAIL — `Cannot find module '../tools/raw'`.

- [ ] **Step 3: Write the raw tools**

Create `mcp-server/tools/raw.js`:

```js
'use strict';

const { z } = require('zod');
const client = require('../client');
const { run, fail } = require('../result');

const bettingHouse = z.enum(client.BETTING_HOUSES).describe('Which betting house feed to query.');

function register(server) {
  server.registerTool(
    'get_by_path',
    {
      title: 'Get by raw S5 path',
      description: 'Escape hatch. Fetches an arbitrary S5 path under a betting house, for data the '
        + 'named tools do not cover. Path is relative and must NOT start with a slash, '
        + 'e.g. "en/Europe:Berlin/gismo/config_tree_mini/41/0/16".',
      inputSchema: {
        bettingHouse,
        path: z.string().min(1).describe('Relative S5 path, no leading slash.')
      }
    },
    async ({ bettingHouse, path }) => {
      // A leading slash would resolve against the host root and silently drop
      // the betting house from the URL, producing a confusing 404.
      if (path.startsWith('/')) {
        return fail('path must not start with a leading slash; it is relative to the betting house segment');
      }
      return run(`get_by_path(${path})`, () => client.getByPath({ bettingHouse, path }));
    }
  );

  server.registerTool(
    'get_info',
    {
      title: 'Get by method name and ID',
      description: 'Escape hatch. Calls any S5 method by name with an ID, following the documented '
        + '{house}/{lang}/{region}/gismo/{method}/{values} pattern. See endpoints.md for known method names.',
      inputSchema: {
        bettingHouse,
        method: z.string().min(1).describe('S5 method name, e.g. "stats_season_meta".'),
        values: z.string().min(1).describe('ID or slash-joined IDs the method expects, e.g. "76415".'),
        region: z.enum(client.REGIONS).optional().describe(`Timezone region. Defaults to ${client.DEFAULT_REGION}.`)
      }
    },
    async ({ bettingHouse, method, values, region }) =>
      run(`get_info(${method}/${values})`, () => client.getInfo({ bettingHouse, region, method, values }))
  );
}

module.exports = { register };
```

- [ ] **Step 4: Register the raw tools in the server**

In `mcp-server/server.js`, add the require alongside the existing discovery require:

```js
const discovery = require('./tools/discovery');
const raw = require('./tools/raw');
```

and the registration call alongside the existing one:

```js
discovery.register(server);
raw.register(server);
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd radar-sport-api-master/mcp-server && npm test
```

Expected: PASS, 13/13.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/tools/raw.js mcp-server/server.js mcp-server/test/raw.test.js
git commit -m "feat(mcp): add raw path and method escape-hatch tools"
```

---

### Task 5: League and season tools

**Note on endpoint confidence.** Only `stats_season_meta` has a documented working response. The other three method names come from library code that `test.js` leaves commented out, and Task 1 smoke-tests them. Build all four regardless — the tests here are nock-mocked, so they verify URL construction and error handling independently of whether upstream is currently serving that method. If Task 1 marked a method dead, note it in the tool description and in `endpoints.md`; do not silently drop the tool.

**Files:**
- Create: `mcp-server/tools/league.js`
- Modify: `mcp-server/server.js`
- Test: `mcp-server/test/league.test.js`

**Interfaces:**
- Consumes: `client.getInfo`, `client.BETTING_HOUSES`, `client.REGIONS`, `client.DEFAULT_REGION`, `result.run`
- Produces: `tools/league.js` exports `register(server)`

- [ ] **Step 1: Write the failing test**

Create `mcp-server/test/league.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const nock = require('nock');

const league = require('../tools/league');

const BASE = 'https://stats.fn.sportradar.com';

function fakeServer() {
  const tools = new Map();
  return { tools, registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
}

function handlers() {
  const server = fakeServer();
  league.register(server);
  return server.tools;
}

test.beforeEach(() => { nock.cleanAll(); });

const CASES = [
  ['get_league_meta', 'stats_season_meta'],
  ['get_league_summary', 'stats_season_leaguesummary'],
  ['get_league_fixtures', 'stats_season_fixtures2'],
  ['get_season_goals', 'stats_season_goals']
];

for (const [tool, method] of CASES) {
  test(`${tool} calls ${method} with the league id`, async () => {
    const scope = nock(BASE)
      .get(new RegExp(`/bet365/en/Europe:Berlin/gismo/${method}/76415`))
      .reply(200, { doc: [{ event: method }] });

    const result = await handlers().get(tool).handler({ bettingHouse: 'bet365', leagueId: 76415 });

    assert.ok(!result.isError, result.content[0].text);
    assert.ok(scope.isDone(), `${tool} must request ${method}`);
  });
}

test('get_league_summary uses the caller betting house, not a hardcoded common prefix', async () => {
  const scope = nock(BASE)
    .get(/\/betclic\/en\/.*stats_season_leaguesummary\/76415/)
    .reply(200, { doc: [{ event: 'stats_season_leaguesummary' }] });

  await handlers().get('get_league_summary').handler({ bettingHouse: 'betclic', leagueId: 76415 });

  assert.ok(scope.isDone(), 'betting house must reach the URL');
});

test('get_league_fixtures uses the caller region, not a hardcoded Buenos Aires', async () => {
  const scope = nock(BASE)
    .get(/\/bet365\/en\/Europe:Berlin\/gismo\/stats_season_fixtures2\/76415/)
    .reply(200, { doc: [{ event: 'stats_season_fixtures2' }] });

  await handlers().get('get_league_fixtures').handler({ bettingHouse: 'bet365', leagueId: 76415 });

  assert.ok(scope.isDone(), 'region must default to Europe:Berlin, not the library hardcode');
});

test('a failing league call returns a tool error', async () => {
  nock(BASE).get(/stats_season_meta\/999/).reply(503);

  const result = await handlers().get('get_league_meta').handler({ bettingHouse: 'bet365', leagueId: 999 });

  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /503/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd radar-sport-api-master/mcp-server && npm test
```

Expected: FAIL — `Cannot find module '../tools/league'`.

- [ ] **Step 3: Write the league tools**

Create `mcp-server/tools/league.js`:

```js
'use strict';

const { z } = require('zod');
const client = require('../client');
const { run } = require('../result');

const bettingHouse = z.enum(client.BETTING_HOUSES).describe('Which betting house feed to query.');
const region = z.enum(client.REGIONS).optional()
  .describe(`Timezone region affecting reported match times. Defaults to ${client.DEFAULT_REGION}.`);
const leagueId = z.number().int().positive()
  .describe('Season/league ID, resolved via browse_local. Example: 76415 (Brasileiro Serie A 2020).');

// Built over client.getInfo rather than the sportApi fixed methods, which
// hardcode the region (and, for the summary, drop the betting house entirely).
const TOOLS = [
  {
    name: 'get_league_meta',
    method: 'stats_season_meta',
    title: 'Get league/season metadata',
    description: 'Season identity: name, year, start/end dates, tournament IDs, and the statscoverage '
      + 'block listing which statistics exist for this league. Call this before match-level work to '
      + 'check whether the data you need is covered.'
  },
  {
    name: 'get_league_summary',
    method: 'stats_season_leaguesummary',
    title: 'Get league summary',
    description: 'League summary and standings for a season.'
  },
  {
    name: 'get_league_fixtures',
    method: 'stats_season_fixtures2',
    title: 'Get league fixtures',
    description: 'Scheduled and completed matches for a season. This is the source of match IDs and '
      + 'team IDs used by match- and team-level tools.'
  },
  {
    name: 'get_season_goals',
    method: 'stats_season_goals',
    title: 'Get season goal statistics',
    description: 'Season scoring statistics, used for over/under and scoring-pattern analysis.'
  }
];

function register(server) {
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: { bettingHouse, leagueId, region }
      },
      async ({ bettingHouse, leagueId, region }) =>
        run(`${tool.name}(${leagueId})`, () =>
          client.getInfo({ bettingHouse, region, method: tool.method, values: leagueId })
        )
    );
  }
}

module.exports = { register };
```

- [ ] **Step 4: Register the league tools in the server**

In `mcp-server/server.js`, add alongside the existing requires:

```js
const league = require('./tools/league');
```

and alongside the existing registration calls:

```js
league.register(server);
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd radar-sport-api-master/mcp-server && npm test
```

Expected: PASS, 20/20.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/tools/league.js mcp-server/server.js mcp-server/test/league.test.js
git commit -m "feat(mcp): add league and season statistics tools"
```

---

### Task 6: Live smoke script, Claude Code registration, and docs

A server that passes mocked tests but fails the MCP handshake is not working. This task verifies against both a real client and real endpoints.

**Files:**
- Create: `mcp-server/smoke.js`
- Create: `mcp-server/README.md`
- Create: `.mcp.json` (repo root)

**Interfaces:**
- Consumes: every tool module's `register(server)`
- Produces: `.mcp.json` registering the server as `radar-sport` for Claude Code

- [ ] **Step 1: Write the live smoke script**

Create `mcp-server/smoke.js`:

```js
'use strict';

// Live check against real upstream endpoints. NOT part of `npm test` — it
// depends on a third party being reachable. Run it to answer "has upstream
// broken?", not to verify code changes.
// Usage: node smoke.js [bettingHouse]

const client = require('./client');

const HOUSE = process.argv[2] || 'bet365';
const REFERENCE_SEASON_ID = 76415;

const CHECKS = [
  ['browse_sport_categories', () => client.browse({ bettingHouse: HOUSE, sportId: 1 })],
  ['get_league_meta', () => client.getInfo({ bettingHouse: HOUSE, method: 'stats_season_meta', values: REFERENCE_SEASON_ID })],
  ['get_league_summary', () => client.getInfo({ bettingHouse: HOUSE, method: 'stats_season_leaguesummary', values: REFERENCE_SEASON_ID })],
  ['get_league_fixtures', () => client.getInfo({ bettingHouse: HOUSE, method: 'stats_season_fixtures2', values: REFERENCE_SEASON_ID })],
  ['get_season_goals', () => client.getInfo({ bettingHouse: HOUSE, method: 'stats_season_goals', values: REFERENCE_SEASON_ID })],
  ['get_by_path', () => client.getByPath({ bettingHouse: HOUSE, path: 'en/Europe:Berlin/gismo/config_tree_mini/41/0/1' })]
];

async function main() {
  let failures = 0;
  console.log(`Live smoke test against ${HOUSE}\n`);

  for (const [name, call] of CHECKS) {
    try {
      const data = await call();
      const keys = data && typeof data === 'object' ? Object.keys(data).slice(0, 6).join(', ') : typeof data;
      console.log(`PASS  ${name.padEnd(26)} ${keys}`);
    } catch (err) {
      failures += 1;
      console.log(`FAIL  ${name.padEnd(26)} ${err.message}`);
    }
  }

  console.log(`\n${CHECKS.length - failures}/${CHECKS.length} reachable`);
  process.exit(failures === CHECKS.length ? 1 : 0);
}

main();
```

- [ ] **Step 2: Run the live smoke test**

```bash
cd radar-sport-api-master/mcp-server && npm run smoke
```

Expected: a PASS/FAIL line per tool. Record the actual result in `endpoints.md`. Partial failure is an acceptable outcome and must be reported honestly, not worked around — some of these method names are unverified by design. Total failure (0/6) means upstream is unreachable and needs investigating before this plan can be called done.

- [ ] **Step 3: Register the server with Claude Code**

Create `.mcp.json` at the repository root:

```json
{
  "mcpServers": {
    "radar-sport": {
      "command": "node",
      "args": ["mcp-server/server.js"]
    }
  }
}
```

- [ ] **Step 4: Verify the handshake with a real client**

Restart Claude Code so it picks up `.mcp.json`, then confirm the `radar-sport` server connects and its tools are listed. Call `list_sport_ids` through the client — it needs no network, so it isolates the transport from upstream availability. Then call `get_league_meta` with `bettingHouse: "bet365"`, `leagueId: 76415`.

Expected: the tool list shows all nine tools; `list_sport_ids` returns the sport table; `get_league_meta` returns season data or a clean tool error, never a crash or a hang.

- [ ] **Step 5: Write the README**

Create `mcp-server/README.md` covering: what the server is and its non-goals (no bet placement, no odds); install (`npm install` in `mcp-server/`); the `.mcp.json` snippet; a table of all nine tools with parameters; the `RADAR_MCP_TIMEOUT_MS` env var; how to run `npm test` and `npm run smoke`; a pointer to `endpoints.md` for endpoint status; and an explicit warning that these are undocumented third-party endpoints that may change without notice, with `get_by_path`/`get_info` as the fallback.

- [ ] **Step 6: Run the full test suite one final time**

```bash
cd radar-sport-api-master/mcp-server && npm test
```

Expected: PASS, 20/20.

- [ ] **Step 7: Commit**

```bash
git add mcp-server/smoke.js mcp-server/README.md .mcp.json
git commit -m "feat(mcp): add live smoke test, Claude Code registration and docs"
```

---

## Done criteria

- `npm test` passes 20/20 with no network access required.
- The server completes an MCP handshake with Claude Code and lists nine tools.
- `endpoints.md` records what is reachable, what is not, and whether corner data exists.
- Findings from Task 1 have been reported, so the Phase 2 plan can be written.

## Follow-up work (not in this plan)

1. **Phase 2 plan** — team, match, and player tools, including `get_team_match_stats_history` for corner analysis. Written from `endpoints.md`.
2. **The betting-analysis skill** — the judgment layer that tells an agent how to use these tools. Depends on Phase 2.
3. **`index.js` fixes**, if Task 1 justifies them: the `Headers`/`headers` typo at `index.js:7`, the missing axios timeout, and the `getInfo` hang on unexpected payload shapes. All are library changes, deliberately out of scope here.
