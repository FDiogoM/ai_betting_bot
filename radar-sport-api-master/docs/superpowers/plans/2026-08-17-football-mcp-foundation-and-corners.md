# Football MCP Server — Foundation & Corners Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an MCP server that retrieves football fixtures, tables, and match statistics from API-Football — including a corner profile for any team — within a 100 request/day free tier.

**Architecture:** A `mcp-server/` package in this repo. `http.js` owns the authenticated axios instance and error mapping; `cache.js` is a disk cache that makes finished-match data free to re-read; `quota.js` tracks the daily budget and enforces a per-call request ceiling; `provider/apiFootball.js` is the only module that knows the provider's endpoints and response shapes; `tools/*.js` each export `register(server)`; `server.js` wires them to a stdio transport.

**Tech Stack:** Node.js (CommonJS), `@modelcontextprotocol/sdk` 1.30.x, `zod` 3.25.x, `axios` (already a repo dependency), `nock` 14.x (dev), Node's built-in `node --test` runner.

**Spec:** `docs/superpowers/specs/2026-08-17-football-stats-mcp-server-design.md`

## Scope

Covers **Plan 1** from the spec's Implementation Sequencing: foundation plus the statistics and corner tooling. Players and odds are Plan 2.

**Tasks 1-5 need no API key** — every test is nock-mocked. **Task 6 needs a real key** in `API_FOOTBALL_KEY`; if it is not available when you reach Task 6, complete every other step, commit, and report Task 6 as blocked on the key rather than faking verification.

## Global Constraints

- **Node.js >= 18.** Verification target is the installed v26.5.0.
- **CommonJS only.** No `"type": "module"`, no build step, no TypeScript.
- **Base URL:** `https://v3.football.api-sports.io`
- **Auth header:** `x-apisports-key`, value from `process.env.API_FOOTBALL_KEY`.
- **The API key must never be written to a log line, an error message, a cache file, or a test fixture.** A unit test asserts this.
- **Every HTTP request is timeout-guarded.** Default 10000ms, overridable via `MCP_HTTP_TIMEOUT_MS`.
- **No tool may throw.** Every failure returns an MCP error result (`isError: true`). A failing call never crashes the server process.
- **API-Football returns HTTP 200 with a populated `errors` field for auth and plan problems.** A 200 is not success. Every response must be checked for `errors` before its `response` array is used.
- **Cache-first, network-second.** Every read checks the cache before issuing a request.
- **`get_team_corner_profile` caps:** `matchCount` default 10, hard cap 20; per-call request ceiling 25 (`MCP_MAX_REQUESTS_PER_CALL`); concurrency 3.
- **No bet placement, no odds-based advice, no access-control circumvention.** Retrieval only.

## Provider response shape (assumed, verified in Task 6)

Every API-Football v3 endpoint returns:

```json
{
  "get": "fixtures/statistics",
  "parameters": { "fixture": "215662" },
  "errors": [],
  "results": 2,
  "paging": { "current": 1, "total": 1 },
  "response": [ /* payload */ ]
}
```

Quota headers on each response: `x-ratelimit-requests-limit` and `x-ratelimit-requests-remaining` (daily), `x-ratelimit-limit` and `x-ratelimit-remaining` (per-minute).

`errors` is `[]` on success, but an **object** (e.g. `{"token":"invalid key"}`) or a non-empty array on failure. Treat any non-empty value as failure.

## File Structure

| File | Responsibility |
|---|---|
| `mcp-server/package.json` | Manifest, deps, scripts |
| `mcp-server/http.js` | Authenticated axios instance, timeout, `errors`-field check, error classification |
| `mcp-server/cache.js` | Disk cache: key hashing, TTL policy, get/set |
| `mcp-server/quota.js` | Quota persistence, remaining-budget reads, per-call ceiling |
| `mcp-server/provider/apiFootball.js` | Endpoint paths, parameters, response unwrapping, finished-fixture detection |
| `mcp-server/result.js` | MCP result shaping: `ok` / `fail` / `empty` / `run` |
| `mcp-server/tools/reference.js` | `get_api_status`, `search_leagues`, `search_teams` |
| `mcp-server/tools/fixtures.js` | `get_fixtures`, `get_team_fixtures`, `get_fixture`, `get_head_to_head`, `get_standings` |
| `mcp-server/tools/stats.js` | `get_fixture_statistics`, `get_team_season_statistics`, `get_team_corner_profile` |
| `mcp-server/server.js` | Registers tool groups, connects stdio transport |
| `mcp-server/smoke.js` | Manually-run live verification (needs a key) |
| `mcp-server/test/*.test.js` | `node --test` suites, HTTP intercepted with nock |
| `mcp-server/README.md` | Setup, key configuration, tool reference |

---

### Task 1: Package scaffold and the HTTP layer

**Files:**
- Create: `mcp-server/package.json`
- Create: `mcp-server/http.js`
- Create: `mcp-server/result.js`
- Create: `mcp-server/.gitignore`
- Test: `mcp-server/test/http.test.js`

**Interfaces:**
- Produces:
  - `http.js` exports `request(path, params) -> Promise<{data: any[], quota: {limit, remaining}}>`, `ApiError`, `BASE_URL`
  - `result.js` exports `ok(data)`, `fail(message)`, `empty(reason)`, `run(label, fn)`

- [ ] **Step 1: Create the manifest and gitignore**

Create `mcp-server/package.json`:

```json
{
  "name": "football-mcp-server",
  "version": "0.1.0",
  "private": true,
  "description": "MCP server exposing football statistics for betting analysis",
  "main": "server.js",
  "scripts": {
    "test": "node --test test/",
    "start": "node server.js",
    "smoke": "node smoke.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "axios": "^1.6.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "nock": "^14.0.0"
  }
}
```

Create `mcp-server/.gitignore`:

```
node_modules/
.cache/
```

```bash
cd radar-sport-api-master/mcp-server && npm install
```

- [ ] **Step 2: Write the failing test**

Create `mcp-server/test/http.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const nock = require('nock');

const http = require('../http');

const BASE = 'https://v3.football.api-sports.io';

test.beforeEach(() => {
  nock.cleanAll();
  process.env.API_FOOTBALL_KEY = 'test-key-123';
});

test('request sends the api key header and unwraps the response array', async () => {
  const scope = nock(BASE, { reqheaders: { 'x-apisports-key': 'test-key-123' } })
    .get('/status')
    .reply(200, { errors: [], results: 1, response: [{ account: { firstname: 'x' } }] });

  const { data } = await http.request('/status');

  assert.strictEqual(data.length, 1);
  assert.ok(scope.isDone());
});

test('query parameters are passed through', async () => {
  const scope = nock(BASE)
    .get('/fixtures')
    .query({ team: '33', last: '5' })
    .reply(200, { errors: [], response: [] });

  await http.request('/fixtures', { team: 33, last: 5 });

  assert.ok(scope.isDone());
});

test('quota headers are captured', async () => {
  nock(BASE).get('/status').reply(200, { errors: [], response: [] }, {
    'x-ratelimit-requests-limit': '100',
    'x-ratelimit-requests-remaining': '87'
  });

  const { quota } = await http.request('/status');

  assert.strictEqual(quota.limit, 100);
  assert.strictEqual(quota.remaining, 87);
});

test('a 200 carrying an errors object is treated as failure, not success', async () => {
  nock(BASE).get('/status').reply(200, { errors: { token: 'invalid key' }, response: [] });

  await assert.rejects(
    () => http.request('/status'),
    (err) => err instanceof http.ApiError && /invalid key/.test(err.message)
  );
});

test('an empty errors array is not treated as failure', async () => {
  nock(BASE).get('/status').reply(200, { errors: [], response: [{ ok: true }] });

  const { data } = await http.request('/status');

  assert.strictEqual(data.length, 1);
});

test('HTTP 429 produces a quota-exhaustion message', async () => {
  nock(BASE).get('/status').reply(429, {});

  await assert.rejects(
    () => http.request('/status'),
    (err) => err instanceof http.ApiError && /quota/i.test(err.message)
  );
});

test('HTTP 401 produces an API-key message', async () => {
  nock(BASE).get('/status').reply(401, {});

  await assert.rejects(
    () => http.request('/status'),
    (err) => err instanceof http.ApiError && /api key/i.test(err.message)
  );
});

test('a missing API key fails before any request is made', async () => {
  delete process.env.API_FOOTBALL_KEY;
  const scope = nock(BASE).get('/status').reply(200, { errors: [], response: [] });

  await assert.rejects(
    () => http.request('/status'),
    (err) => /API_FOOTBALL_KEY/.test(err.message)
  );
  assert.ok(!scope.isDone(), 'no request should be issued without a key');
  nock.cleanAll();
});

test('the API key never appears in an error message', async () => {
  nock(BASE).get('/status').reply(500, { message: 'boom' });

  try {
    await http.request('/status');
    assert.fail('expected a rejection');
  } catch (err) {
    assert.ok(!JSON.stringify(err.message).includes('test-key-123'), 'key leaked into error message');
  }
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd radar-sport-api-master/mcp-server && npm test
```

Expected: FAIL — `Cannot find module '../http'`.

- [ ] **Step 4: Write the HTTP layer**

Create `mcp-server/http.js`:

```js
'use strict';

const axios = require('axios').default;

const BASE_URL = 'https://v3.football.api-sports.io';
const DEFAULT_TIMEOUT_MS = 10000;

class ApiError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ApiError';
    this.details = details || {};
  }
}

function timeoutMs() {
  const raw = Number(process.env.MCP_HTTP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function apiKey() {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) {
    throw new ApiError('API_FOOTBALL_KEY is not set. Export your API-Football key before starting the server.');
  }
  return key;
}

// API-Football signals auth and plan problems with HTTP 200 plus a populated
// `errors` field, which may be an object or an array. A 200 is not success.
function describeErrors(errors) {
  if (!errors) return null;
  if (Array.isArray(errors)) return errors.length ? errors.join('; ') : null;
  if (typeof errors === 'object') {
    const entries = Object.entries(errors);
    return entries.length ? entries.map(([k, v]) => `${k}: ${v}`).join('; ') : null;
  }
  return String(errors);
}

function classify(err, path) {
  if (err instanceof ApiError) return err;

  const status = err && err.response ? err.response.status : null;
  if (status === 429) {
    return new ApiError(`Daily request quota exhausted (${path}). Check get_api_status; the quota resets at midnight UTC.`, { status });
  }
  if (status === 401 || status === 403) {
    return new ApiError(`API key rejected (${path}). Verify API_FOOTBALL_KEY is valid and your plan covers this endpoint.`, { status });
  }
  if (status >= 500) {
    return new ApiError(`Provider unavailable, HTTP ${status} (${path}).`, { status });
  }
  if (status) {
    return new ApiError(`Request failed with HTTP ${status} (${path}).`, { status });
  }
  if (err && err.code === 'ECONNABORTED') {
    return new ApiError(`Request timed out after ${timeoutMs()}ms (${path}).`);
  }
  // err.message is provider/network text; the key lives only in the header,
  // which is never serialized here.
  return new ApiError(`Request failed (${path}): ${err && err.message ? err.message : String(err)}`);
}

async function request(path, params = {}) {
  const key = apiKey();
  let res;
  try {
    res = await axios.get(`${BASE_URL}${path}`, {
      params,
      timeout: timeoutMs(),
      headers: { 'x-apisports-key': key }
    });
  } catch (err) {
    throw classify(err, path);
  }

  const problem = describeErrors(res.data && res.data.errors);
  if (problem) {
    throw new ApiError(`Provider rejected the request (${path}): ${problem}`, { path });
  }

  return {
    data: (res.data && res.data.response) || [],
    quota: {
      limit: Number(res.headers['x-ratelimit-requests-limit']) || null,
      remaining: Number(res.headers['x-ratelimit-requests-remaining']) || null
    }
  };
}

module.exports = { request, ApiError, BASE_URL };
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

// A successful request that matched nothing is NOT an error. An agent must be
// able to tell "no corner data for this fixture" from "the request broke".
function empty(reason) {
  return { content: [{ type: 'text', text: JSON.stringify({ empty: true, reason }, null, 2) }] };
}

// Every tool handler wraps its work in this. Nothing else may throw.
async function run(label, fn) {
  try {
    const data = await fn();
    if (data === undefined || data === null) return empty(`${label} returned no data`);
    if (Array.isArray(data) && data.length === 0) return empty(`${label} matched nothing`);
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

Expected: PASS, 9/9.

- [ ] **Step 7: Commit**

```bash
git add mcp-server/package.json mcp-server/package-lock.json mcp-server/.gitignore mcp-server/http.js mcp-server/result.js mcp-server/test/http.test.js
git commit -m "feat(mcp): add authenticated HTTP layer with error classification"
```

---

### Task 2: Disk cache and quota tracking

The cache is what makes a 100 request/day budget workable: finished-match statistics are immutable, so they are cached permanently and re-read for free.

**Files:**
- Create: `mcp-server/cache.js`
- Create: `mcp-server/quota.js`
- Test: `mcp-server/test/cache.test.js`

**Interfaces:**
- Consumes: nothing from Task 1 (deliberately independent — the cache stores plain JSON)
- Produces:
  - `cache.js` exports `read(path, params) -> any|null`, `write(path, params, value, ttlMs) -> void`, `TTL` (named constants), `cacheDir()`, `clear()`
  - `quota.js` exports `record(quota) -> void`, `read() -> {limit, remaining, updatedAt}|null`, `maxRequestsPerCall() -> number`

`TTL` constants: `PERMANENT` (`null`), `LIVE` (5 min), `TABLE` (6 h), `REFERENCE` (7 d), `ODDS` (15 min).

- [ ] **Step 1: Write the failing test**

Create `mcp-server/test/cache.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cache = require('../cache');
const quota = require('../quota');

test.beforeEach(() => {
  process.env.MCP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cache-'));
});

test.afterEach(() => {
  fs.rmSync(process.env.MCP_CACHE_DIR, { recursive: true, force: true });
});

test('a written value reads back', () => {
  cache.write('/fixtures', { id: 1 }, { hello: 'world' }, cache.TTL.PERMANENT);

  assert.deepStrictEqual(cache.read('/fixtures', { id: 1 }), { hello: 'world' });
});

test('different params are different cache entries', () => {
  cache.write('/fixtures', { id: 1 }, 'one', cache.TTL.PERMANENT);
  cache.write('/fixtures', { id: 2 }, 'two', cache.TTL.PERMANENT);

  assert.strictEqual(cache.read('/fixtures', { id: 1 }), 'one');
  assert.strictEqual(cache.read('/fixtures', { id: 2 }), 'two');
});

test('param order does not change the cache key', () => {
  cache.write('/fixtures', { a: 1, b: 2 }, 'value', cache.TTL.PERMANENT);

  assert.strictEqual(cache.read('/fixtures', { b: 2, a: 1 }), 'value');
});

test('a miss returns null', () => {
  assert.strictEqual(cache.read('/fixtures', { id: 99 }), null);
});

test('an expired entry reads as a miss', () => {
  cache.write('/fixtures', { id: 1 }, 'stale', 1);

  const until = Date.now() + 25;
  while (Date.now() < until) { /* let the 1ms TTL lapse */ }

  assert.strictEqual(cache.read('/fixtures', { id: 1 }), null);
});

test('a permanent entry does not expire', () => {
  cache.write('/fixtures', { id: 1 }, 'forever', cache.TTL.PERMANENT);

  assert.strictEqual(cache.read('/fixtures', { id: 1 }), 'forever');
});

test('quota is recorded and read back', () => {
  quota.record({ limit: 100, remaining: 42 });

  const stored = quota.read();
  assert.strictEqual(stored.limit, 100);
  assert.strictEqual(stored.remaining, 42);
  assert.ok(stored.updatedAt);
});

test('a null quota reading does not overwrite a known value', () => {
  quota.record({ limit: 100, remaining: 42 });
  quota.record({ limit: null, remaining: null });

  assert.strictEqual(quota.read().remaining, 42);
});

test('the per-call request ceiling defaults to 25 and honours the env override', () => {
  assert.strictEqual(quota.maxRequestsPerCall(), 25);

  process.env.MCP_MAX_REQUESTS_PER_CALL = '5';
  assert.strictEqual(quota.maxRequestsPerCall(), 5);
  delete process.env.MCP_MAX_REQUESTS_PER_CALL;
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd radar-sport-api-master/mcp-server && npm test
```

Expected: FAIL — `Cannot find module '../cache'`.

- [ ] **Step 3: Write the cache**

Create `mcp-server/cache.js`:

```js
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TTL = {
  PERMANENT: null,          // finished matches: immutable, never expire
  LIVE: 5 * 60 * 1000,      // scheduled/live fixtures
  ODDS: 15 * 60 * 1000,     // odds move continuously pre-match
  TABLE: 6 * 60 * 60 * 1000,        // standings, team season stats
  REFERENCE: 7 * 24 * 60 * 60 * 1000 // leagues, teams, squads
};

function cacheDir() {
  return process.env.MCP_CACHE_DIR || path.join(__dirname, '.cache');
}

function keyFor(endpoint, params) {
  // Sort so param order cannot produce two entries for one logical request.
  const sorted = Object.keys(params || {}).sort()
    .map((k) => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha256').update(`${endpoint}?${sorted}`).digest('hex');
}

function entryPath(endpoint, params) {
  return path.join(cacheDir(), `${keyFor(endpoint, params)}.json`);
}

function read(endpoint, params) {
  const file = entryPath(endpoint, params);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return null; // miss
  }

  let entry;
  try {
    entry = JSON.parse(raw);
  } catch (err) {
    // A corrupt entry is a miss, not a crash.
    try { fs.unlinkSync(file); } catch (ignored) { /* best effort */ }
    return null;
  }

  if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) return null;
  return entry.value;
}

function write(endpoint, params, value, ttlMs) {
  fs.mkdirSync(cacheDir(), { recursive: true });
  const entry = {
    storedAt: Date.now(),
    expiresAt: ttlMs === null || ttlMs === undefined ? null : Date.now() + ttlMs,
    value
  };
  fs.writeFileSync(entryPath(endpoint, params), JSON.stringify(entry), 'utf8');
}

function clear() {
  fs.rmSync(cacheDir(), { recursive: true, force: true });
}

module.exports = { read, write, clear, cacheDir, TTL };
```

- [ ] **Step 4: Write quota tracking**

Create `mcp-server/quota.js`:

```js
'use strict';

const fs = require('fs');
const path = require('path');
const { cacheDir } = require('./cache');

const DEFAULT_MAX_REQUESTS_PER_CALL = 25;

function quotaFile() {
  return path.join(cacheDir(), 'quota.json');
}

function read() {
  try {
    return JSON.parse(fs.readFileSync(quotaFile(), 'utf8'));
  } catch (err) {
    return null;
  }
}

// Not every response carries quota headers; a reading without them must not
// erase what we already knew.
function record(quota) {
  if (!quota || quota.remaining === null || quota.remaining === undefined) return;
  fs.mkdirSync(cacheDir(), { recursive: true });
  fs.writeFileSync(
    quotaFile(),
    JSON.stringify({ limit: quota.limit, remaining: quota.remaining, updatedAt: new Date().toISOString() }),
    'utf8'
  );
}

function maxRequestsPerCall() {
  const raw = Number(process.env.MCP_MAX_REQUESTS_PER_CALL);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_REQUESTS_PER_CALL;
}

module.exports = { read, record, maxRequestsPerCall };
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd radar-sport-api-master/mcp-server && npm test
```

Expected: PASS, 18/18 (9 from Task 1, 9 here).

- [ ] **Step 6: Commit**

```bash
git add mcp-server/cache.js mcp-server/quota.js mcp-server/test/cache.test.js
git commit -m "feat(mcp): add disk cache and quota tracking"
```

---

### Task 3: Provider module, reference tools, and a runnable server

**Files:**
- Create: `mcp-server/provider/apiFootball.js`
- Create: `mcp-server/tools/reference.js`
- Create: `mcp-server/server.js`
- Test: `mcp-server/test/provider.test.js`

**Interfaces:**
- Consumes: `http.request`, `cache.read`/`write`/`TTL`, `quota.record`/`read`, `result.run`/`ok`
- Produces:
  - `provider/apiFootball.js` exports `fetch(endpoint, params, ttl, forceRefresh) -> Promise<any[]>`, `isFinished(fixture) -> boolean`, `ENDPOINTS`
  - `tools/reference.js` exports `register(server)` — the shape every tool module follows

- [ ] **Step 1: Write the failing test**

Create `mcp-server/test/provider.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nock = require('nock');

const provider = require('../provider/apiFootball');
const cache = require('../cache');
const reference = require('../tools/reference');

const BASE = 'https://v3.football.api-sports.io';

function fakeServer() {
  const tools = new Map();
  return { tools, registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
}

test.beforeEach(() => {
  nock.cleanAll();
  process.env.API_FOOTBALL_KEY = 'test-key-123';
  process.env.MCP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-prov-'));
});

test.afterEach(() => {
  fs.rmSync(process.env.MCP_CACHE_DIR, { recursive: true, force: true });
});

test('a second identical fetch is served from cache without a request', async () => {
  const scope = nock(BASE).get('/leagues').query({ search: 'Premier' })
    .reply(200, { errors: [], response: [{ league: { id: 39 } }] });

  const first = await provider.fetch('/leagues', { search: 'Premier' }, cache.TTL.REFERENCE);
  const second = await provider.fetch('/leagues', { search: 'Premier' }, cache.TTL.REFERENCE);

  assert.deepStrictEqual(first, second);
  assert.ok(scope.isDone());
  assert.strictEqual(nock.pendingMocks().length, 0, 'only one request should have been issued');
});

test('force_refresh bypasses a cached entry', async () => {
  nock(BASE).get('/leagues').query({ search: 'Premier' })
    .reply(200, { errors: [], response: [{ league: { id: 39 } }] });
  await provider.fetch('/leagues', { search: 'Premier' }, cache.TTL.REFERENCE);

  const refresh = nock(BASE).get('/leagues').query({ search: 'Premier' })
    .reply(200, { errors: [], response: [{ league: { id: 40 } }] });

  const data = await provider.fetch('/leagues', { search: 'Premier' }, cache.TTL.REFERENCE, true);

  assert.strictEqual(data[0].league.id, 40);
  assert.ok(refresh.isDone());
});

test('isFinished recognises full time and rejects scheduled matches', () => {
  assert.strictEqual(provider.isFinished({ fixture: { status: { short: 'FT' } } }), true);
  assert.strictEqual(provider.isFinished({ fixture: { status: { short: 'AET' } } }), true);
  assert.strictEqual(provider.isFinished({ fixture: { status: { short: 'NS' } } }), false);
  assert.strictEqual(provider.isFinished({ fixture: { status: { short: '1H' } } }), false);
  assert.strictEqual(provider.isFinished({}), false);
});

test('get_api_status reports the remaining quota', async () => {
  nock(BASE).get('/status').reply(200, {
    errors: [],
    response: [{ account: { firstname: 'test' }, subscription: { plan: 'Free' }, requests: { current: 13, limit_day: 100 } }]
  });

  const server = fakeServer();
  reference.register(server);
  const result = await server.tools.get('get_api_status').handler({});

  assert.ok(!result.isError, result.content[0].text);
  assert.match(result.content[0].text, /100/);
});

test('search_leagues passes the search term through', async () => {
  const scope = nock(BASE).get('/leagues').query({ search: 'Primeira' })
    .reply(200, { errors: [], response: [{ league: { id: 94, name: 'Primeira Liga' } }] });

  const server = fakeServer();
  reference.register(server);
  const result = await server.tools.get('search_leagues').handler({ query: 'Primeira' });

  assert.ok(!result.isError, result.content[0].text);
  assert.ok(scope.isDone());
});

test('a search matching nothing reports empty, not an error', async () => {
  nock(BASE).get('/teams').query({ search: 'Nonexistent' })
    .reply(200, { errors: [], response: [] });

  const server = fakeServer();
  reference.register(server);
  const result = await server.tools.get('search_teams').handler({ query: 'Nonexistent' });

  assert.ok(!result.isError, 'an empty match is not an error');
  assert.match(result.content[0].text, /"empty": true/);
});

test('an upstream failure is returned as a tool error, never thrown', async () => {
  nock(BASE).get('/leagues').query({ search: 'X' }).reply(429, {});

  const server = fakeServer();
  reference.register(server);
  const result = await server.tools.get('search_leagues').handler({ query: 'X' });

  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /quota/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd radar-sport-api-master/mcp-server && npm test
```

Expected: FAIL — `Cannot find module '../provider/apiFootball'`.

- [ ] **Step 3: Write the provider module**

Create `mcp-server/provider/apiFootball.js`:

```js
'use strict';

const http = require('../http');
const cache = require('../cache');
const quota = require('../quota');

// The only place endpoint paths live. Swapping providers touches this file.
const ENDPOINTS = {
  STATUS: '/status',
  LEAGUES: '/leagues',
  TEAMS: '/teams',
  FIXTURES: '/fixtures',
  HEAD_TO_HEAD: '/fixtures/headtohead',
  FIXTURE_STATISTICS: '/fixtures/statistics',
  STANDINGS: '/standings',
  TEAM_STATISTICS: '/teams/statistics'
};

const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN']);

function isFinished(fixture) {
  const short = fixture && fixture.fixture && fixture.fixture.status
    ? fixture.fixture.status.short
    : null;
  return FINISHED_STATUSES.has(short);
}

// Cache-first, network-second. Every read goes through here.
async function fetch(endpoint, params = {}, ttl = cache.TTL.LIVE, forceRefresh = false) {
  if (!forceRefresh) {
    const hit = cache.read(endpoint, params);
    if (hit !== null) return hit;
  }

  const { data, quota: seen } = await http.request(endpoint, params);
  quota.record(seen);
  cache.write(endpoint, params, data, ttl);
  return data;
}

module.exports = { fetch, isFinished, ENDPOINTS };
```

- [ ] **Step 4: Write the reference tools**

Create `mcp-server/tools/reference.js`:

```js
'use strict';

const { z } = require('zod');
const provider = require('../provider/apiFootball');
const http = require('../http');
const cache = require('../cache');
const quota = require('../quota');
const { run } = require('../result');

const forceRefresh = z.boolean().optional()
  .describe('Bypass the cache and refetch. Costs a request against the daily quota.');

function register(server) {
  server.registerTool(
    'get_api_status',
    {
      title: 'Get API account status',
      description: 'Reports the plan, requests used today, and requests remaining. '
        + 'Call this before an expensive aggregation such as get_team_corner_profile '
        + 'to confirm there is budget for it.',
      inputSchema: {}
    },
    // Deliberately bypasses provider.fetch: status must never be cached, and
    // provider.fetch always writes a cache entry.
    async () => run('get_api_status', async () => {
      const { data, quota: seen } = await http.request(provider.ENDPOINTS.STATUS);
      quota.record(seen);
      return { account: data[0] || null, lastSeenQuota: quota.read() };
    })
  );

  server.registerTool(
    'search_leagues',
    {
      title: 'Search leagues',
      description: 'Finds leagues by name and returns their IDs and available seasons. '
        + 'Use this to turn a league name such as "Premier League" into the numeric '
        + 'league ID and season year that fixture and standings tools require.',
      inputSchema: {
        query: z.string().min(3).describe('League name or fragment, e.g. "Premier" or "Primeira".'),
        forceRefresh
      }
    },
    async ({ query, forceRefresh }) =>
      run(`search_leagues(${query})`, () =>
        provider.fetch(provider.ENDPOINTS.LEAGUES, { search: query }, cache.TTL.REFERENCE, forceRefresh))
  );

  server.registerTool(
    'search_teams',
    {
      title: 'Search teams',
      description: 'Finds teams by name and returns their IDs. Team IDs are required by '
        + 'get_team_fixtures, get_team_corner_profile and get_head_to_head.',
      inputSchema: {
        query: z.string().min(3).describe('Team name or fragment, e.g. "Benfica".'),
        forceRefresh
      }
    },
    async ({ query, forceRefresh }) =>
      run(`search_teams(${query})`, () =>
        provider.fetch(provider.ENDPOINTS.TEAMS, { search: query }, cache.TTL.REFERENCE, forceRefresh))
  );
}

module.exports = { register };
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd radar-sport-api-master/mcp-server && npm test
```

Expected: PASS, 25/25.

- [ ] **Step 6: Write the server entry point**

Create `mcp-server/server.js`:

```js
'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const reference = require('./tools/reference');

const server = new McpServer({ name: 'football-stats', version: '0.1.0' });

reference.register(server);

async function main() {
  // stdout is the MCP transport. Diagnostics must go to stderr or they
  // corrupt the protocol stream.
  await server.connect(new StdioServerTransport());
  console.error('football-stats MCP server ready on stdio');
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

Expected: two JSON-RPC responses on stdout — an `initialize` result, then a `tools/list` result naming `get_api_status`, `search_leagues`, and `search_teams`. The readiness line appears on stderr, not stdout. No API key is needed for `tools/list`.

- [ ] **Step 8: Commit**

```bash
git add mcp-server/provider/apiFootball.js mcp-server/tools/reference.js mcp-server/server.js mcp-server/test/provider.test.js
git commit -m "feat(mcp): add provider module, reference tools and stdio server"
```

---

### Task 4: Fixtures, head-to-head, and standings

Introduces conditional TTL: a finished fixture is immutable and cached permanently, while a scheduled one must expire quickly. `provider.fetch` gains support for a TTL chosen from the response.

**Files:**
- Modify: `mcp-server/provider/apiFootball.js`
- Create: `mcp-server/tools/fixtures.js`
- Modify: `mcp-server/server.js`
- Test: `mcp-server/test/fixtures.test.js`

**Interfaces:**
- Consumes: `provider.fetch`, `provider.isFinished`, `provider.ENDPOINTS`, `cache.TTL`, `result.run`
- Produces:
  - `provider.fetch`'s `ttl` argument now accepts either a value (`number | null`) or a function `(data) => number | null`
  - `tools/fixtures.js` exports `register(server)`

- [ ] **Step 1: Write the failing test**

Create `mcp-server/test/fixtures.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nock = require('nock');

const provider = require('../provider/apiFootball');
const cache = require('../cache');
const fixtures = require('../tools/fixtures');

const BASE = 'https://v3.football.api-sports.io';

function fakeServer() {
  const tools = new Map();
  return { tools, registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
}

function handlers() {
  const server = fakeServer();
  fixtures.register(server);
  return server.tools;
}

test.beforeEach(() => {
  nock.cleanAll();
  process.env.API_FOOTBALL_KEY = 'test-key-123';
  process.env.MCP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-fix-'));
});

test.afterEach(() => {
  fs.rmSync(process.env.MCP_CACHE_DIR, { recursive: true, force: true });
});

test('a function TTL receives the response and picks the lifetime', async () => {
  nock(BASE).get('/fixtures').query({ id: '1' })
    .reply(200, { errors: [], response: [{ fixture: { status: { short: 'FT' } } }] });

  const seen = [];
  await provider.fetch('/fixtures', { id: 1 }, (data) => {
    seen.push(data.length);
    return cache.TTL.PERMANENT;
  });

  assert.deepStrictEqual(seen, [1]);
});

test('a finished fixture is cached permanently', async () => {
  nock(BASE).get('/fixtures').query({ id: '1' })
    .reply(200, { errors: [], response: [{ fixture: { id: 1, status: { short: 'FT' } } }] });

  await handlers().get('get_fixture').handler({ fixtureId: 1 });

  const entry = JSON.parse(fs.readFileSync(
    path.join(process.env.MCP_CACHE_DIR, fs.readdirSync(process.env.MCP_CACHE_DIR)[0]), 'utf8'
  ));
  assert.strictEqual(entry.expiresAt, null, 'a finished fixture must never expire');
});

test('a scheduled fixture is cached with a short expiry', async () => {
  nock(BASE).get('/fixtures').query({ id: '2' })
    .reply(200, { errors: [], response: [{ fixture: { id: 2, status: { short: 'NS' } } }] });

  await handlers().get('get_fixture').handler({ fixtureId: 2 });

  const entry = JSON.parse(fs.readFileSync(
    path.join(process.env.MCP_CACHE_DIR, fs.readdirSync(process.env.MCP_CACHE_DIR)[0]), 'utf8'
  ));
  assert.ok(entry.expiresAt !== null, 'a scheduled fixture must expire');
  assert.ok(entry.expiresAt - entry.storedAt <= cache.TTL.LIVE);
});

test('get_team_fixtures requests the last N matches', async () => {
  const scope = nock(BASE).get('/fixtures').query({ team: '33', last: '5' })
    .reply(200, { errors: [], response: [{ fixture: { id: 1 } }] });

  const result = await handlers().get('get_team_fixtures').handler({ teamId: 33, last: 5 });

  assert.ok(!result.isError, result.content[0].text);
  assert.ok(scope.isDone());
});

test('get_team_fixtures rejects asking for both last and next', async () => {
  const result = await handlers().get('get_team_fixtures').handler({ teamId: 33, last: 5, next: 5 });

  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /either last or next/i);
});

test('get_fixtures passes the league, season and date range', async () => {
  const scope = nock(BASE).get('/fixtures')
    .query({ league: '39', season: '2026', from: '2026-08-20', to: '2026-08-22' })
    .reply(200, { errors: [], response: [{ fixture: { id: 7 } }] });

  await handlers().get('get_fixtures').handler({
    leagueId: 39, season: 2026, from: '2026-08-20', to: '2026-08-22'
  });

  assert.ok(scope.isDone());
});

test('get_head_to_head joins the two team ids', async () => {
  const scope = nock(BASE).get('/fixtures/headtohead').query({ h2h: '33-34' })
    .reply(200, { errors: [], response: [{ fixture: { id: 9 } }] });

  await handlers().get('get_head_to_head').handler({ teamId: 33, opponentId: 34 });

  assert.ok(scope.isDone());
});

test('get_standings requests the league table', async () => {
  const scope = nock(BASE).get('/standings').query({ league: '39', season: '2026' })
    .reply(200, { errors: [], response: [{ league: { standings: [] } }] });

  await handlers().get('get_standings').handler({ leagueId: 39, season: 2026 });

  assert.ok(scope.isDone());
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd radar-sport-api-master/mcp-server && npm test
```

Expected: FAIL — `Cannot find module '../tools/fixtures'`.

- [ ] **Step 3: Teach the provider about function TTLs**

In `mcp-server/provider/apiFootball.js`, replace the `fetch` function with:

```js
// Cache-first, network-second. Every read goes through here.
// `ttl` is either a value (number | null) or a function (data) => number | null,
// so a caller can pick the lifetime from the response — a finished fixture is
// immutable and cached permanently, a scheduled one must expire quickly.
async function fetch(endpoint, params = {}, ttl = cache.TTL.LIVE, forceRefresh = false) {
  if (!forceRefresh) {
    const hit = cache.read(endpoint, params);
    if (hit !== null) return hit;
  }

  const { data, quota: seen } = await http.request(endpoint, params);
  quota.record(seen);
  cache.write(endpoint, params, data, typeof ttl === 'function' ? ttl(data) : ttl);
  return data;
}
```

- [ ] **Step 4: Write the fixtures tools**

Create `mcp-server/tools/fixtures.js`:

```js
'use strict';

const { z } = require('zod');
const provider = require('../provider/apiFootball');
const cache = require('../cache');
const { run, fail } = require('../result');

const forceRefresh = z.boolean().optional()
  .describe('Bypass the cache and refetch. Costs a request against the daily quota.');
const teamId = z.number().int().positive().describe('Team ID from search_teams.');
const leagueId = z.number().int().positive().describe('League ID from search_leagues.');
const season = z.number().int().min(2000).max(2100).describe('Season start year, e.g. 2026.');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Date as YYYY-MM-DD.');

// A response of all-finished fixtures never changes; anything else might.
function ttlFromFixtures(data) {
  return data.length && data.every(provider.isFinished) ? cache.TTL.PERMANENT : cache.TTL.LIVE;
}

function register(server) {
  server.registerTool(
    'get_fixtures',
    {
      title: 'Get fixtures in a date range',
      description: 'Lists a league\'s fixtures between two dates. Use this to find what is on '
        + 'this weekend and to obtain fixture and team IDs for deeper analysis.',
      inputSchema: { leagueId, season, from: isoDate, to: isoDate, forceRefresh }
    },
    async ({ leagueId, season, from, to, forceRefresh }) =>
      run(`get_fixtures(${leagueId}/${season})`, () =>
        provider.fetch(provider.ENDPOINTS.FIXTURES,
          { league: leagueId, season, from, to }, ttlFromFixtures, forceRefresh))
  );

  server.registerTool(
    'get_team_fixtures',
    {
      title: 'Get a team\'s recent or upcoming fixtures',
      description: 'Returns a team\'s last N results or next N scheduled matches. '
        + 'Supply exactly one of last or next. This is the entry point for form analysis.',
      inputSchema: {
        teamId,
        last: z.number().int().min(1).max(50).optional().describe('How many recent finished matches.'),
        next: z.number().int().min(1).max(50).optional().describe('How many upcoming matches.'),
        forceRefresh
      }
    },
    async ({ teamId, last, next, forceRefresh }) => {
      if ((last && next) || (!last && !next)) {
        return fail('Supply either last or next, not both and not neither.');
      }
      const params = last ? { team: teamId, last } : { team: teamId, next };
      return run(`get_team_fixtures(${teamId})`, () =>
        provider.fetch(provider.ENDPOINTS.FIXTURES, params, ttlFromFixtures, forceRefresh));
    }
  );

  server.registerTool(
    'get_fixture',
    {
      title: 'Get one fixture',
      description: 'Full detail for a single fixture ID, including status, teams, and score.',
      inputSchema: { fixtureId: z.number().int().positive().describe('Fixture ID.'), forceRefresh }
    },
    async ({ fixtureId, forceRefresh }) =>
      run(`get_fixture(${fixtureId})`, () =>
        provider.fetch(provider.ENDPOINTS.FIXTURES, { id: fixtureId }, ttlFromFixtures, forceRefresh))
  );

  server.registerTool(
    'get_head_to_head',
    {
      title: 'Get head-to-head history',
      description: 'Historical meetings between two teams, most recent first.',
      inputSchema: { teamId, opponentId: z.number().int().positive().describe('The other team\'s ID.'), forceRefresh }
    },
    async ({ teamId, opponentId, forceRefresh }) =>
      run(`get_head_to_head(${teamId}-${opponentId})`, () =>
        provider.fetch(provider.ENDPOINTS.HEAD_TO_HEAD,
          { h2h: `${teamId}-${opponentId}` }, ttlFromFixtures, forceRefresh))
  );

  server.registerTool(
    'get_standings',
    {
      title: 'Get the league table',
      description: 'Current standings for a league and season.',
      inputSchema: { leagueId, season, forceRefresh }
    },
    async ({ leagueId, season, forceRefresh }) =>
      run(`get_standings(${leagueId}/${season})`, () =>
        provider.fetch(provider.ENDPOINTS.STANDINGS,
          { league: leagueId, season }, cache.TTL.TABLE, forceRefresh))
  );
}

module.exports = { register };
```

- [ ] **Step 5: Register the fixtures tools**

In `mcp-server/server.js`, add alongside the existing require and registration:

```js
const fixtures = require('./tools/fixtures');
```

```js
fixtures.register(server);
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd radar-sport-api-master/mcp-server && npm test
```

Expected: PASS, 33/33.

- [ ] **Step 7: Commit**

```bash
git add mcp-server/provider/apiFootball.js mcp-server/tools/fixtures.js mcp-server/server.js mcp-server/test/fixtures.test.js
git commit -m "feat(mcp): add fixtures, head-to-head and standings tools"
```

---

### Task 5: Match statistics and the corner profile

The headline capability. `get_team_corner_profile` is the reason the cache and the quota ceiling exist.

**Files:**
- Create: `mcp-server/tools/stats.js`
- Modify: `mcp-server/server.js`
- Test: `mcp-server/test/stats.test.js`

**Interfaces:**
- Consumes: `provider.fetch`, `provider.isFinished`, `provider.ENDPOINTS`, `cache.read`/`TTL`, `quota.maxRequestsPerCall`, `result.run`/`fail`
- Produces: `tools/stats.js` exports `register(server)`

**Statistics response shape.** `/fixtures/statistics?fixture=N` returns one entry per team:

```json
[
  { "team": { "id": 33, "name": "Team A" },
    "statistics": [ { "type": "Corner Kicks", "value": 7 }, { "type": "Ball Possession", "value": "63%" } ] }
]
```

`value` may be `null` when a statistic was not recorded. Treat `null` as missing, not zero — a fabricated `0` would silently corrupt an average.

- [ ] **Step 1: Write the failing test**

Create `mcp-server/test/stats.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nock = require('nock');

const stats = require('../tools/stats');

const BASE = 'https://v3.football.api-sports.io';

function fakeServer() {
  const tools = new Map();
  return { tools, registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
}

function handlers() {
  const server = fakeServer();
  stats.register(server);
  return server.tools;
}

function finishedFixture(id, homeId, awayId) {
  return {
    fixture: { id, status: { short: 'FT' }, date: `2026-08-0${id}T12:00:00+00:00` },
    teams: { home: { id: homeId, name: `T${homeId}` }, away: { id: awayId, name: `T${awayId}` } }
  };
}

function statsFor(homeId, awayId, homeCorners, awayCorners) {
  return {
    errors: [],
    response: [
      { team: { id: homeId }, statistics: [{ type: 'Corner Kicks', value: homeCorners }] },
      { team: { id: awayId }, statistics: [{ type: 'Corner Kicks', value: awayCorners }] }
    ]
  };
}

test.beforeEach(() => {
  nock.cleanAll();
  process.env.API_FOOTBALL_KEY = 'test-key-123';
  process.env.MCP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stats-'));
});

test.afterEach(() => {
  fs.rmSync(process.env.MCP_CACHE_DIR, { recursive: true, force: true });
  delete process.env.MCP_MAX_REQUESTS_PER_CALL;
});

test('get_fixture_statistics returns the per-team statistics', async () => {
  nock(BASE).get('/fixtures/statistics').query({ fixture: '1' }).reply(200, statsFor(33, 34, 7, 3));

  const result = await handlers().get('get_fixture_statistics').handler({ fixtureId: 1 });

  assert.ok(!result.isError, result.content[0].text);
  assert.match(result.content[0].text, /Corner Kicks/);
});

test('the corner profile totals corners for and against', async () => {
  nock(BASE).get('/fixtures').query({ team: '33', last: '2' })
    .reply(200, { errors: [], response: [finishedFixture(1, 33, 34), finishedFixture(2, 35, 33)] });
  nock(BASE).get('/fixtures/statistics').query({ fixture: '1' }).reply(200, statsFor(33, 34, 7, 3));
  nock(BASE).get('/fixtures/statistics').query({ fixture: '2' }).reply(200, statsFor(35, 33, 4, 6));

  const result = await handlers().get('get_team_corner_profile').handler({ teamId: 33, matchCount: 2 });

  assert.ok(!result.isError, result.content[0].text);
  const body = JSON.parse(result.content[0].text);
  assert.strictEqual(body.matchesAnalyzed, 2);
  assert.strictEqual(body.totals.cornersFor, 13);   // 7 at home + 6 away
  assert.strictEqual(body.totals.cornersAgainst, 7); // 3 + 4
  assert.strictEqual(body.averages.cornersFor, 6.5);
});

test('a match whose statistics fail is reported, not silently dropped', async () => {
  nock(BASE).get('/fixtures').query({ team: '33', last: '2' })
    .reply(200, { errors: [], response: [finishedFixture(1, 33, 34), finishedFixture(2, 35, 33)] });
  nock(BASE).get('/fixtures/statistics').query({ fixture: '1' }).reply(200, statsFor(33, 34, 7, 3));
  nock(BASE).get('/fixtures/statistics').query({ fixture: '2' }).reply(500, {});

  const result = await handlers().get('get_team_corner_profile').handler({ teamId: 33, matchCount: 2 });

  const body = JSON.parse(result.content[0].text);
  assert.strictEqual(body.matchesAnalyzed, 1);
  assert.strictEqual(body.failures.length, 1);
  assert.strictEqual(body.failures[0].fixtureId, 2);
});

test('a null corner value is treated as missing, never as zero', async () => {
  nock(BASE).get('/fixtures').query({ team: '33', last: '1' })
    .reply(200, { errors: [], response: [finishedFixture(1, 33, 34)] });
  nock(BASE).get('/fixtures/statistics').query({ fixture: '1' }).reply(200, statsFor(33, 34, null, 3));

  const result = await handlers().get('get_team_corner_profile').handler({ teamId: 33, matchCount: 1 });

  const body = JSON.parse(result.content[0].text);
  assert.strictEqual(body.matchesAnalyzed, 0, 'a match without corner data cannot be analyzed');
  assert.strictEqual(body.failures.length, 1);
  assert.match(body.failures[0].reason, /no corner/i);
});

test('the profile refuses to exceed the per-call request ceiling', async () => {
  process.env.MCP_MAX_REQUESTS_PER_CALL = '2';
  nock(BASE).get('/fixtures').query({ team: '33', last: '5' }).reply(200, {
    errors: [],
    response: [1, 2, 3, 4, 5].map((id) => finishedFixture(id, 33, 34))
  });

  const result = await handlers().get('get_team_corner_profile').handler({ teamId: 33, matchCount: 5 });

  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /would need 5 requests.*ceiling of 2/i);
});

test('cached statistics do not count toward the ceiling', async () => {
  nock(BASE).get('/fixtures/statistics').query({ fixture: '1' }).reply(200, statsFor(33, 34, 7, 3));
  await handlers().get('get_fixture_statistics').handler({ fixtureId: 1 });

  process.env.MCP_MAX_REQUESTS_PER_CALL = '1';
  nock(BASE).get('/fixtures').query({ team: '33', last: '1' })
    .reply(200, { errors: [], response: [finishedFixture(1, 33, 34)] });

  const result = await handlers().get('get_team_corner_profile').handler({ teamId: 33, matchCount: 1 });

  assert.ok(!result.isError, 'a fully cached profile must not be blocked by the ceiling');
});

test('matchCount above the hard cap is rejected by the schema', () => {
  const schema = handlers().get('get_team_corner_profile').config.inputSchema;

  assert.throws(() => schema.matchCount.parse(21));
  assert.strictEqual(schema.matchCount.parse(20), 20);
});

test('get_team_season_statistics requests the aggregate endpoint', async () => {
  const scope = nock(BASE).get('/teams/statistics').query({ league: '39', season: '2026', team: '33' })
    .reply(200, { errors: [], response: { fixtures: {} } });

  await handlers().get('get_team_season_statistics').handler({ leagueId: 39, season: 2026, teamId: 33 });

  assert.ok(scope.isDone());
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd radar-sport-api-master/mcp-server && npm test
```

Expected: FAIL — `Cannot find module '../tools/stats'`.

- [ ] **Step 3: Write the statistics tools**

Create `mcp-server/tools/stats.js`:

```js
'use strict';

const { z } = require('zod');
const provider = require('../provider/apiFootball');
const cache = require('../cache');
const quota = require('../quota');
const { run, fail, ok } = require('../result');

const CORNER_TYPE = 'Corner Kicks';
const CONCURRENCY = 3;
const DEFAULT_MATCH_COUNT = 10;
const MAX_MATCH_COUNT = 20;

const forceRefresh = z.boolean().optional()
  .describe('Bypass the cache and refetch. Costs requests against the daily quota.');

function statisticsParams(fixtureId) {
  return { fixture: fixtureId };
}

// Finished-match statistics are immutable, so they are cached permanently.
// This is what makes repeat corner analysis nearly free.
function fetchStatistics(fixtureId, force) {
  return provider.fetch(provider.ENDPOINTS.FIXTURE_STATISTICS,
    statisticsParams(fixtureId), cache.TTL.PERMANENT, force);
}

function cornerValue(entries, teamId) {
  const forTeam = entries.find((e) => e.team && e.team.id === teamId);
  if (!forTeam || !Array.isArray(forTeam.statistics)) return null;
  const stat = forTeam.statistics.find((s) => s.type === CORNER_TYPE);
  // null means the statistic was not recorded. Coercing it to 0 would corrupt
  // every average computed from it.
  if (!stat || stat.value === null || stat.value === undefined) return null;
  const n = Number(stat.value);
  return Number.isFinite(n) ? n : null;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function pump() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, pump));
  return results;
}

function register(server) {
  server.registerTool(
    'get_fixture_statistics',
    {
      title: 'Get match statistics',
      description: 'Per-team statistics for one fixture: corner kicks, cards, shots on and off '
        + 'target, possession, offsides and fouls. Finished matches are cached permanently.',
      inputSchema: { fixtureId: z.number().int().positive().describe('Fixture ID.'), forceRefresh }
    },
    async ({ fixtureId, forceRefresh }) =>
      run(`get_fixture_statistics(${fixtureId})`, () => fetchStatistics(fixtureId, forceRefresh))
  );

  server.registerTool(
    'get_team_season_statistics',
    {
      title: 'Get a team\'s season statistics',
      description: 'Aggregate season form for one team in one league — played, wins, goals for '
        + 'and against, streaks. One request, so prefer this over per-match analysis when '
        + 'season-level form is enough.',
      inputSchema: {
        leagueId: z.number().int().positive().describe('League ID from search_leagues.'),
        season: z.number().int().min(2000).max(2100).describe('Season start year, e.g. 2026.'),
        teamId: z.number().int().positive().describe('Team ID from search_teams.'),
        forceRefresh
      }
    },
    async ({ leagueId, season, teamId, forceRefresh }) =>
      run(`get_team_season_statistics(${teamId})`, () =>
        provider.fetch(provider.ENDPOINTS.TEAM_STATISTICS,
          { league: leagueId, season, team: teamId }, cache.TTL.TABLE, forceRefresh))
  );

  server.registerTool(
    'get_team_corner_profile',
    {
      title: 'Get a team\'s corner profile',
      description: 'Corner analysis across a team\'s recent finished matches. Fetches the '
        + 'fixtures and each one\'s statistics, returning corners for and against per match '
        + 'plus totals and averages. This is the tool for corner markets. It costs roughly one '
        + 'request per uncached match, so check get_api_status first when the quota is tight.',
      inputSchema: {
        teamId: z.number().int().positive().describe('Team ID from search_teams.'),
        matchCount: z.number().int().min(1).max(MAX_MATCH_COUNT).optional()
          .describe(`How many recent finished matches to analyze (default ${DEFAULT_MATCH_COUNT}, max ${MAX_MATCH_COUNT}).`),
        forceRefresh
      }
    },
    async ({ teamId, matchCount = DEFAULT_MATCH_COUNT, forceRefresh }) => {
      let fixtures;
      try {
        fixtures = await provider.fetch(provider.ENDPOINTS.FIXTURES,
          { team: teamId, last: matchCount }, cache.TTL.LIVE, forceRefresh);
      } catch (err) {
        return fail(`get_team_corner_profile(${teamId}) failed fetching fixtures: ${err.message}`);
      }

      const finished = fixtures.filter(provider.isFinished);
      if (!finished.length) {
        return ok({ teamId, matchesAnalyzed: 0, matches: [], failures: [],
          note: 'No finished matches found for this team.' });
      }

      // Count only what would actually hit the network; a warm cache is free.
      const ceiling = quota.maxRequestsPerCall();
      const needed = forceRefresh
        ? finished.length
        : finished.filter((f) => cache.read(provider.ENDPOINTS.FIXTURE_STATISTICS,
            statisticsParams(f.fixture.id)) === null).length;
      if (needed > ceiling) {
        return fail(`get_team_corner_profile(${teamId}) would need ${needed} requests, above the `
          + `per-call ceiling of ${ceiling}. Lower matchCount, or raise MCP_MAX_REQUESTS_PER_CALL.`);
      }

      const matches = [];
      const failures = [];

      await mapWithConcurrency(finished, CONCURRENCY, async (fixture) => {
        const id = fixture.fixture.id;
        const isHome = fixture.teams.home.id === teamId;
        const opponent = isHome ? fixture.teams.away : fixture.teams.home;

        let entries;
        try {
          entries = await fetchStatistics(id, forceRefresh);
        } catch (err) {
          failures.push({ fixtureId: id, reason: err.message });
          return;
        }

        const cornersFor = cornerValue(entries, teamId);
        const cornersAgainst = cornerValue(entries, opponent.id);
        if (cornersFor === null || cornersAgainst === null) {
          failures.push({ fixtureId: id, reason: 'no corner statistics recorded for this match' });
          return;
        }

        matches.push({
          fixtureId: id,
          date: fixture.fixture.date,
          opponent: opponent.name,
          venue: isHome ? 'home' : 'away',
          cornersFor,
          cornersAgainst
        });
      });

      matches.sort((a, b) => String(b.date).localeCompare(String(a.date)));

      const totals = matches.reduce((acc, m) => ({
        cornersFor: acc.cornersFor + m.cornersFor,
        cornersAgainst: acc.cornersAgainst + m.cornersAgainst
      }), { cornersFor: 0, cornersAgainst: 0 });

      const round = (n) => Math.round(n * 100) / 100;

      return ok({
        teamId,
        matchesAnalyzed: matches.length,
        matches,
        totals,
        averages: matches.length ? {
          cornersFor: round(totals.cornersFor / matches.length),
          cornersAgainst: round(totals.cornersAgainst / matches.length),
          totalCorners: round((totals.cornersFor + totals.cornersAgainst) / matches.length)
        } : null,
        failures
      });
    }
  );
}

module.exports = { register };
```

- [ ] **Step 4: Register the statistics tools**

In `mcp-server/server.js`, add alongside the existing requires and registrations:

```js
const stats = require('./tools/stats');
```

```js
stats.register(server);
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd radar-sport-api-master/mcp-server && npm test
```

Expected: PASS, 41/41.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/tools/stats.js mcp-server/server.js mcp-server/test/stats.test.js
git commit -m "feat(mcp): add match statistics and team corner profile"
```

---

### Task 6: Live verification, registration, and docs

**Requires a real API key in `API_FOOTBALL_KEY`.** If none is available, complete Steps 1, 3 and 5, commit, and report Task 6 as blocked on the key. **Do not fabricate verification results.**

This task also settles the spec's Open Question 1: whether the free tier actually returns corner statistics.

**Files:**
- Create: `mcp-server/smoke.js`
- Create: `mcp-server/README.md`
- Create: `.mcp.json` (repo root)

- [ ] **Step 1: Write the live smoke script**

Create `mcp-server/smoke.js`:

```js
'use strict';

// Live verification against the real provider. NOT part of `npm test` — it
// needs a key and spends daily quota. Deliberately small: 5 requests.
// Usage: API_FOOTBALL_KEY=... node smoke.js

const http = require('./http');

async function step(name, fn) {
  try {
    const value = await fn();
    console.log(`PASS  ${name.padEnd(30)} ${value}`);
    return true;
  } catch (err) {
    console.log(`FAIL  ${name.padEnd(30)} ${err.message}`);
    return false;
  }
}

async function main() {
  if (!process.env.API_FOOTBALL_KEY) {
    console.error('API_FOOTBALL_KEY is not set. Export your key and re-run.');
    process.exit(2);
  }

  let failures = 0;
  let fixtureId = null;

  const record = (passed) => { if (!passed) failures += 1; };

  record(await step('account status', async () => {
    const { data, quota } = await http.request('/status');
    const acct = data[0] || {};
    const plan = acct.subscription ? acct.subscription.plan : 'unknown';
    return `plan=${plan} remaining=${quota.remaining ?? '?'}`;
  }));

  record(await step('search leagues', async () => {
    const { data } = await http.request('/leagues', { search: 'Premier League' });
    return `${data.length} matches`;
  }));

  record(await step('recent finished fixture', async () => {
    // Premier League, a season the free tier is documented to include.
    const { data } = await http.request('/fixtures', { league: 39, season: 2023, last: 1 });
    if (!data.length) throw new Error('no fixtures returned');
    fixtureId = data[0].fixture.id;
    return `fixture ${fixtureId}`;
  }));

  record(await step('fixture statistics', async () => {
    if (!fixtureId) throw new Error('skipped, no fixture id');
    const { data } = await http.request('/fixtures/statistics', { fixture: fixtureId });
    const types = data.length && data[0].statistics
      ? data[0].statistics.map((s) => s.type)
      : [];
    return `${data.length} teams, types: ${types.join(', ') || 'none'}`;
  }));

  // The question the whole design hangs on.
  record(await step('CORNER DATA AVAILABLE', async () => {
    if (!fixtureId) throw new Error('skipped, no fixture id');
    const { data } = await http.request('/fixtures/statistics', { fixture: fixtureId });
    const corners = data.length && data[0].statistics
      ? data[0].statistics.find((s) => s.type === 'Corner Kicks')
      : null;
    if (!corners) throw new Error('NO "Corner Kicks" IN RESPONSE — corner markets unsupported on this plan');
    return `Corner Kicks = ${corners.value}`;
  }));

  console.log(`\n${5 - failures}/5 checks passed`);
  process.exit(failures ? 1 : 0);
}

main();
```

- [ ] **Step 2: Run the live smoke test**

```bash
cd radar-sport-api-master/mcp-server && API_FOOTBALL_KEY=<your-key> npm run smoke
```

Record the real output. The `CORNER DATA AVAILABLE` line is the one that matters: if it fails, corner markets are not supported on the free plan and that must be reported to the repo owner as a decision point (pay for a plan that includes them, or drop corner tooling) — **not worked around**.

If the endpoint shapes differ from the assumptions in this plan, fix `provider/apiFootball.js` and the affected tests, then re-run `npm test`.

- [ ] **Step 3: Register the server with Claude Code**

Create `.mcp.json` at the repository root:

```json
{
  "mcpServers": {
    "football-stats": {
      "command": "node",
      "args": ["radar-sport-api-master/mcp-server/server.js"],
      "env": {
        "API_FOOTBALL_KEY": "${API_FOOTBALL_KEY}"
      }
    }
  }
}
```

The key is referenced from the environment, never written into the file.

- [ ] **Step 4: Verify the handshake with a real client**

Restart Claude Code so it picks up `.mcp.json`, then confirm `football-stats` connects and lists eleven tools. Call `get_api_status` (confirms the key reaches the server), then `search_teams` with a team you care about, then `get_team_corner_profile` for that team with `matchCount: 5`.

Expected: a corner breakdown per match with totals and averages, or a clean tool error — never a crash or a hang.

- [ ] **Step 5: Write the README**

Create `mcp-server/README.md` covering: what the server does and its non-goals (no bet placement, no odds-based advice, retrieval only); getting an API-Football key; `npm install`; setting `API_FOOTBALL_KEY`; the `.mcp.json` snippet; a table of all eleven tools with parameters; the environment variables (`API_FOOTBALL_KEY`, `MCP_HTTP_TIMEOUT_MS`, `MCP_CACHE_DIR`, `MCP_MAX_REQUESTS_PER_CALL`); how the cache and the 100/day free quota interact, and why `get_team_corner_profile` is cheap on a warm cache; running `npm test` and `npm run smoke`; and a note that the legacy `index.js` library in the parent directory is **non-functional** because its Sportradar endpoints return 403.

- [ ] **Step 6: Run the full suite one final time**

```bash
cd radar-sport-api-master/mcp-server && npm test
```

Expected: PASS, 41/41.

- [ ] **Step 7: Commit**

```bash
git add mcp-server/smoke.js mcp-server/README.md .mcp.json
git commit -m "feat(mcp): add live smoke test, Claude Code registration and docs"
```

---

## Done criteria

- `npm test` passes 41/41 with no API key and no network access.
- The server completes an MCP handshake and lists eleven tools.
- `get_team_corner_profile` returns a real corner breakdown against the live API.
- The corner-availability question is answered with evidence from the smoke test.

## Follow-up work (not in this plan)

1. **Plan 2** — players and odds tools (`tools/players.js`, `tools/odds.js`) on the finished foundation.
2. **The betting-analysis skill** — the judgment layer telling an agent how to use these tools.
3. **Legacy library disposition** — whether to delete `index.js`/`test.js`, now that their endpoints return 403.