# Corner Slice — Baselines, Ledger and Daily Bulletin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one betting market — corners — end to end: a deterministic baseline computed in the MCP server, an odds-derived market probability, an append-only ledger that records the agent's own probability before kickoff and grades it afterwards, and a scheduled daily bulletin that delivers it.

**Architecture:** Pure mathematics lives in `mcp-server/baselines/` — no network, no clock, no randomness — and is tested against hand-computed values. Impure aggregation (fetching and shaping) lives in `mcp-server/aggregate/`. MCP tools in `mcp-server/tools/` compose the two. The ledger is append-only JSONL under `ledger/`. The daily procedure is a skill, not a prompt.

**Tech Stack:** Node >= 18, CommonJS, `@modelcontextprotocol/sdk`, `zod` for input validation, `axios` via the existing `http.js`, `node:test` as the runner, `nock` for HTTP mocking.

**Spec:** `docs/superpowers/specs/2026-08-17-betting-analyst-system-design.md`

## Global Constraints

- **Plain CommonJS**, Node >= 18, no build step. Match the repo.
- **No tool throws.** Every tool handler wraps its work in `run(label, fn)` from `result.js`; a failing call returns `isError: true`, never crashes the server.
- **The API key is never echoed** into an error message, log line, or cache file. Never log a raw error object — an AxiosError serializes `err.config.headers`, which carries `x-apisports-key`.
- **Pure modules under `baselines/` and `ledger/scoring.js` must not import `http`, `cache`, `provider`, or `fs`, and must not call `Date.now()`, `new Date()`, or `Math.random()`.** Same inputs, same outputs, every time. This is the property the whole design rests on.
- **`ledger/` is git-tracked. `mcp-server/.cache/` is git-ignored.** The ledger is the record; the cache is discardable.
- **Nothing in the ledger is ever rewritten.** Grading appends a settlement record; it never edits a prediction.
- **Empty is not an error.** A successful request matching nothing returns an explicit empty result, as `result.js` already does.
- **No bet placement, no bookmaker authentication, no movement of money.** The agent never decides stake size; it reports a stake in units of a fraction the owner configures.
- **Tests run with `npm test` from `mcp-server/`** (`node --test test/**/*.js`). Every task ends with the full suite green, not just its own test.
- **`edge = agentProbability − 1 / bestPrice`** and **`expectedValue = agentProbability × (bestPrice − 1) − (1 − agentProbability)`**, expected value per unit staked. Fixed here so nothing downstream guesses the convention.

---

### Task 1: Live odds probe

Spec open question 3 asks whether the API quotes corner lines at all. Nothing else in this plan depends on the *answer* — every later task is nock-tested — but the answer decides whether `get_market_probabilities` has real input, so it is probed first. `package.json` already declares `"smoke": "node smoke.js"` but the file does not exist; this task creates it.

**This task requires `API_FOOTBALL_KEY` and spends a handful of live requests.** If the key is not available, mark the task blocked, record that in the spec's open questions, and proceed to Task 2 — the rest of the plan is unaffected.

**Files:**
- Create: `mcp-server/smoke.js`

**Interfaces:**
- Consumes: `provider.fetch`, `provider.ENDPOINTS` from `provider/apiFootball.js`
- Produces: nothing importable. Its output is an answer written into the spec.

- [ ] **Step 1: Write the probe script**

```js
'use strict';

// Manually run, never part of `npm test`: it needs a real key and spends live
// requests. `node smoke.js <fixtureId>`
const provider = require('./provider/apiFootball');
const cache = require('./cache');

async function main() {
  const fixtureId = Number(process.argv[2]);
  if (!Number.isFinite(fixtureId)) {
    console.error('usage: node smoke.js <fixtureId>');
    process.exit(1);
  }
  if (!process.env.API_FOOTBALL_KEY) {
    console.error('API_FOOTBALL_KEY is not set');
    process.exit(1);
  }

  const odds = await provider.fetch(provider.ENDPOINTS.ODDS, { fixture: fixtureId }, cache.TTL.ODDS);
  if (!odds.length) {
    console.log('no odds returned for this fixture');
    return;
  }

  // Print every market name each bookmaker quotes, so the corner market's real
  // name can be read off rather than guessed.
  for (const entry of odds) {
    for (const book of entry.bookmakers || []) {
      const names = (book.bets || []).map((b) => b.name);
      console.log(`${book.name}: ${names.join(' | ')}`);
      for (const bet of book.bets || []) {
        if (/corner/i.test(bet.name)) {
          console.log(`  >> ${bet.name}:`,
            (bet.values || []).map((v) => `${v.value}@${v.odd}`).join(', '));
        }
      }
    }
  }
}

main().catch((err) => {
  console.error('probe failed:', err && err.message ? err.message : String(err));
  process.exit(1);
});
```

- [ ] **Step 2: Add the ODDS endpoint the probe needs**

In `mcp-server/provider/apiFootball.js`, add one line to the `ENDPOINTS` object after `TEAM_STATISTICS`:

```js
  TEAM_STATISTICS: '/teams/statistics',
  ODDS: '/odds'
```

- [ ] **Step 3: Run the probe against a real fixture**

Pick a fixture kicking off in the next two days via the existing `get_fixtures` tool, then:

Run: `cd mcp-server && API_FOOTBALL_KEY=<key> node smoke.js <fixtureId>`
Expected: a list of market names per bookmaker, with any corner market's lines and odds printed after `>>`.

- [ ] **Step 4: Record the finding in the spec**

Edit `docs/superpowers/specs/2026-08-17-betting-analyst-system-design.md`, open question 3: replace it with what the probe found — the exact market name(s), which bookmakers quote them, and which lines. Task 8 needs those names.

If no bookmaker quotes corners, write that down plainly and note the consequence the spec already states: the slice still runs on the baseline alone, with no `marketView` and no edge.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/smoke.js mcp-server/provider/apiFootball.js docs/superpowers/specs/2026-08-17-betting-analyst-system-design.md
git commit -m "chore: add live odds probe and record corner market coverage"
```

---

### Task 2: The `get_odds` tool

**Files:**
- Create: `mcp-server/tools/odds.js`
- Create: `mcp-server/test/odds.test.js`
- Modify: `mcp-server/server.js` (register the new module)

**Interfaces:**
- Consumes: `provider.fetch`, `provider.ENDPOINTS.ODDS`, `cache.TTL.ODDS`, `run` from `result.js`
- Produces: the `get_odds` MCP tool, and `register(server)` from `tools/odds.js`

**`ENDPOINTS.ODDS` is added by Task 1 Step 2, but Task 1 is blocked without an API key.** Before Step 1, check whether `provider/apiFootball.js` already has `ODDS: '/odds'` in its `ENDPOINTS` object; if not, add it exactly as Task 1 Step 2 shows. This task does not depend on Task 1 having run.

- [ ] **Step 1: Write the failing test**

Create `mcp-server/test/odds.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nock = require('nock');

const cache = require('../cache');
const odds = require('../tools/odds');

const BASE = 'https://v3.football.api-sports.io';

function fakeServer() {
  const tools = new Map();
  return { tools, registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
}

function handlers() {
  const server = fakeServer();
  odds.register(server);
  return server.tools;
}

function oddsBody() {
  return {
    errors: [],
    response: [{
      fixture: { id: 1 },
      bookmakers: [{
        id: 8,
        name: 'Bet365',
        bets: [{ name: 'Total Corners', values: [{ value: 'Over 9.5', odd: '1.95' }, { value: 'Under 9.5', odd: '1.85' }] }]
      }]
    }]
  };
}

function soleCacheEntry(dir) {
  const names = fs.readdirSync(dir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f));
  assert.strictEqual(names.length, 1, `expected one cache entry, found: ${fs.readdirSync(dir).join(', ')}`);
  return JSON.parse(fs.readFileSync(path.join(dir, names[0]), 'utf8'));
}

test.beforeEach(() => {
  nock.cleanAll();
  process.env.API_FOOTBALL_KEY = 'test-key-123';
  process.env.MCP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-odds-'));
});

test.afterEach(() => {
  fs.rmSync(process.env.MCP_CACHE_DIR, { recursive: true, force: true });
});

test('get_odds returns the bookmakers for a fixture', async () => {
  nock(BASE).get('/odds').query({ fixture: '1' }).reply(200, oddsBody());

  const result = await handlers().get('get_odds').handler({ fixtureId: 1 });

  assert.ok(!result.isError, result.content[0].text);
  assert.match(result.content[0].text, /Total Corners/);
});

// Odds move continuously before kickoff, so they must expire quickly. Caching
// them permanently would have the agent price a match off yesterday's line.
test('odds are cached with the short odds TTL', async () => {
  nock(BASE).get('/odds').query({ fixture: '1' }).reply(200, oddsBody());

  await handlers().get('get_odds').handler({ fixtureId: 1 });

  const entry = soleCacheEntry(process.env.MCP_CACHE_DIR);
  assert.strictEqual(entry.expiresAt - entry.storedAt, cache.TTL.ODDS);
});

test('a fixture nobody quotes is reported as empty, not as a failure', async () => {
  nock(BASE).get('/odds').query({ fixture: '7' }).reply(200, { errors: [], response: [] });

  const result = await handlers().get('get_odds').handler({ fixtureId: 7 });

  assert.ok(!result.isError, 'no market is not a failure');
  assert.match(result.content[0].text, /"empty": true/);
});

test('a bookmaker filter is passed through', async () => {
  const scope = nock(BASE).get('/odds').query({ fixture: '1', bookmaker: '8' }).reply(200, oddsBody());

  await handlers().get('get_odds').handler({ fixtureId: 1, bookmakerId: 8 });

  assert.ok(scope.isDone());
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mcp-server && node --test test/odds.test.js`
Expected: FAIL — `Cannot find module '../tools/odds'`.

- [ ] **Step 3: Write the tool**

Create `mcp-server/tools/odds.js`:

```js
'use strict';

const { z } = require('zod');
const provider = require('../provider/apiFootball');
const cache = require('../cache');
const { run } = require('../result');

const forceRefresh = z.boolean().optional()
  .describe('Bypass the cache and refetch. Costs requests against the daily quota.');

function register(server) {
  server.registerTool(
    'get_odds',
    {
      title: 'Get pre-match odds',
      description: 'Pre-match odds for one fixture, by bookmaker and market. Cached for 15 '
        + 'minutes because prices move continuously before kickoff. Use '
        + 'get_market_probabilities instead when you want implied probabilities rather than '
        + 'raw prices — it removes the bookmaker margin for you.',
      inputSchema: {
        fixtureId: z.number().int().positive().describe('Fixture ID.'),
        bookmakerId: z.number().int().positive().optional()
          .describe('Restrict to one bookmaker. Omit for every bookmaker quoting the fixture.'),
        forceRefresh
      }
    },
    async ({ fixtureId, bookmakerId, forceRefresh }) =>
      run(`get_odds(${fixtureId})`, () => {
        const params = { fixture: fixtureId };
        if (bookmakerId !== undefined) params.bookmaker = bookmakerId;
        return provider.fetch(provider.ENDPOINTS.ODDS, params, cache.TTL.ODDS, forceRefresh);
      })
  );
}

module.exports = { register };
```

- [ ] **Step 4: Register it on the server**

In `mcp-server/server.js`, add the require after `stats` and the registration after `stats.register(server)`:

```js
const stats = require('./tools/stats');
const odds = require('./tools/odds');
```

```js
stats.register(server);
odds.register(server);
```

- [ ] **Step 5: Run the whole suite**

Run: `cd mcp-server && npm test`
Expected: PASS — the four new tests plus every existing test.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/tools/odds.js mcp-server/test/odds.test.js mcp-server/server.js
git commit -m "feat(mcp): add pre-match odds tool"
```

---

### Task 3: Poisson probabilities (pure)

**Files:**
- Create: `mcp-server/baselines/poisson.js`
- Create: `mcp-server/test/poisson.test.js`

**Interfaces:**
- Consumes: nothing. No imports at all — this is the purest module in the project.
- Produces:
  - `pmf(lambda: number, k: number): number` — P(X = k)
  - `cdf(lambda: number, k: number): number` — P(X ≤ k)
  - `probOver(lambda: number, line: number): number` — P(X > line); throws if `line` is not a half-integer
  - `probUnder(lambda: number, line: number): number` — `1 − probOver`

- [ ] **Step 1: Write the failing test**

Create `mcp-server/test/poisson.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const poisson = require('../baselines/poisson');

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9,
    `${message}: expected ${expected}, got ${actual}`);
}

test('pmf matches hand-computed values', () => {
  // P(X=0 | λ=2) = e^-2
  close(poisson.pmf(2, 0), Math.exp(-2), 'pmf(2,0)');
  // P(X=1 | λ=2) = 2 e^-2
  close(poisson.pmf(2, 1), 2 * Math.exp(-2), 'pmf(2,1)');
  // P(X=2 | λ=2) = 2 e^-2
  close(poisson.pmf(2, 2), 2 * Math.exp(-2), 'pmf(2,2)');
});

test('cdf sums the pmf', () => {
  // P(X<=2 | λ=2) = e^-2 (1 + 2 + 2) = 5 e^-2
  close(poisson.cdf(2, 2), 5 * Math.exp(-2), 'cdf(2,2)');
});

test('probOver at a half line is one minus the cdf below it', () => {
  // Over 2.5 means X >= 3, so 1 - P(X<=2) = 1 - 5 e^-2
  close(poisson.probOver(2, 2.5), 1 - 5 * Math.exp(-2), 'probOver(2, 2.5)');
});

test('over and under are complementary', () => {
  close(poisson.probOver(9.9, 9.5) + poisson.probUnder(9.9, 9.5), 1, 'over + under');
});

// A whole line produces a push, and the ledger has no representation for a
// pushed corner bet. Rejecting it is better than silently pricing it as a loss.
test('a whole line is rejected', () => {
  assert.throws(() => poisson.probOver(9.9, 10), /half-integer/i);
});

test('probOver decreases monotonically as the line rises', () => {
  const lines = [7.5, 8.5, 9.5, 10.5, 11.5];
  const ps = lines.map((l) => poisson.probOver(9.9, l));
  for (let i = 1; i < ps.length; i += 1) {
    assert.ok(ps[i] < ps[i - 1], `P(over ${lines[i]}) must be below P(over ${lines[i - 1]})`);
  }
});

test('a lambda of zero can never clear a line', () => {
  assert.strictEqual(poisson.probOver(0, 0.5), 0);
  assert.strictEqual(poisson.pmf(0, 0), 1);
});

test('a large lambda stays numerically sane', () => {
  const p = poisson.probOver(25, 24.5);
  assert.ok(p > 0.4 && p < 0.6, `expected roughly a half, got ${p}`);
});

test('a negative lambda is rejected', () => {
  assert.throws(() => poisson.pmf(-1, 0), /lambda/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mcp-server && node --test test/poisson.test.js`
Expected: FAIL — `Cannot find module '../baselines/poisson'`.

- [ ] **Step 3: Write the module**

Create `mcp-server/baselines/poisson.js`:

```js
'use strict';

// Pure: no imports, no clock, no randomness. Same inputs, same outputs.

function assertLambda(lambda) {
  if (!Number.isFinite(lambda) || lambda < 0) {
    throw new Error(`lambda must be a finite number >= 0, got ${lambda}`);
  }
}

function pmf(lambda, k) {
  assertLambda(lambda);
  if (!Number.isInteger(k) || k < 0) throw new Error(`k must be an integer >= 0, got ${k}`);
  // Iterative term: term_k = term_{k-1} * lambda / k. Computing lambda^k / k!
  // directly overflows for large k long before the ratio does.
  let term = Math.exp(-lambda);
  for (let i = 1; i <= k; i += 1) term = (term * lambda) / i;
  return term;
}

function cdf(lambda, k) {
  assertLambda(lambda);
  if (!Number.isInteger(k) || k < 0) throw new Error(`k must be an integer >= 0, got ${k}`);
  let term = Math.exp(-lambda);
  let total = term;
  for (let i = 1; i <= k; i += 1) {
    term = (term * lambda) / i;
    total += term;
  }
  return total;
}

// A market line must be a half-integer: "over 9.5" means X >= 10, with no
// ambiguity. A whole line pushes when the total lands on it, and nothing
// downstream can represent a push.
function assertHalfLine(line) {
  if (!Number.isFinite(line) || line <= 0 || (line * 2) % 2 !== 1) {
    throw new Error(`line must be a positive half-integer such as 9.5, got ${line}`);
  }
}

function probOver(lambda, line) {
  assertHalfLine(line);
  return 1 - cdf(lambda, Math.floor(line));
}

function probUnder(lambda, line) {
  return 1 - probOver(lambda, line);
}

module.exports = { pmf, cdf, probOver, probUnder };
```

- [ ] **Step 4: Run the tests**

Run: `cd mcp-server && node --test test/poisson.test.js`
Expected: PASS — nine tests.

- [ ] **Step 5: Run the whole suite**

Run: `cd mcp-server && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/baselines/poisson.js mcp-server/test/poisson.test.js
git commit -m "feat(mcp): add pure Poisson probability module"
```

---

### Task 4: The corner baseline (pure)

Turns two corner profiles into λ values, per-line probabilities, an empirical rate beside each, dispersion, and machine-generated caveats.

**Files:**
- Create: `mcp-server/baselines/corners.js`
- Create: `mcp-server/test/cornerBaseline.test.js`

**Interfaces:**
- Consumes: `probOver` from `baselines/poisson.js`
- Produces:
  - `DEFAULT_LINES: number[]` — `[7.5, 8.5, 9.5, 10.5, 11.5, 12.5]`
  - `MIN_VENUE_SAMPLE: number` — `4`
  - `cornerBaseline(homeProfile, awayProfile, lines?)` → the object shape in Step 3's comment. Each profile is the `{ matches: [{ venue, cornersFor, cornersAgainst }] }` shape `get_team_corner_profile` already returns.

- [ ] **Step 1: Write the failing test**

Create `mcp-server/test/cornerBaseline.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { cornerBaseline, MIN_VENUE_SAMPLE } = require('../baselines/corners');
const poisson = require('../baselines/poisson');

// Six matches per team so the venue split clears MIN_VENUE_SAMPLE nowhere by
// accident: three home, three away. Adjust per test as needed.
function profile(matches) {
  return { matches };
}

function match(venue, cornersFor, cornersAgainst) {
  return { venue, cornersFor, cornersAgainst };
}

// Home team: 4 home matches at 6 for / 4 against. Away team: 4 away matches at
// 5 for / 5 against. Both clear the venue sample, so venue figures are used.
function homeProfile() {
  return profile([
    match('home', 6, 4), match('home', 6, 4), match('home', 6, 4), match('home', 6, 4),
    match('away', 1, 9)
  ]);
}

function awayProfile() {
  return profile([
    match('away', 5, 5), match('away', 5, 5), match('away', 5, 5), match('away', 5, 5),
    match('home', 12, 1)
  ]);
}

test('lambdas blend one team\'s attack with the other\'s concession, by venue', () => {
  const b = cornerBaseline(homeProfile(), awayProfile());

  // λ_home = (home's for-at-home 6 + away's against-when-away 5) / 2 = 5.5
  assert.strictEqual(b.lambda.home, 5.5);
  // λ_away = (away's for-when-away 5 + home's against-at-home 4) / 2 = 4.5
  assert.strictEqual(b.lambda.away, 4.5);
  assert.strictEqual(b.lambda.total, 10);
});

test('each line carries a parametric and an empirical probability', () => {
  const b = cornerBaseline(homeProfile(), awayProfile());
  const line95 = b.lines.find((l) => l.line === 9.5);

  // Tolerance is 1e-4, not 1e-9: the module rounds published probabilities to
  // four places on purpose, so the test must accept the rounding.
  assert.ok(Math.abs(line95.overProbability - poisson.probOver(10, 9.5)) < 1e-4,
    'the parametric figure must come from Poisson at lambda.total');
  // Pooled totals: home team 10,10,10,10,10 and away team 10,10,10,10,13.
  // Nine of ten matches totalled 10, which clears 9.5; one totalled 13.
  assert.strictEqual(line95.empiricalOverRate, 1);
  assert.strictEqual(line95.empiricalSample, 10);
});

test('over and under sum to one on every line', () => {
  for (const line of cornerBaseline(homeProfile(), awayProfile()).lines) {
    assert.ok(Math.abs(line.overProbability + line.underProbability - 1) < 1e-9,
      `line ${line.line} probabilities must sum to 1`);
  }
});

test('dispersion reports the pooled mean, variance and their ratio', () => {
  const b = cornerBaseline(homeProfile(), awayProfile());

  // Totals: 10 nine times and 13 once. Mean = 103/10 = 10.3.
  assert.strictEqual(b.dispersion.mean, 10.3);
  assert.ok(b.dispersion.variance > 0, 'a sample with a 13 in it is not degenerate');
  assert.ok(Math.abs(b.dispersion.ratio - b.dispersion.variance / b.dispersion.mean) < 1e-9);
});

test('a thin venue sample falls back to all matches and says so', () => {
  const thin = profile([match('home', 6, 4), match('away', 8, 2)]);

  const b = cornerBaseline(thin, awayProfile());

  // Only one home match, below MIN_VENUE_SAMPLE, so all matches are used:
  // for = (6+8)/2 = 7, against = (4+2)/2 = 3.
  assert.strictEqual(b.lambda.home, (7 + 5) / 2);
  assert.ok(b.caveats.some((c) => /venue sample/i.test(c) && /home/i.test(c)),
    `expected a venue-sample caveat, got: ${b.caveats.join(' | ')}`);
});

test('the standing simplifications are always declared', () => {
  const b = cornerBaseline(homeProfile(), awayProfile());

  assert.ok(b.caveats.some((c) => /league/i.test(c)), 'no league normalisation must be declared');
  assert.ok(b.caveats.some((c) => /recency|weighting/i.test(c)), 'equal weighting must be declared');
});

test('a profile with no matches is refused rather than priced', () => {
  assert.throws(() => cornerBaseline(profile([]), awayProfile()), /no matches/i);
});

test('MIN_VENUE_SAMPLE is exported so callers can explain the fallback', () => {
  assert.strictEqual(MIN_VENUE_SAMPLE, 4);
});

test('custom lines are honoured', () => {
  const b = cornerBaseline(homeProfile(), awayProfile(), [8.5]);

  assert.strictEqual(b.lines.length, 1);
  assert.strictEqual(b.lines[0].line, 8.5);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mcp-server && node --test test/cornerBaseline.test.js`
Expected: FAIL — `Cannot find module '../baselines/corners'`.

- [ ] **Step 3: Write the module**

Create `mcp-server/baselines/corners.js`:

```js
'use strict';

const poisson = require('./poisson');

const DEFAULT_LINES = [7.5, 8.5, 9.5, 10.5, 11.5, 12.5];

// Below this many matches at a venue, the venue split is noise and all matches
// are used instead. Five home games is already a thin sample; three is a guess.
const MIN_VENUE_SAMPLE = 4;

function round(n, places = 2) {
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
}

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Returns the venue-filtered mean when the sample is large enough, otherwise
// the all-matches mean plus the caveat explaining the fallback.
function venueMean(matches, venue, pick, label, caveats) {
  const atVenue = matches.filter((m) => m.venue === venue);
  if (atVenue.length >= MIN_VENUE_SAMPLE) return mean(atVenue.map(pick));
  caveats.push(`${label}: venue sample at ${venue} is ${atVenue.length}, `
    + `below ${MIN_VENUE_SAMPLE}; used all ${matches.length} matches instead`);
  return mean(matches.map(pick));
}

function assertHasMatches(profile, label) {
  if (!profile || !Array.isArray(profile.matches) || profile.matches.length === 0) {
    throw new Error(`${label} has no matches to compute a baseline from`);
  }
}

/**
 * Returns:
 *   { lambda: { home, away, total },
 *     model: 'poisson',
 *     lines: [{ line, overProbability, underProbability,
 *               empiricalOverRate, empiricalSample }],
 *     dispersion: { mean, variance, ratio },
 *     sample: { home: n, away: n, pooled: n },
 *     caveats: string[] }
 */
function cornerBaseline(homeProfile, awayProfile, lines = DEFAULT_LINES) {
  assertHasMatches(homeProfile, 'home team');
  assertHasMatches(awayProfile, 'away team');

  const caveats = [
    'no league normalisation: team rates are used raw, not adjusted to the league average',
    'equal weighting across matches, with no recency decay'
  ];

  const forCorners = (m) => m.cornersFor;
  const againstCorners = (m) => m.cornersAgainst;

  const homeForAtHome = venueMean(homeProfile.matches, 'home', forCorners, 'home team', caveats);
  const homeAgainstAtHome = venueMean(homeProfile.matches, 'home', againstCorners, 'home team', caveats);
  const awayForAway = venueMean(awayProfile.matches, 'away', forCorners, 'away team', caveats);
  const awayAgainstAway = venueMean(awayProfile.matches, 'away', againstCorners, 'away team', caveats);

  const lambdaHome = (homeForAtHome + awayAgainstAway) / 2;
  const lambdaAway = (awayForAway + homeAgainstAtHome) / 2;
  const lambdaTotal = lambdaHome + lambdaAway;

  // The empirical check pools both teams' match totals. It double-counts any
  // fixture the two played against each other, which is at most one or two
  // matches and is declared rather than corrected.
  const pooledTotals = [...homeProfile.matches, ...awayProfile.matches]
    .map((m) => m.cornersFor + m.cornersAgainst);
  caveats.push('empirical rate pools both teams\' matches, so a head-to-head meeting counts twice');

  const pooledMean = mean(pooledTotals);
  const variance = pooledTotals.length > 1
    ? pooledTotals.reduce((acc, t) => acc + (t - pooledMean) ** 2, 0) / (pooledTotals.length - 1)
    : 0;

  return {
    lambda: { home: round(lambdaHome), away: round(lambdaAway), total: round(lambdaTotal) },
    model: 'poisson',
    lines: lines.map((line) => {
      const over = poisson.probOver(lambdaTotal, line);
      return {
        line,
        overProbability: round(over, 4),
        underProbability: round(1 - over, 4),
        empiricalOverRate: round(
          pooledTotals.filter((t) => t > line).length / pooledTotals.length, 4),
        empiricalSample: pooledTotals.length
      };
    }),
    dispersion: {
      mean: round(pooledMean),
      variance: round(variance),
      ratio: pooledMean === 0 ? null : round(variance / pooledMean)
    },
    sample: {
      home: homeProfile.matches.length,
      away: awayProfile.matches.length,
      pooled: pooledTotals.length
    },
    caveats
  };
}

module.exports = { cornerBaseline, DEFAULT_LINES, MIN_VENUE_SAMPLE };
```

- [ ] **Step 4: Run the tests**

Run: `cd mcp-server && node --test test/cornerBaseline.test.js`
Expected: PASS — nine tests.

- [ ] **Step 5: Run the whole suite**

Run: `cd mcp-server && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/baselines/corners.js mcp-server/test/cornerBaseline.test.js
git commit -m "feat(mcp): add pure corner baseline with empirical check and caveats"
```

---

### Task 5: Extract the corner profile into a reusable aggregate

`get_team_corner_profile`'s logic currently lives inline in its handler in `tools/stats.js:121-211`. Task 6 needs to call it twice — once per team — without going through the MCP tool layer. This task moves the logic and changes no behaviour: the existing tests in `test/stats.test.js` must stay green untouched.

**Files:**
- Create: `mcp-server/aggregate/cornerProfile.js`
- Modify: `mcp-server/tools/stats.js` (delete the moved code, call the new module)
- Modify: `mcp-server/test/stats.test.js` (only if a require path needs it — expect no change)

**Interfaces:**
- Consumes: `provider.fetch`, `provider.isFinished`, `provider.countUncached`, `cache.TTL`, `quota.maxRequestsPerCall`
- Produces:
  - `cornerProfile(teamId: number, matchCount: number, forceRefresh?: boolean)` → the same object the tool returns today: `{ teamId, matchesAnalyzed, matches, totals, averages, failures }`, or `{ teamId, matchesAnalyzed: 0, matches: [], failures: [], note }` when nothing is finished. Throws when the per-call ceiling would be exceeded.
  - `cornerValue(entries: object[], teamId: number): number | null` — Task 11 reuses this to read a settled match's corners.
  - `fetchStatistics(fixtureId, force, ttl)`, `statisticsTtl(data)`, `statisticsParams(fixtureId)` — used by `tools/stats.js` and Task 11.

- [ ] **Step 1: Create the aggregate module by moving code verbatim**

Create `mcp-server/aggregate/cornerProfile.js` containing, moved unchanged from `tools/stats.js`: the `CORNER_TYPE`, `CONCURRENCY`, `DEFAULT_MATCH_COUNT` and `MAX_MATCH_COUNT` constants; `statisticsParams`, `fetchStatistics`, `statisticsTtl`, `cornerValue` and `mapWithConcurrency`; and the body of the `get_team_corner_profile` handler wrapped as a function:

```js
'use strict';

const provider = require('../provider/apiFootball');
const cache = require('../cache');
const quota = require('../quota');

const CORNER_TYPE = 'Corner Kicks';
const CONCURRENCY = 3;
const DEFAULT_MATCH_COUNT = 10;
const MAX_MATCH_COUNT = 20;

// --- moved verbatim from tools/stats.js, comments included ---
// statisticsParams, fetchStatistics, statisticsTtl, cornerValue, mapWithConcurrency

async function cornerProfile(teamId, matchCount, forceRefresh) {
  // The former handler body, unchanged: fixtures fetch, finished filter,
  // ceiling check, concurrent statistics fetch, sort, totals, averages.
}

module.exports = {
  cornerProfile,
  cornerValue,
  fetchStatistics,
  statisticsTtl,
  statisticsParams,
  CORNER_TYPE,
  DEFAULT_MATCH_COUNT,
  MAX_MATCH_COUNT
};
```

Move the code — do not retype it. Every comment in the original explains a bug that was already fixed once; losing them re-opens it.

- [ ] **Step 2: Rewrite `tools/stats.js` to delegate**

`tools/stats.js` keeps its three `registerTool` calls and loses everything else. Its `get_team_corner_profile` handler becomes:

```js
    async ({ teamId, matchCount, forceRefresh }) =>
      run(`get_team_corner_profile(${teamId})`, () =>
        aggregate.cornerProfile(teamId, matchCount, forceRefresh))
```

with `const aggregate = require('../aggregate/cornerProfile');` at the top, and `get_fixture_statistics` calling `aggregate.fetchStatistics(fixtureId, forceRefresh, aggregate.statisticsTtl)`. Import `DEFAULT_MATCH_COUNT` and `MAX_MATCH_COUNT` from the aggregate for the zod schema so the numbers are declared once.

- [ ] **Step 3: Run the existing tests unchanged**

Run: `cd mcp-server && node --test test/stats.test.js`
Expected: PASS — all thirteen existing tests, with no edits to the test file. This is the whole point of the task: a refactor that any test change would disguise.

- [ ] **Step 4: Run the whole suite**

Run: `cd mcp-server && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/aggregate/cornerProfile.js mcp-server/tools/stats.js
git commit -m "refactor(mcp): extract the corner profile into a reusable aggregate"
```

---

### Task 5b: The cross-season window (inserted 2026-08-17)

Not in the original plan. The spec gained *The cross-season window* after the watchlist was
resolved, and the resolution exposed the problem: four of the eight leagues had not kicked off, so
their profiles are built almost entirely on last season's matches. The baseline must report the
split rather than present a stale figure as current.

- [x] `aggregate/cornerProfile.js` records `season` on every match, read from `fixture.league.season`.
- [x] `cornerBaseline` takes a fourth argument, `options.currentSeason`, and returns
  `sampleSeasons: { home: { current, previous }, away: { … } } | null`.
- [x] A sample crossing the boundary emits a caveat. A sample wholly inside the current season does
  not. **No `currentSeason` supplied returns `null` and says the mix was not checked** — claiming
  the sample is current when nobody said what current means would be a fabricated reassurance.
- [x] The caveat says "not from season X — previous seasons or unrecorded" rather than naming a
  year: a match whose season was never recorded is unknown, and naming a year it might not be from
  would be false.

Task 6 supplies `currentSeason` from the fixture being priced.

---

### Task 6: The `get_corner_baseline` tool

**Files:**
- Create: `mcp-server/tools/baselines.js`
- Create: `mcp-server/test/cornerBaselineTool.test.js`
- Modify: `mcp-server/server.js`

**Interfaces:**
- Consumes: `aggregate.cornerProfile` (Task 5), `cornerBaseline` (Task 4), `provider.fetch`, `run`
- Produces: the `get_corner_baseline` MCP tool; `register(server)` from `tools/baselines.js`, which Tasks 8 and 9 extend

- [ ] **Step 1: Write the failing test**

Create `mcp-server/test/cornerBaselineTool.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nock = require('nock');

const baselines = require('../tools/baselines');

const BASE = 'https://v3.football.api-sports.io';

function fakeServer() {
  const tools = new Map();
  return { tools, registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
}

function handlers() {
  const server = fakeServer();
  baselines.register(server);
  return server.tools;
}

function finishedFixture(id, homeId, awayId) {
  return {
    fixture: { id, status: { short: 'FT' }, date: `2026-08-${String(id).padStart(2, '0')}T12:00:00+00:00` },
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

// The upcoming fixture whose baseline is asked for: 33 at home to 34.
function upcomingFixture() {
  return {
    errors: [],
    response: [{
      fixture: { id: 500, status: { short: 'NS' }, date: '2026-08-22T19:00:00+00:00' },
      league: { id: 94, name: 'Primeira Liga' },
      teams: { home: { id: 33, name: 'Home FC' }, away: { id: 34, name: 'Away FC' } }
    }]
  };
}

// Four finished matches per team, all at the relevant venue, so no fallback.
function mockTeam(teamId, opponentId, venue, forCorners, againstCorners) {
  const ids = venue === 'home' ? [11, 12, 13, 14] : [21, 22, 23, 24];
  const offset = teamId * 100;
  const fixtures = ids.map((i) => (venue === 'home'
    ? finishedFixture(i + offset, teamId, opponentId)
    : finishedFixture(i + offset, opponentId, teamId)));

  nock(BASE).get('/fixtures').query({ team: String(teamId), last: '4' })
    .reply(200, { errors: [], response: fixtures });

  for (const f of fixtures) {
    const id = f.fixture.id;
    nock(BASE).get('/fixtures/statistics').query({ fixture: String(id) })
      .reply(200, venue === 'home'
        ? statsFor(teamId, opponentId, forCorners, againstCorners)
        : statsFor(opponentId, teamId, againstCorners, forCorners));
  }
}

test.beforeEach(() => {
  nock.cleanAll();
  process.env.API_FOOTBALL_KEY = 'test-key-123';
  process.env.MCP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-baseline-'));
});

test.afterEach(() => {
  fs.rmSync(process.env.MCP_CACHE_DIR, { recursive: true, force: true });
});

test('get_corner_baseline resolves the fixture and blends both profiles', async () => {
  nock(BASE).get('/fixtures').query({ id: '500' }).reply(200, upcomingFixture());
  mockTeam(33, 34, 'home', 6, 4);
  mockTeam(34, 33, 'away', 5, 5);

  const result = await handlers().get('get_corner_baseline').handler({ fixtureId: 500, matchCount: 4 });

  assert.ok(!result.isError, result.content[0].text);
  const body = JSON.parse(result.content[0].text);
  assert.strictEqual(body.fixture.id, 500);
  assert.strictEqual(body.fixture.home, 'Home FC');
  assert.strictEqual(body.lambda.home, 5.5);
  assert.strictEqual(body.lambda.away, 4.5);
  assert.strictEqual(body.lambda.total, 10);
  assert.ok(body.lines.length > 0, 'lines must be priced');
  assert.ok(body.caveats.length > 0, 'simplifications must be declared');
});

test('a fixture with no corner data anywhere is an error, not a fabricated baseline', async () => {
  nock(BASE).get('/fixtures').query({ id: '500' }).reply(200, upcomingFixture());
  nock(BASE).get('/fixtures').query({ team: '33', last: '4' }).reply(200, { errors: [], response: [] });
  nock(BASE).get('/fixtures').query({ team: '34', last: '4' }).reply(200, { errors: [], response: [] });

  const result = await handlers().get('get_corner_baseline').handler({ fixtureId: 500, matchCount: 4 });

  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /no matches/i);
});

test('an unknown fixture id reports that, not a crash', async () => {
  nock(BASE).get('/fixtures').query({ id: '999' }).reply(200, { errors: [], response: [] });

  const result = await handlers().get('get_corner_baseline').handler({ fixtureId: 999, matchCount: 4 });

  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /fixture 999/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mcp-server && node --test test/cornerBaselineTool.test.js`
Expected: FAIL — `Cannot find module '../tools/baselines'`.

- [ ] **Step 3: Write the tool**

Create `mcp-server/tools/baselines.js`:

```js
'use strict';

const { z } = require('zod');
const provider = require('../provider/apiFootball');
const cache = require('../cache');
const aggregate = require('../aggregate/cornerProfile');
const { cornerBaseline, DEFAULT_LINES } = require('../baselines/corners');
const { run } = require('../result');

const forceRefresh = z.boolean().optional()
  .describe('Bypass the cache and refetch. Costs requests against the daily quota.');

async function resolveFixture(fixtureId, force) {
  const found = await provider.fetch(provider.ENDPOINTS.FIXTURES,
    { id: fixtureId }, cache.TTL.LIVE, force);
  if (!found.length) throw new Error(`fixture ${fixtureId} was not found`);
  const f = found[0];
  return {
    id: f.fixture.id,
    kickoff: f.fixture.date,
    league: f.league ? f.league.name : null,
    leagueId: f.league ? f.league.id : null,
    home: f.teams.home.name,
    homeId: f.teams.home.id,
    away: f.teams.away.name,
    awayId: f.teams.away.id
  };
}

function register(server) {
  server.registerTool(
    'get_corner_baseline',
    {
      title: 'Get the corner baseline for a fixture',
      description: 'A deterministic corner baseline for one upcoming fixture. Blends each team\'s '
        + 'corners-for with the opponent\'s corners-against, split by venue, into a Poisson '
        + 'expectation, and prices every standard line. Returns the empirical rate beside each '
        + 'parametric probability and declares its own simplifications in `caveats` — read them. '
        + 'This is arithmetic, not a recommendation: it has no view on whether the price is worth '
        + 'taking.',
      inputSchema: {
        fixtureId: z.number().int().positive().describe('Fixture ID of the upcoming match.'),
        matchCount: z.number().int().min(1).max(aggregate.MAX_MATCH_COUNT)
          .default(aggregate.DEFAULT_MATCH_COUNT)
          .describe(`Recent finished matches per team (default ${aggregate.DEFAULT_MATCH_COUNT}, `
            + `max ${aggregate.MAX_MATCH_COUNT}).`),
        lines: z.array(z.number()).optional()
          .describe(`Market lines to price. Defaults to ${DEFAULT_LINES.join(', ')}.`),
        forceRefresh
      }
    },
    async ({ fixtureId, matchCount, lines, forceRefresh }) =>
      run(`get_corner_baseline(${fixtureId})`, async () => {
        const fixture = await resolveFixture(fixtureId, forceRefresh);

        // Sequential, not parallel: cornerProfile already runs its statistics
        // fetches at a concurrency of 3, and each checks the per-call ceiling
        // against a cache the other is still filling.
        //
        // Each profile enforces the ceiling for its own team, so a baseline is
        // bounded by twice MCP_MAX_REQUESTS_PER_CALL rather than once. That is
        // still a bound, and a combined pre-count would need an extra fixtures
        // request per team to compute.
        const homeProfile = await aggregate.cornerProfile(fixture.homeId, matchCount, forceRefresh);
        const awayProfile = await aggregate.cornerProfile(fixture.awayId, matchCount, forceRefresh);

        const baseline = cornerBaseline(homeProfile, awayProfile, lines || DEFAULT_LINES);

        return {
          fixture,
          ...baseline,
          profiles: {
            home: { matchesAnalyzed: homeProfile.matchesAnalyzed, averages: homeProfile.averages },
            away: { matchesAnalyzed: awayProfile.matchesAnalyzed, averages: awayProfile.averages }
          }
        };
      })
  );
}

module.exports = { register };
```

- [ ] **Step 4: Register it on the server**

In `mcp-server/server.js`, mirror what Task 2 did for odds:

```js
const baselines = require('./tools/baselines');
```

```js
baselines.register(server);
```

- [ ] **Step 5: Run the whole suite**

Run: `cd mcp-server && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/tools/baselines.js mcp-server/test/cornerBaselineTool.test.js mcp-server/server.js
git commit -m "feat(mcp): add corner baseline tool"
```

---

### Task 7: De-vigging and consensus (pure)

**Files:**
- Create: `mcp-server/baselines/devig.js`
- Create: `mcp-server/test/devig.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `impliedProbability(odd: number): number`
  - `overround(odds: number[]): number`
  - `fairProbabilities(odds: number[]): number[]` — proportional de-vig, sums to 1
  - `median(values: number[]): number`
  - `bestPrice(quotes: {bookmaker: string, odd: number}[]): {bookmaker, odd}`

- [ ] **Step 1: Write the failing test**

Create `mcp-server/test/devig.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const devig = require('../baselines/devig');

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
}

test('implied probability is the reciprocal of the price', () => {
  close(devig.impliedProbability(2), 0.5, 'even money');
  close(devig.impliedProbability(1.95), 1 / 1.95, '1.95');
});

test('overround is what the two sides sum to above one', () => {
  // 1/1.95 + 1/1.85 = 0.512820... + 0.540540... = 1.053361...
  close(devig.overround([1.95, 1.85]), 1 / 1.95 + 1 / 1.85 - 1, 'two-way overround');
});

test('a fair book has no overround', () => {
  close(devig.overround([2, 2]), 0, 'two evens');
});

test('fair probabilities sum to one and keep their ordering', () => {
  const fair = devig.fairProbabilities([1.95, 1.85]);

  close(fair[0] + fair[1], 1, 'de-vigged sum');
  assert.ok(fair[1] > fair[0], 'the shorter price must carry the larger probability');
  close(fair[0], (1 / 1.95) / (1 / 1.95 + 1 / 1.85), 'proportional de-vig');
});

test('median takes the middle of an odd-length sample', () => {
  assert.strictEqual(devig.median([0.5, 0.52, 0.55]), 0.52);
});

test('median averages the two middles of an even-length sample', () => {
  assert.strictEqual(devig.median([0.5, 0.52, 0.54, 0.56]), 0.53);
});

test('median does not mutate its input', () => {
  const input = [0.6, 0.4, 0.5];
  devig.median(input);
  assert.deepStrictEqual(input, [0.6, 0.4, 0.5], 'sorting must happen on a copy');
});

test('bestPrice picks the highest odd and names the bookmaker', () => {
  const best = devig.bestPrice([
    { bookmaker: 'A', odd: 1.9 },
    { bookmaker: 'B', odd: 2.05 },
    { bookmaker: 'C', odd: 1.95 }
  ]);

  assert.strictEqual(best.bookmaker, 'B');
  assert.strictEqual(best.odd, 2.05);
});

test('an odd of one or less is rejected', () => {
  assert.throws(() => devig.impliedProbability(1), /decimal odd/i);
  assert.throws(() => devig.impliedProbability(0), /decimal odd/i);
});

test('an empty quote list has no best price', () => {
  assert.throws(() => devig.bestPrice([]), /no quotes/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mcp-server && node --test test/devig.test.js`
Expected: FAIL — `Cannot find module '../baselines/devig'`.

- [ ] **Step 3: Write the module**

Create `mcp-server/baselines/devig.js`:

```js
'use strict';

// Pure: no imports, no clock, no randomness.

function assertOdd(odd) {
  // A decimal odd of 1 pays nothing back beyond the stake, and below 1 is not a
  // price at all. Either means the input is corrupt, not that the bet is bad.
  if (!Number.isFinite(odd) || odd <= 1) {
    throw new Error(`decimal odd must be a finite number above 1, got ${odd}`);
  }
}

function impliedProbability(odd) {
  assertOdd(odd);
  return 1 / odd;
}

function overround(odds) {
  return odds.reduce((acc, o) => acc + impliedProbability(o), 0) - 1;
}

// Proportional de-vig: divide each raw implied probability by their sum. For a
// two-outcome market this is adequate. Methods that weight the favourite and
// the longshot differently (Shin) assume a bias that cannot be verified without
// a settled history; revisit once the ledger provides one.
function fairProbabilities(odds) {
  const raw = odds.map(impliedProbability);
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((p) => p / sum);
}

function median(values) {
  if (!values.length) throw new Error('median of an empty sample is undefined');
  // Copy before sorting: callers pass arrays they still need in their original
  // order, and Array.prototype.sort mutates in place.
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function bestPrice(quotes) {
  if (!quotes || !quotes.length) throw new Error('no quotes to pick a best price from');
  return quotes.reduce((best, q) => (q.odd > best.odd ? q : best));
}

module.exports = { impliedProbability, overround, fairProbabilities, median, bestPrice };
```

- [ ] **Step 4: Run the tests**

Run: `cd mcp-server && node --test test/devig.test.js`
Expected: PASS — ten tests.

- [ ] **Step 5: Run the whole suite**

Run: `cd mcp-server && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/baselines/devig.js mcp-server/test/devig.test.js
git commit -m "feat(mcp): add pure de-vigging and consensus module"
```

---

### Task 8: The `get_market_probabilities` tool

Parses the corner market out of an odds response and returns, per line, each bookmaker's fair probability, the consensus median, and the best available price.

**Before starting:** read what Task 1 recorded in the spec's open question 3. If it named the corner market differently from `Total Corners`, add that name to `CORNER_MARKET_PATTERNS` below. If Task 1 was blocked, implement as written — the patterns are a list precisely so a name can be added without touching anything else.

**Files:**
- Create: `mcp-server/aggregate/cornerOdds.js`
- Create: `mcp-server/test/marketProbabilities.test.js`
- Modify: `mcp-server/tools/baselines.js` (add the second tool)

**Interfaces:**
- Consumes: `provider.fetch`, `cache.TTL.ODDS`, `devig` (Task 7)
- Produces:
  - `parseCornerQuotes(oddsResponse: object[])` → `[{ line, over: [{bookmaker, odd}], under: [{bookmaker, odd}] }]`
  - `CORNER_MARKET_PATTERNS: RegExp[]`
  - the `get_market_probabilities` MCP tool

- [ ] **Step 1: Write the failing test**

Create `mcp-server/test/marketProbabilities.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nock = require('nock');

const { parseCornerQuotes } = require('../aggregate/cornerOdds');
const baselines = require('../tools/baselines');

const BASE = 'https://v3.football.api-sports.io';

function fakeServer() {
  const tools = new Map();
  return { tools, registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
}

function handlers() {
  const server = fakeServer();
  baselines.register(server);
  return server.tools;
}

// 'Corners Over Under' is the exact full-match total name the Task 1 probe
// found. Do not loosen it in these fixtures — the anchoring is the point.
function book(name, overOdd, underOdd, marketName = 'Corners Over Under') {
  return {
    id: 1,
    name,
    bets: [{
      name: marketName,
      values: [{ value: 'Over 9.5', odd: String(overOdd) }, { value: 'Under 9.5', odd: String(underOdd) }]
    }]
  };
}

function oddsBody(bookmakers) {
  return { errors: [], response: [{ fixture: { id: 500 }, bookmakers }] };
}

test.beforeEach(() => {
  nock.cleanAll();
  process.env.API_FOOTBALL_KEY = 'test-key-123';
  process.env.MCP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-market-'));
});

test.afterEach(() => {
  fs.rmSync(process.env.MCP_CACHE_DIR, { recursive: true, force: true });
});

test('parseCornerQuotes groups both sides by line', () => {
  const quotes = parseCornerQuotes(oddsBody([book('A', 1.95, 1.85)]).response);

  assert.strictEqual(quotes.length, 1);
  assert.strictEqual(quotes[0].line, 9.5);
  assert.deepStrictEqual(quotes[0].over, [{ bookmaker: 'A', odd: 1.95 }]);
  assert.deepStrictEqual(quotes[0].under, [{ bookmaker: 'A', odd: 1.85 }]);
});

test('parseCornerQuotes ignores markets that are not about corners', () => {
  const body = oddsBody([{
    id: 1,
    name: 'A',
    bets: [{ name: 'Match Winner', values: [{ value: 'Home', odd: '2.10' }] }]
  }]);

  assert.deepStrictEqual(parseCornerQuotes(body.response), []);
});

// The live probe found ten adjacent markets whose names contain "corners" but
// which are different bets. Pooling any of them into the full-match buckets
// would back the wrong selection — silently, with a plausible-looking line.
test('parseCornerQuotes rejects every adjacent corner market', () => {
  const adjacent = [
    'Home Corners Over/Under', 'Away Corners Over/Under', 'Total Corners (3 way)',
    'Total Corners (1st Half)', 'Corners 1x2', 'Corners Asian Handicap',
    'Corners. Odd/Even', 'Corners. Total (Range)', 'Corners Race To', 'Multicorners',
    'Corners. European Handicap'
  ];

  for (const marketName of adjacent) {
    const quotes = parseCornerQuotes(oddsBody([book('A', 1.95, 1.85, marketName)]).response);
    assert.deepStrictEqual(quotes, [], `${marketName} must not be read as the full-match total`);
  }
});

test('parseCornerQuotes accepts the exact full-match total name', () => {
  const quotes = parseCornerQuotes(oddsBody([book('A', 1.95, 1.85, 'Corners Over Under')]).response);

  assert.strictEqual(quotes.length, 1);
  assert.strictEqual(quotes[0].line, 9.5);
});

// Pinnacle quotes whole lines alongside half lines. A whole line pushes when the
// total lands on it, and nothing downstream can represent a push.
test('parseCornerQuotes drops whole lines and keeps half lines', () => {
  const body = oddsBody([{
    id: 1,
    name: 'Pinnacle',
    bets: [{
      name: 'Corners Over Under',
      values: [
        { value: 'Over 9', odd: '1.49' }, { value: 'Under 9', odd: '2.47' },
        { value: 'Over 9.5', odd: '1.67' }, { value: 'Under 9.5', odd: '2.15' }
      ]
    }]
  }]);

  const quotes = parseCornerQuotes(body.response);

  assert.deepStrictEqual(quotes.map((q) => q.line), [9.5]);
});

test('parseCornerQuotes skips an unparseable value rather than guessing it', () => {
  const body = oddsBody([{
    id: 1,
    name: 'A',
    bets: [{
      name: 'Corners Over Under',
      values: [{ value: 'Yes', odd: '1.90' }, { value: 'Over 9.5', odd: '1.95' }]
    }]
  }]);

  const quotes = parseCornerQuotes(body.response);
  assert.strictEqual(quotes.length, 1);
  assert.strictEqual(quotes[0].over.length, 1);
  assert.strictEqual(quotes[0].under.length, 0);
});

test('get_market_probabilities de-vigs each book and takes a consensus', async () => {
  nock(BASE).get('/odds').query({ fixture: '500' })
    .reply(200, oddsBody([book('A', 1.95, 1.85), book('B', 2.05, 1.78), book('C', 1.90, 1.90)]));

  const result = await handlers().get('get_market_probabilities').handler({ fixtureId: 500 });

  assert.ok(!result.isError, result.content[0].text);
  const body = JSON.parse(result.content[0].text);
  const line = body.lines.find((l) => l.line === 9.5);

  assert.strictEqual(line.bookmakers.length, 3);
  assert.strictEqual(line.bestPrice.over.bookmaker, 'B');
  assert.strictEqual(line.bestPrice.over.odd, 2.05);
  // Fair over probabilities: A (1.95/1.85) = 0.4868, B (2.05/1.78) = 0.4648,
  // C (1.90/1.90) = 0.5000. Sorted, A is the middle one, so A is the median —
  // C sits at the top of the range, not in the middle of it.
  assert.strictEqual(line.consensus.overProbability, 0.4868);
  assert.strictEqual(line.consensus.underProbability, 0.5132);
  assert.ok(line.overround > 0, 'the raw book must carry a margin');
});

test('a line quoted by only one side is reported without a de-vigged consensus', async () => {
  nock(BASE).get('/odds').query({ fixture: '500' }).reply(200, oddsBody([{
    id: 1,
    name: 'A',
    bets: [{ name: 'Total Corners', values: [{ value: 'Over 9.5', odd: '1.95' }] }]
  }]));

  const result = await handlers().get('get_market_probabilities').handler({ fixtureId: 500 });

  const body = JSON.parse(result.content[0].text);
  const line = body.lines.find((l) => l.line === 9.5);
  assert.strictEqual(line.consensus, null,
    'a one-sided quote cannot be de-vigged, and a guess would be worse than nothing');
  assert.strictEqual(line.bestPrice.over.odd, 1.95);
});

test('a fixture with no corner market is empty, not an error', async () => {
  nock(BASE).get('/odds').query({ fixture: '500' }).reply(200, oddsBody([{
    id: 1, name: 'A', bets: [{ name: 'Match Winner', values: [{ value: 'Home', odd: '2.10' }] }]
  }]));

  const result = await handlers().get('get_market_probabilities').handler({ fixtureId: 500 });

  assert.ok(!result.isError, 'no corner market is a fact about the market, not a failure');
  assert.match(result.content[0].text, /"empty": true|no corner market/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mcp-server && node --test test/marketProbabilities.test.js`
Expected: FAIL — `Cannot find module '../aggregate/cornerOdds'`.

- [ ] **Step 3: Write the parser**

Create `mcp-server/aggregate/cornerOdds.js`:

```js
'use strict';

// Confirmed by the Task 1 live probe (2026-08-17): the full-match corner
// total over/under market is named exactly "Corners Over Under", quoted by
// 10Bet, Bet365, Marathonbet, Unibet and Pinnacle.
//
// ANCHORED, not loose. The same response carries "Home Corners Over/Under",
// "Away Corners Over/Under", "Total Corners (3 way)", "Total Corners
// (1st Half)", "Corners 1x2", "Corners Asian Handicap", "Corners. Odd/Even",
// "Corners. Total (Range)", "Corners Race To", "Multicorners" and "Corners.
// European Handicap". Those are different bets. A loose /corner.*over.*under/
// would pool a per-team 2.5 line and a first-half 4.5 line into the full-match
// buckets and back the wrong selection.
const CORNER_MARKET_PATTERNS = [
  /^corners?\s+over\s*\/?\s*under$/i
];

// Second layer, deliberately redundant with the anchors above: if a new
// bookmaker name ever slips past them, these keywords still keep a non-total
// market out. Belt and braces, because the failure mode is a silently wrong bet
// rather than a crash.
const NOT_FULL_MATCH_TOTAL = [
  /\bhome\b/i, /\baway\b/i, /\bhalf\b/i, /3\s*way/i, /handicap/i,
  /odd\s*\/?\s*even/i, /range/i, /race/i, /multi/i, /1\s*x\s*2/i
];

const SIDE = /^(over|under)\s+(\d+(?:\.\d+)?)$/i;

function isCornerMarket(name) {
  const text = String(name || '').trim();
  if (NOT_FULL_MATCH_TOTAL.some((p) => p.test(text))) return false;
  return CORNER_MARKET_PATTERNS.some((p) => p.test(text));
}

// Returns [{ line, over: [{bookmaker, odd}], under: [{bookmaker, odd}] }],
// ascending by line. A value that does not parse is skipped, never guessed: a
// misread line would price the wrong bet.
function parseCornerQuotes(oddsResponse) {
  const byLine = new Map();

  for (const entry of oddsResponse || []) {
    for (const bookmaker of entry.bookmakers || []) {
      for (const bet of bookmaker.bets || []) {
        if (!isCornerMarket(bet.name)) continue;
        for (const value of bet.values || []) {
          const parsed = SIDE.exec(String(value.value || '').trim());
          if (!parsed) continue;
          const odd = Number(value.odd);
          if (!Number.isFinite(odd) || odd <= 1) continue;

          const line = Number(parsed[2]);
          // Half-integer lines only; a whole line pushes and nothing
          // downstream can represent that.
          if ((line * 2) % 2 !== 1) continue;

          if (!byLine.has(line)) byLine.set(line, { line, over: [], under: [] });
          byLine.get(line)[parsed[1].toLowerCase()].push({ bookmaker: bookmaker.name, odd });
        }
      }
    }
  }

  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

module.exports = {
  parseCornerQuotes, CORNER_MARKET_PATTERNS, NOT_FULL_MATCH_TOTAL, isCornerMarket
};
```

- [ ] **Step 4: Add the tool to `tools/baselines.js`**

Add these requires at the top:

```js
const devig = require('../baselines/devig');
const { parseCornerQuotes } = require('../aggregate/cornerOdds');
```

and this helper plus `registerTool` call inside `register(server)`:

```js
// Per line: every bookmaker's de-vigged view, the median of those views, and
// the best price on each side. `consensus` is null when the line is quoted on
// one side only — de-vigging needs both, and inventing the other side would
// manufacture a probability nobody quoted.
function summariseLine(quote) {
  const perBook = new Map();
  for (const side of ['over', 'under']) {
    for (const q of quote[side]) {
      if (!perBook.has(q.bookmaker)) perBook.set(q.bookmaker, { bookmaker: q.bookmaker });
      perBook.get(q.bookmaker)[side] = q.odd;
    }
  }

  const bookmakers = [];
  const fairOvers = [];
  const overrounds = [];
  for (const book of perBook.values()) {
    if (book.over === undefined || book.under === undefined) {
      bookmakers.push({ ...book, fairOverProbability: null });
      continue;
    }
    const [fairOver] = devig.fairProbabilities([book.over, book.under]);
    fairOvers.push(fairOver);
    overrounds.push(devig.overround([book.over, book.under]));
    bookmakers.push({ ...book, fairOverProbability: Math.round(fairOver * 1e4) / 1e4 });
  }

  const round = (n) => Math.round(n * 1e4) / 1e4;

  return {
    line: quote.line,
    bookmakers,
    consensus: fairOvers.length ? {
      overProbability: round(devig.median(fairOvers)),
      underProbability: round(1 - devig.median(fairOvers))
    } : null,
    overround: overrounds.length ? round(devig.median(overrounds)) : null,
    bestPrice: {
      over: quote.over.length ? devig.bestPrice(quote.over) : null,
      under: quote.under.length ? devig.bestPrice(quote.under) : null
    }
  };
}
```

```js
  server.registerTool(
    'get_market_probabilities',
    {
      title: 'Get the market\'s implied corner probabilities',
      description: 'Converts a fixture\'s corner odds into probabilities with the bookmaker '
        + 'margin removed, per bookmaker and as a consensus median, plus the best available '
        + 'price on each side. The consensus is the market\'s opinion — compare your own '
        + 'probability against it. The best price is what determines whether value exists.',
      inputSchema: {
        fixtureId: z.number().int().positive().describe('Fixture ID of the upcoming match.'),
        forceRefresh
      }
    },
    async ({ fixtureId, forceRefresh }) =>
      run(`get_market_probabilities(${fixtureId})`, async () => {
        const odds = await provider.fetch(provider.ENDPOINTS.ODDS,
          { fixture: fixtureId }, cache.TTL.ODDS, forceRefresh);

        const quotes = parseCornerQuotes(odds);
        if (!quotes.length) return null; // run() reports this as an explicit empty result

        return { fixtureId, market: 'corners', lines: quotes.map(summariseLine) };
      })
  );
```

- [ ] **Step 5: Run the whole suite**

Run: `cd mcp-server && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/aggregate/cornerOdds.js mcp-server/test/marketProbabilities.test.js mcp-server/tools/baselines.js
git commit -m "feat(mcp): add market-implied corner probabilities with de-vigging"
```

---

### Task 9: The `evaluate_bet` tool

**Files:**
- Create: `mcp-server/baselines/value.js`
- Create: `mcp-server/test/value.test.js`
- Modify: `mcp-server/tools/baselines.js`

**Interfaces:**
- Consumes: `devig.impliedProbability`
- Produces:
  - `evaluate(probability: number, decimalOdd: number, stakeUnits?: number)` → `{ probability, decimalOdd, impliedProbability, edge, expectedValue, expectedValueOnStake, stakeUnits }`
  - the `evaluate_bet` MCP tool

- [ ] **Step 1: Write the failing test**

Create `mcp-server/test/value.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { evaluate } = require('../baselines/value');

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: expected ${expected}, got ${actual}`);
}

// The worked example from the spec: p = 0.62 at 1.95.
test('edge and expected value match the spec\'s worked example', () => {
  const v = evaluate(0.62, 1.95);

  close(v.impliedProbability, 1 / 1.95, 'implied');
  close(v.edge, 0.62 - 1 / 1.95, 'edge');          // 0.107179...
  close(v.expectedValue, 0.209, 'EV per unit');    // 0.62*0.95 - 0.38
});

// The margin is a real cost to whoever takes the price, so the edge is measured
// against the raw implied probability, not against a de-vigged consensus.
test('the edge is measured against the raw price, not a fair one', () => {
  const v = evaluate(0.5, 1.90);

  assert.ok(v.edge < 0, 'backing a coin flip at 1.90 is a losing bet, and must read as one');
  close(v.edge, 0.5 - 1 / 1.9, 'negative edge');
});

test('a fair bet has zero edge and zero expected value', () => {
  const v = evaluate(0.5, 2);

  close(v.edge, 0, 'edge');
  close(v.expectedValue, 0, 'EV');
});

test('expected value scales with the stake', () => {
  const v = evaluate(0.62, 1.95, 0.5);

  close(v.expectedValueOnStake, 0.209 * 0.5, 'half a unit');
  assert.strictEqual(v.stakeUnits, 0.5);
});

test('stake defaults to one full unit', () => {
  assert.strictEqual(evaluate(0.62, 1.95).stakeUnits, 1);
});

test('a probability outside zero and one is rejected', () => {
  assert.throws(() => evaluate(1.2, 1.95), /probability/i);
  assert.throws(() => evaluate(-0.1, 1.95), /probability/i);
});

test('a stake above one unit is rejected', () => {
  assert.throws(() => evaluate(0.62, 1.95, 1.5), /stake/i);
});

test('an invalid odd is rejected', () => {
  assert.throws(() => evaluate(0.62, 1), /decimal odd/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mcp-server && node --test test/value.test.js`
Expected: FAIL — `Cannot find module '../baselines/value'`.

- [ ] **Step 3: Write the module**

Create `mcp-server/baselines/value.js`:

```js
'use strict';

const { impliedProbability } = require('./devig');

// Pure. Exists because this is exactly where mental arithmetic slips, and a
// sign error here corrupts every row of the ledger downstream.
function evaluate(probability, decimalOdd, stakeUnits = 1) {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) {
    throw new Error(`probability must be between 0 and 1 exclusive, got ${probability}`);
  }
  if (!Number.isFinite(stakeUnits) || stakeUnits <= 0 || stakeUnits > 1) {
    throw new Error(`stake must be above 0 and at most 1 unit, got ${stakeUnits}`);
  }

  const implied = impliedProbability(decimalOdd);
  const edge = probability - implied;
  const expectedValue = probability * (decimalOdd - 1) - (1 - probability);

  const round = (n) => Math.round(n * 1e6) / 1e6;

  return {
    probability,
    decimalOdd,
    impliedProbability: round(implied),
    edge: round(edge),
    expectedValue: round(expectedValue),
    expectedValueOnStake: round(expectedValue * stakeUnits),
    stakeUnits
  };
}

module.exports = { evaluate };
```

- [ ] **Step 4: Add the tool to `tools/baselines.js`**

Add `const { evaluate } = require('../baselines/value');` at the top and this call inside `register(server)`:

```js
  server.registerTool(
    'evaluate_bet',
    {
      title: 'Evaluate a bet\'s edge and expected value',
      description: 'Pure arithmetic on a probability and a price: implied probability, edge over '
        + 'it, and expected value per unit staked. Use this rather than computing it yourself — '
        + 'a sign error here corrupts the prediction record. It does not decide stake size.',
      inputSchema: {
        probability: z.number().gt(0).lt(1).describe('Your probability for the selection.'),
        decimalOdd: z.number().gt(1).describe('The decimal price available.'),
        stakeUnits: z.number().gt(0).max(1).default(1)
          .describe('Stake in units of the configured bankroll fraction. Never above 1.')
      }
    },
    async ({ probability, decimalOdd, stakeUnits }) =>
      run('evaluate_bet', async () => evaluate(probability, decimalOdd, stakeUnits))
  );
```

- [ ] **Step 5: Run the whole suite**

Run: `cd mcp-server && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/baselines/value.js mcp-server/test/value.test.js mcp-server/tools/baselines.js
git commit -m "feat(mcp): add bet evaluation tool"
```

---

### Task 10: The ledger store and `record_prediction`

**Files:**
- Create: `mcp-server/ledger/store.js`
- Create: `mcp-server/ledger/schema.js`
- Create: `mcp-server/tools/ledger.js`
- Create: `mcp-server/test/ledger.test.js`
- Modify: `mcp-server/server.js`
- Modify: `.gitignore` (ensure `ledger/` is NOT ignored while `.cache/` is)

**Interfaces:**
- Consumes: `zod`, `fs`, `path`, `run`
- Produces:
  - `store.append(record): void` — appends one JSON line to the month file derived from the record's timestamp
  - `store.readAll(): object[]` — every record across every month file, in file then line order
  - `store.ledgerDir(): string` — honours `MCP_LEDGER_DIR`
  - `schema.predictionSchema` — the zod object, including the divergence rule
  - `schema.DIVERGENCE_THRESHOLD` — `0.03`
  - the `record_prediction` MCP tool

- [ ] **Step 1: Write the failing test**

Create `mcp-server/test/ledger.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../ledger/store');
const ledger = require('../tools/ledger');

function fakeServer() {
  const tools = new Map();
  return { tools, registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
}

function handlers() {
  const server = fakeServer();
  ledger.register(server);
  return server.tools;
}

function prediction(overrides = {}) {
  return {
    fixture: { id: 500, league: 'Primeira Liga', home: 'Home FC', away: 'Away FC',
      kickoff: '2026-08-22T19:00:00+00:00' },
    market: { family: 'corners', selection: 'over', line: 9.5 },
    baseline: { probability: 0.58, empiricalRate: 0.5, empiricalSample: 10, lambda: 9.9,
      dispersionRatio: 1.4, caveats: ['no league normalisation'] },
    marketView: { consensusProbability: 0.54, bestPrice: 1.95, bookmaker: 'Bet365', overround: 0.045 },
    agent: { probability: 0.62, confidence: 'medium', divergenceReason: 'both keepers punt long',
      stake: 1 },
    ...overrides
  };
}

test.beforeEach(() => {
  process.env.MCP_LEDGER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ledger-'));
});

test.afterEach(() => {
  fs.rmSync(process.env.MCP_LEDGER_DIR, { recursive: true, force: true });
});

test('append writes one JSON line into the month file', () => {
  store.append({ type: 'prediction', id: 'a', recordedAt: '2026-08-22T09:00:00.000Z' });
  store.append({ type: 'prediction', id: 'b', recordedAt: '2026-08-23T09:00:00.000Z' });

  const file = path.join(store.ledgerDir(), '2026-08.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(JSON.parse(lines[0]).id, 'a');
});

test('records in different months land in different files', () => {
  store.append({ type: 'prediction', id: 'a', recordedAt: '2026-08-31T23:00:00.000Z' });
  store.append({ type: 'prediction', id: 'b', recordedAt: '2026-09-01T01:00:00.000Z' });

  assert.deepStrictEqual(
    fs.readdirSync(store.ledgerDir()).sort(),
    ['2026-08.jsonl', '2026-09.jsonl']
  );
});

test('readAll returns every record across months in order', () => {
  store.append({ type: 'prediction', id: 'a', recordedAt: '2026-08-31T23:00:00.000Z' });
  store.append({ type: 'prediction', id: 'b', recordedAt: '2026-09-01T01:00:00.000Z' });

  assert.deepStrictEqual(store.readAll().map((r) => r.id), ['a', 'b']);
});

test('readAll on an absent ledger is empty, not an error', () => {
  fs.rmSync(process.env.MCP_LEDGER_DIR, { recursive: true, force: true });

  assert.deepStrictEqual(store.readAll(), []);
});

// A truncated final line (a crash mid-write) must not make the whole record
// unreadable — the rest of the history is still good.
test('readAll skips a corrupt line and keeps the rest', () => {
  store.append({ type: 'prediction', id: 'a', recordedAt: '2026-08-22T09:00:00.000Z' });
  fs.appendFileSync(path.join(store.ledgerDir(), '2026-08.jsonl'), '{"type":"pred\n', 'utf8');
  store.append({ type: 'prediction', id: 'c', recordedAt: '2026-08-22T10:00:00.000Z' });

  assert.deepStrictEqual(store.readAll().map((r) => r.id), ['a', 'c']);
});

test('record_prediction writes a prediction and returns its id', async () => {
  const result = await handlers().get('record_prediction').handler(prediction());

  assert.ok(!result.isError, result.content[0].text);
  const body = JSON.parse(result.content[0].text);
  assert.match(body.id, /^2026-08-22-500-corners-over9\.5$/);

  const stored = store.readAll();
  assert.strictEqual(stored.length, 1);
  assert.strictEqual(stored[0].type, 'prediction');
  assert.strictEqual(stored[0].agent.probability, 0.62);
});

test('record_prediction computes edge and expected value itself', async () => {
  await handlers().get('record_prediction').handler(prediction());

  const [stored] = store.readAll();
  // 0.62 - 1/1.95 = 0.107179..., and 0.62*0.95 - 0.38 = 0.209
  assert.ok(Math.abs(stored.edge - 0.107179) < 1e-5, `edge was ${stored.edge}`);
  assert.ok(Math.abs(stored.expectedValue - 0.209) < 1e-6, `EV was ${stored.expectedValue}`);
});

// This is where the design stops being an intention and becomes mechanism.
test('a divergence from the baseline without a reason is refused', async () => {
  const p = prediction();
  delete p.agent.divergenceReason;

  const result = await handlers().get('record_prediction').handler(p);

  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /divergenceReason/i);
  assert.deepStrictEqual(store.readAll(), [], 'nothing may be written when validation fails');
});

test('agreeing with the baseline needs no reason', async () => {
  const p = prediction();
  p.agent.probability = 0.58;             // exactly the baseline
  delete p.agent.divergenceReason;

  const result = await handlers().get('record_prediction').handler(p);

  assert.ok(!result.isError, result.content[0].text);
});

test('a divergence inside the threshold needs no reason', async () => {
  const p = prediction();
  p.agent.probability = 0.60;             // 0.02 from the baseline's 0.58
  delete p.agent.divergenceReason;

  const result = await handlers().get('record_prediction').handler(p);

  assert.ok(!result.isError, result.content[0].text);
});

test('a prediction with no agent probability is refused', async () => {
  const p = prediction();
  delete p.agent.probability;

  const result = await handlers().get('record_prediction').handler(p);

  assert.strictEqual(result.isError, true);
  assert.deepStrictEqual(store.readAll(), []);
});

test('a whole market line is refused', async () => {
  const p = prediction();
  p.market.line = 10;

  const result = await handlers().get('record_prediction').handler(p);

  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /half-integer|line/i);
});

test('recording the same selection twice is refused', async () => {
  await handlers().get('record_prediction').handler(prediction());

  const result = await handlers().get('record_prediction').handler(prediction());

  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /already recorded/i);
  assert.strictEqual(store.readAll().length, 1, 'the ledger must not gain a duplicate');
});

test('a confidence outside the enum is refused', async () => {
  const p = prediction();
  p.agent.confidence = 'very high';

  const result = await handlers().get('record_prediction').handler(p);

  assert.strictEqual(result.isError, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mcp-server && node --test test/ledger.test.js`
Expected: FAIL — `Cannot find module '../ledger/store'`.

- [ ] **Step 3: Write the store**

Create `mcp-server/ledger/store.js`:

```js
'use strict';

const fs = require('fs');
const path = require('path');

// The ledger is the record, not a cache: it lives outside .cache/, is
// git-tracked, and is never cleared.
function ledgerDir() {
  return process.env.MCP_LEDGER_DIR || path.join(__dirname, '..', '..', 'ledger');
}

function monthOf(record) {
  const stamp = record.recordedAt || record.settledAt;
  if (typeof stamp !== 'string' || !/^\d{4}-\d{2}/.test(stamp)) {
    throw new Error('a ledger record needs an ISO recordedAt or settledAt to file it under');
  }
  return stamp.slice(0, 7);
}

// Append-only. Nothing here ever rewrites a line: grading appends a settlement
// that references a prediction, so a retouched history would be visible.
function append(record) {
  const dir = ledgerDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${monthOf(record)}.jsonl`),
    `${JSON.stringify(record)}\n`, 'utf8');
}

function readAll() {
  const dir = ledgerDir();
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  } catch (err) {
    return []; // no ledger yet is not an error
  }

  const records = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch (err) {
        // A truncated final line from a crashed write must not make the rest
        // of the history unreadable.
      }
    }
  }
  return records;
}

module.exports = { append, readAll, ledgerDir };
```

- [ ] **Step 4: Write the schema**

Create `mcp-server/ledger/schema.js`:

```js
'use strict';

const { z } = require('zod');

// Beyond this distance from the baseline, the agent must say why. Inside it,
// the difference is not a disagreement worth explaining.
const DIVERGENCE_THRESHOLD = 0.03;

const halfLine = z.number().refine((n) => (n * 2) % 2 === 1,
  { message: 'line must be a half-integer such as 9.5; a whole line can push' });

const predictionSchema = z.object({
  fixture: z.object({
    id: z.number().int().positive(),
    league: z.string().nullable().optional(),
    home: z.string(),
    away: z.string(),
    kickoff: z.string()
  }),
  market: z.object({
    family: z.literal('corners'),
    selection: z.enum(['over', 'under']),
    line: halfLine
  }),
  baseline: z.object({
    probability: z.number().gt(0).lt(1),
    empiricalRate: z.number().min(0).max(1),
    empiricalSample: z.number().int().nonnegative(),
    lambda: z.number().positive(),
    dispersionRatio: z.number().nullable(),
    caveats: z.array(z.string())
  }),
  marketView: z.object({
    consensusProbability: z.number().gt(0).lt(1).nullable(),
    bestPrice: z.number().gt(1),
    bookmaker: z.string(),
    overround: z.number().nullable()
  }),
  agent: z.object({
    // Required, always. A pick without a number cannot be scored, and an
    // unscorable pick is what this whole design exists to prevent.
    probability: z.number().gt(0).lt(1),
    confidence: z.enum(['low', 'medium', 'high']),
    divergenceReason: z.string().min(1).optional(),
    stake: z.number().gt(0).max(1)
  })
}).superRefine((value, ctx) => {
  const gap = Math.abs(value.agent.probability - value.baseline.probability);
  if (gap > DIVERGENCE_THRESHOLD && !value.agent.divergenceReason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['agent', 'divergenceReason'],
      message: `agent.probability differs from the baseline by ${gap.toFixed(3)}, above the `
        + `${DIVERGENCE_THRESHOLD} threshold: divergenceReason is required to record it`
    });
  }
});

// Stable and derived from the selection, so recording the same bet twice is
// detectable without a separate index.
function predictionId(value) {
  const day = value.fixture.kickoff.slice(0, 10);
  return `${day}-${value.fixture.id}-${value.market.family}-`
    + `${value.market.selection}${value.market.line}`;
}

module.exports = { predictionSchema, predictionId, DIVERGENCE_THRESHOLD };
```

- [ ] **Step 5: Write the tool**

Create `mcp-server/tools/ledger.js`:

```js
'use strict';

const { z } = require('zod');
const store = require('../ledger/store');
const { predictionSchema, predictionId, DIVERGENCE_THRESHOLD } = require('../ledger/schema');
const { evaluate } = require('../baselines/value');
const { run } = require('../result');

function register(server) {
  server.registerTool(
    'record_prediction',
    {
      title: 'Record a prediction before kickoff',
      description: 'Writes one prediction to the append-only ledger. Your own probability is '
        + 'required, and if it differs from the baseline by more than '
        + `${DIVERGENCE_THRESHOLD} you must supply divergenceReason — the write is refused `
        + 'otherwise. Edge and expected value are computed here, not by you.',
      // Cross-field rules (the divergence requirement) cannot live in this
      // per-key map, so the full object is validated inside the handler and a
      // failure becomes an error result via run().
      inputSchema: {
        fixture: z.object({
          id: z.number().int().positive(),
          league: z.string().nullable().optional(),
          home: z.string(),
          away: z.string(),
          kickoff: z.string().describe('ISO kickoff time.')
        }),
        market: z.object({
          family: z.literal('corners'),
          selection: z.enum(['over', 'under']),
          line: z.number().describe('Half-integer market line, e.g. 9.5.')
        }),
        baseline: z.object({
          probability: z.number(),
          empiricalRate: z.number(),
          empiricalSample: z.number().int(),
          lambda: z.number(),
          dispersionRatio: z.number().nullable(),
          caveats: z.array(z.string())
        }).describe('Copy this from get_corner_baseline, for the line you are backing.'),
        marketView: z.object({
          consensusProbability: z.number().nullable(),
          bestPrice: z.number(),
          bookmaker: z.string(),
          overround: z.number().nullable()
        }).describe('Copy this from get_market_probabilities.'),
        agent: z.object({
          probability: z.number().describe('Your probability for this selection.'),
          confidence: z.enum(['low', 'medium', 'high'])
            .describe('Confidence in the INPUTS — sample size, bookmaker coverage — not in the outcome.'),
          divergenceReason: z.string().optional()
            .describe('Why you differ from the baseline. Required beyond the threshold.'),
          stake: z.number().describe('Stake in units of the configured bankroll fraction, at most 1.')
        })
      }
    },
    async (input) =>
      run('record_prediction', async () => {
        const value = predictionSchema.parse(input);
        const id = predictionId(value);

        // Append-only means a duplicate cannot be corrected later, so it is
        // refused now.
        if (store.readAll().some((r) => r.type === 'prediction' && r.id === id)) {
          throw new Error(`${id} was already recorded; the ledger is append-only`);
        }

        const priced = evaluate(value.agent.probability, value.marketView.bestPrice, value.agent.stake);
        const record = {
          type: 'prediction',
          id,
          recordedAt: new Date().toISOString(),
          ...value,
          edge: priced.edge,
          expectedValue: priced.expectedValue
        };

        store.append(record);
        return { id, edge: record.edge, expectedValue: record.expectedValue };
      })
  );
}

module.exports = { register };
```

- [ ] **Step 6: Register the module and confirm the ledger is tracked**

In `mcp-server/server.js`:

```js
const ledger = require('./tools/ledger');
```

```js
ledger.register(server);
```

Check `.gitignore` at the repo root and `mcp-server/.gitignore`: `mcp-server/.cache/` must be ignored and `ledger/` must not be. If any pattern would catch `ledger/`, add an explicit negation and a comment saying the ledger is the record, not a cache.

- [ ] **Step 7: Run the whole suite**

Run: `cd mcp-server && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add mcp-server/ledger mcp-server/tools/ledger.js mcp-server/test/ledger.test.js mcp-server/server.js .gitignore
git commit -m "feat(mcp): add append-only prediction ledger with enforced divergence reasons"
```

---

### Task 11: `grade_pending_predictions`

**Files:**
- Create: `mcp-server/test/grading.test.js`
- Modify: `mcp-server/tools/ledger.js`

**Interfaces:**
- Consumes: `store.readAll`, `store.append`, `aggregate.cornerValue`, `aggregate.fetchStatistics`, `provider.fetch`, `cache.TTL`
- Produces: the `grade_pending_predictions` MCP tool. Settlement records take the shape `{ type: 'settlement', predictionId, settledAt, fixtureStatus, observed: { totalCorners }, outcome, returnUnits }` with `outcome` one of `win | loss | void`.

- [ ] **Step 1: Write the failing test**

Create `mcp-server/test/grading.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nock = require('nock');

const store = require('../ledger/store');
const ledger = require('../tools/ledger');

const BASE = 'https://v3.football.api-sports.io';

function fakeServer() {
  const tools = new Map();
  return { tools, registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
}

function handlers() {
  const server = fakeServer();
  ledger.register(server);
  return server.tools;
}

function storedPrediction(overrides = {}) {
  return {
    type: 'prediction',
    id: '2026-08-22-500-corners-over9.5',
    recordedAt: '2026-08-22T09:00:00.000Z',
    fixture: { id: 500, league: 'L', home: 'H', away: 'A', kickoff: '2026-08-22T19:00:00+00:00' },
    market: { family: 'corners', selection: 'over', line: 9.5 },
    baseline: { probability: 0.58, empiricalRate: 0.5, empiricalSample: 10, lambda: 9.9,
      dispersionRatio: 1.4, caveats: [] },
    marketView: { consensusProbability: 0.54, bestPrice: 1.95, bookmaker: 'B', overround: 0.045 },
    agent: { probability: 0.62, confidence: 'medium', divergenceReason: 'r', stake: 1 },
    edge: 0.107179,
    expectedValue: 0.209,
    ...overrides
  };
}

function finishedFixtureBody(status = 'FT') {
  return {
    errors: [],
    response: [{
      fixture: { id: 500, status: { short: status }, date: '2026-08-22T19:00:00+00:00' },
      teams: { home: { id: 33 }, away: { id: 34 } }
    }]
  };
}

function statsBody(homeCorners, awayCorners) {
  return {
    errors: [],
    response: [
      { team: { id: 33 }, statistics: [{ type: 'Corner Kicks', value: homeCorners }] },
      { team: { id: 34 }, statistics: [{ type: 'Corner Kicks', value: awayCorners }] }
    ]
  };
}

test.beforeEach(() => {
  nock.cleanAll();
  process.env.API_FOOTBALL_KEY = 'test-key-123';
  process.env.MCP_LEDGER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-grade-'));
  process.env.MCP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-grade-cache-'));
});

test.afterEach(() => {
  fs.rmSync(process.env.MCP_LEDGER_DIR, { recursive: true, force: true });
  fs.rmSync(process.env.MCP_CACHE_DIR, { recursive: true, force: true });
});

test('an over that landed settles as a win at the recorded price', async () => {
  store.append(storedPrediction());
  nock(BASE).get('/fixtures').query({ id: '500' }).reply(200, finishedFixtureBody());
  nock(BASE).get('/fixtures/statistics').query({ fixture: '500' }).reply(200, statsBody(7, 5));

  const result = await handlers().get('grade_pending_predictions').handler({});

  assert.ok(!result.isError, result.content[0].text);
  const settlement = store.readAll().find((r) => r.type === 'settlement');
  assert.strictEqual(settlement.observed.totalCorners, 12);
  assert.strictEqual(settlement.outcome, 'win');
  // 1.95 at one unit returns 0.95 profit.
  assert.ok(Math.abs(settlement.returnUnits - 0.95) < 1e-9, `returnUnits was ${settlement.returnUnits}`);
});

test('an over that missed settles as a loss of the stake', async () => {
  store.append(storedPrediction());
  nock(BASE).get('/fixtures').query({ id: '500' }).reply(200, finishedFixtureBody());
  nock(BASE).get('/fixtures/statistics').query({ fixture: '500' }).reply(200, statsBody(4, 3));

  await handlers().get('grade_pending_predictions').handler({});

  const settlement = store.readAll().find((r) => r.type === 'settlement');
  assert.strictEqual(settlement.observed.totalCorners, 7);
  assert.strictEqual(settlement.outcome, 'loss');
  assert.strictEqual(settlement.returnUnits, -1);
});

test('an under is graded the other way round', async () => {
  store.append(storedPrediction({
    id: '2026-08-22-500-corners-under9.5',
    market: { family: 'corners', selection: 'under', line: 9.5 }
  }));
  nock(BASE).get('/fixtures').query({ id: '500' }).reply(200, finishedFixtureBody());
  nock(BASE).get('/fixtures/statistics').query({ fixture: '500' }).reply(200, statsBody(4, 3));

  await handlers().get('grade_pending_predictions').handler({});

  assert.strictEqual(store.readAll().find((r) => r.type === 'settlement').outcome, 'win');
});

test('a match still to be played is left pending', async () => {
  store.append(storedPrediction());
  nock(BASE).get('/fixtures').query({ id: '500' }).reply(200, finishedFixtureBody('NS'));

  const result = await handlers().get('grade_pending_predictions').handler({});

  const body = JSON.parse(result.content[0].text);
  assert.strictEqual(body.settled, 0);
  assert.strictEqual(body.stillPending, 1);
  assert.strictEqual(store.readAll().filter((r) => r.type === 'settlement').length, 0);
});

// A result is never inferred from absent data.
test('a finished match with no corner statistic is voided, not guessed', async () => {
  store.append(storedPrediction());
  nock(BASE).get('/fixtures').query({ id: '500' }).reply(200, finishedFixtureBody());
  nock(BASE).get('/fixtures/statistics').query({ fixture: '500' }).reply(200, statsBody(null, 5));

  await handlers().get('grade_pending_predictions').handler({});

  const settlement = store.readAll().find((r) => r.type === 'settlement');
  assert.strictEqual(settlement.outcome, 'void');
  assert.strictEqual(settlement.returnUnits, 0);
});

test('an abandoned match is voided', async () => {
  store.append(storedPrediction());
  nock(BASE).get('/fixtures').query({ id: '500' }).reply(200, finishedFixtureBody('ABD'));

  await handlers().get('grade_pending_predictions').handler({});

  assert.strictEqual(store.readAll().find((r) => r.type === 'settlement').outcome, 'void');
});

// Running twice is normal — a missed day means the next run has a backlog.
test('grading is idempotent', async () => {
  store.append(storedPrediction());
  nock(BASE).get('/fixtures').query({ id: '500' }).reply(200, finishedFixtureBody());
  nock(BASE).get('/fixtures/statistics').query({ fixture: '500' }).reply(200, statsBody(7, 5));

  await handlers().get('grade_pending_predictions').handler({});
  const second = await handlers().get('grade_pending_predictions').handler({});

  assert.strictEqual(store.readAll().filter((r) => r.type === 'settlement').length, 1,
    'a second run must not settle the same prediction again');
  assert.strictEqual(JSON.parse(second.content[0].text).settled, 0);
});

test('an empty ledger grades nothing without failing', async () => {
  const result = await handlers().get('grade_pending_predictions').handler({});

  assert.ok(!result.isError, result.content[0].text);
  assert.strictEqual(JSON.parse(result.content[0].text).settled, 0);
});

test('one fixture that errors does not stop the others', async () => {
  store.append(storedPrediction());
  store.append(storedPrediction({
    id: '2026-08-22-501-corners-over9.5',
    fixture: { id: 501, league: 'L', home: 'H2', away: 'A2', kickoff: '2026-08-22T19:00:00+00:00' }
  }));
  nock(BASE).get('/fixtures').query({ id: '500' }).reply(500, {});
  nock(BASE).get('/fixtures').query({ id: '501' }).reply(200, {
    errors: [],
    response: [{ fixture: { id: 501, status: { short: 'FT' }, date: '2026-08-22T19:00:00+00:00' },
      teams: { home: { id: 33 }, away: { id: 34 } } }]
  });
  nock(BASE).get('/fixtures/statistics').query({ fixture: '501' }).reply(200, statsBody(7, 5));

  const result = await handlers().get('grade_pending_predictions').handler({});

  const body = JSON.parse(result.content[0].text);
  assert.strictEqual(body.settled, 1);
  assert.strictEqual(body.failures.length, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mcp-server && node --test test/grading.test.js`
Expected: FAIL — no `grade_pending_predictions` tool registered.

- [ ] **Step 3: Add the tool to `tools/ledger.js`**

Add these requires at the top:

```js
const provider = require('../provider/apiFootball');
const cache = require('../cache');
const aggregate = require('../aggregate/cornerProfile');
```

and this helper plus `registerTool` call:

```js
const VOID_STATUSES = new Set(['ABD', 'CANC', 'PST', 'AWD', 'WO']);

// Settles one prediction, or returns null to leave it pending. Never infers a
// result: a finished match whose corner statistic is missing is void, because
// treating a missing number as zero would grade an under as a win.
async function settle(prediction) {
  const found = await provider.fetch(provider.ENDPOINTS.FIXTURES,
    { id: prediction.fixture.id }, cache.TTL.LIVE);
  if (!found.length) throw new Error(`fixture ${prediction.fixture.id} was not found`);

  const fixture = found[0];
  const status = fixture.fixture.status.short;

  const settlement = {
    type: 'settlement',
    predictionId: prediction.id,
    settledAt: new Date().toISOString(),
    fixtureStatus: status
  };

  if (VOID_STATUSES.has(status)) {
    return { ...settlement, observed: { totalCorners: null }, outcome: 'void', returnUnits: 0 };
  }
  if (!provider.isFinished(fixture)) return null;

  const entries = await aggregate.fetchStatistics(fixture.fixture.id, false, cache.TTL.PERMANENT);
  const home = aggregate.cornerValue(entries, fixture.teams.home.id);
  const away = aggregate.cornerValue(entries, fixture.teams.away.id);
  if (home === null || away === null) {
    return { ...settlement, observed: { totalCorners: null }, outcome: 'void', returnUnits: 0 };
  }

  const total = home + away;
  const cleared = total > prediction.market.line;
  const won = prediction.market.selection === 'over' ? cleared : !cleared;
  const stake = prediction.agent.stake;

  return {
    ...settlement,
    observed: { totalCorners: total },
    outcome: won ? 'win' : 'loss',
    returnUnits: won
      ? Math.round(stake * (prediction.marketView.bestPrice - 1) * 1e6) / 1e6
      : -stake
  };
}
```

```js
  server.registerTool(
    'grade_pending_predictions',
    {
      title: 'Grade every prediction whose match has finished',
      description: 'Settles all outstanding predictions, not just yesterday\'s, so a missed run '
        + 'costs a day of picks rather than the record. Idempotent: a prediction that already '
        + 'carries a settlement is skipped. A finished match with no corner statistic is voided, '
        + 'never guessed.',
      inputSchema: {}
    },
    async () =>
      run('grade_pending_predictions', async () => {
        const records = store.readAll();
        const settledIds = new Set(records.filter((r) => r.type === 'settlement')
          .map((r) => r.predictionId));
        const pending = records.filter((r) => r.type === 'prediction' && !settledIds.has(r.id));

        let settled = 0;
        let stillPending = 0;
        const failures = [];

        // Sequential: the ledger is a single append-only file, and a settlement
        // count that races its own writes is worse than a slow run.
        for (const prediction of pending) {
          try {
            const settlement = await settle(prediction);
            if (!settlement) {
              stillPending += 1;
              continue;
            }
            store.append(settlement);
            settled += 1;
          } catch (err) {
            failures.push({ predictionId: prediction.id, reason: err && err.message ? err.message : String(err) });
          }
        }

        return { considered: pending.length, settled, stillPending, failures };
      })
  );
```

- [ ] **Step 4: Run the whole suite**

Run: `cd mcp-server && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/tools/ledger.js mcp-server/test/grading.test.js
git commit -m "feat(mcp): grade pending predictions idempotently"
```

---

### Task 12: Scoring and `get_ledger_summary`

**Files:**
- Create: `mcp-server/ledger/scoring.js`
- Create: `mcp-server/test/scoring.test.js`
- Modify: `mcp-server/tools/ledger.js`

**Interfaces:**
- Consumes: nothing in `scoring.js` — it is pure and takes already-joined rows.
- Produces:
  - `brier(rows): number | null` where a row is `{ probability, outcome: 0 | 1 }`
  - `logLoss(rows): number | null`
  - `calibration(rows, bands?)` → `[{ from, to, n, meanProbability, hitRate }]`
  - `pnl(rows): { units, n }` where a row has `returnUnits`
  - `summarise(predictions, settlements)` → the object in Step 3
  - `INSUFFICIENT_N: number` — `30`
  - the `get_ledger_summary` MCP tool

- [ ] **Step 1: Write the failing test**

Create `mcp-server/test/scoring.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const scoring = require('../ledger/scoring');

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
}

test('brier is the mean squared error of the probabilities', () => {
  // (0.6-1)^2 = 0.16 and (0.3-0)^2 = 0.09, mean 0.125
  close(scoring.brier([{ probability: 0.6, outcome: 1 }, { probability: 0.3, outcome: 0 }]),
    0.125, 'brier');
});

test('a perfect forecast scores zero and a reversed one scores one', () => {
  close(scoring.brier([{ probability: 1, outcome: 1 }]), 0, 'perfect');
  close(scoring.brier([{ probability: 0, outcome: 1 }]), 1, 'reversed');
});

test('log loss punishes a confident miss harder than brier does', () => {
  close(scoring.logLoss([{ probability: 0.5, outcome: 1 }]), Math.LN2, 'coin flip');

  const confidentMiss = scoring.logLoss([{ probability: 0.01, outcome: 1 }]);
  const unsureMiss = scoring.logLoss([{ probability: 0.4, outcome: 1 }]);
  assert.ok(confidentMiss > unsureMiss * 3, 'confidence must cost more when wrong');
});

test('log loss does not return infinity on a certainty that failed', () => {
  const loss = scoring.logLoss([{ probability: 0, outcome: 1 }]);
  assert.ok(Number.isFinite(loss), 'clamping must keep the score finite');
  assert.ok(loss > 30, 'but it must still be a very large number');
});

test('an empty sample has no score rather than a misleading zero', () => {
  assert.strictEqual(scoring.brier([]), null);
  assert.strictEqual(scoring.logLoss([]), null);
});

test('pnl sums the returned units', () => {
  const result = scoring.pnl([{ returnUnits: 0.95 }, { returnUnits: -1 }, { returnUnits: 0 }]);

  close(result.units, -0.05, 'units');
  assert.strictEqual(result.n, 3);
});

test('calibration buckets by probability band', () => {
  const rows = [
    { probability: 0.52, outcome: 1 }, { probability: 0.55, outcome: 0 },
    { probability: 0.58, outcome: 1 }, { probability: 0.71, outcome: 1 }
  ];

  const bands = scoring.calibration(rows, [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8]]);

  const first = bands.find((b) => b.from === 0.5);
  assert.strictEqual(first.n, 3);
  close(first.hitRate, 2 / 3, 'hit rate in the 50-60 band');
  const empty = bands.find((b) => b.from === 0.6);
  assert.strictEqual(empty.n, 0);
  assert.strictEqual(empty.hitRate, null, 'an empty band has no hit rate');
});

// The agent and the baseline are scored over exactly the same settled
// predictions. Scoring them over different sets would make the comparison
// meaningless, which is the one comparison this system exists to make.
test('summarise scores agent and baseline over the same predictions', () => {
  const predictions = [
    { type: 'prediction', id: 'p1', market: { family: 'corners' },
      agent: { probability: 0.6 }, baseline: { probability: 0.55 } },
    { type: 'prediction', id: 'p2', market: { family: 'corners' },
      agent: { probability: 0.3 }, baseline: { probability: 0.4 } },
    { type: 'prediction', id: 'p3', market: { family: 'corners' },
      agent: { probability: 0.8 }, baseline: { probability: 0.7 } }
  ];
  const settlements = [
    { type: 'settlement', predictionId: 'p1', outcome: 'win', returnUnits: 0.9 },
    { type: 'settlement', predictionId: 'p2', outcome: 'loss', returnUnits: -1 },
    { type: 'settlement', predictionId: 'p3', outcome: 'void', returnUnits: 0 }
  ];

  const s = scoring.summarise(predictions, settlements);

  assert.strictEqual(s.n, 2, 'a void carries no information and cannot be scored');
  assert.strictEqual(s.voided, 1);
  close(s.agent.brier, ((0.6 - 1) ** 2 + (0.3 - 0) ** 2) / 2, 'agent brier');
  close(s.baseline.brier, ((0.55 - 1) ** 2 + (0.4 - 0) ** 2) / 2, 'baseline brier');
  close(s.pnl.units, -0.1, 'pnl');
});

test('pending predictions are counted, not scored', () => {
  const s = scoring.summarise(
    [{ type: 'prediction', id: 'p1', market: { family: 'corners' },
      agent: { probability: 0.6 }, baseline: { probability: 0.55 } }],
    []
  );

  assert.strictEqual(s.pending, 1);
  assert.strictEqual(s.n, 0);
  assert.strictEqual(s.agent.brier, null);
});

// Below this many settled predictions, a Brier difference is noise. Reporting
// it as a number invites reading noise as skill.
test('a sample below the floor is reported as insufficient', () => {
  const predictions = [];
  const settlements = [];
  for (let i = 0; i < 5; i += 1) {
    predictions.push({ type: 'prediction', id: `p${i}`, market: { family: 'corners' },
      agent: { probability: 0.6 }, baseline: { probability: 0.55 } });
    settlements.push({ type: 'settlement', predictionId: `p${i}`, outcome: 'win', returnUnits: 0.9 });
  }

  const s = scoring.summarise(predictions, settlements);

  assert.strictEqual(s.verdict, 'insufficient');
  assert.ok(s.agent.brier !== null, 'the numbers are still reported');
  assert.match(s.verdictNote, new RegExp(String(scoring.INSUFFICIENT_N)));
});

test('a sufficient sample gets a verdict on who scored better', () => {
  const predictions = [];
  const settlements = [];
  for (let i = 0; i < 40; i += 1) {
    // The agent is right every time, the baseline is closer to a coin flip.
    predictions.push({ type: 'prediction', id: `p${i}`, market: { family: 'corners' },
      agent: { probability: 0.9 }, baseline: { probability: 0.55 } });
    settlements.push({ type: 'settlement', predictionId: `p${i}`, outcome: 'win', returnUnits: 0.9 });
  }

  const s = scoring.summarise(predictions, settlements);

  assert.strictEqual(s.verdict, 'agent-better');
  assert.ok(s.agent.brier < s.baseline.brier);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mcp-server && node --test test/scoring.test.js`
Expected: FAIL — `Cannot find module '../ledger/scoring'`.

- [ ] **Step 3: Write the module**

Create `mcp-server/ledger/scoring.js`:

```js
'use strict';

// Pure: no imports, no clock, no filesystem.

// Below this many settled predictions, a difference in Brier score is noise.
// The numbers are still reported; the verdict is withheld.
const INSUFFICIENT_N = 30;

const DEFAULT_BANDS = [[0, 0.3], [0.3, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 1]];

function round(n, places = 4) {
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
}

function brier(rows) {
  if (!rows.length) return null;
  return round(rows.reduce((acc, r) => acc + (r.probability - r.outcome) ** 2, 0) / rows.length, 6);
}

function logLoss(rows) {
  if (!rows.length) return null;
  // Clamp: a stated certainty that failed would otherwise score infinity and
  // destroy every aggregate it touches.
  const EPS = 1e-15;
  const total = rows.reduce((acc, r) => {
    const p = Math.min(1 - EPS, Math.max(EPS, r.probability));
    return acc - (r.outcome * Math.log(p) + (1 - r.outcome) * Math.log(1 - p));
  }, 0);
  return round(total / rows.length, 6);
}

function calibration(rows, bands = DEFAULT_BANDS) {
  return bands.map(([from, to]) => {
    // Half-open bands, with the last one closed so a probability of exactly 1
    // is not dropped.
    const inBand = rows.filter((r) => r.probability >= from
      && (to === 1 ? r.probability <= to : r.probability < to));
    return {
      from,
      to,
      n: inBand.length,
      meanProbability: inBand.length
        ? round(inBand.reduce((a, r) => a + r.probability, 0) / inBand.length) : null,
      hitRate: inBand.length
        ? round(inBand.filter((r) => r.outcome === 1).length / inBand.length) : null
    };
  });
}

function pnl(rows) {
  return {
    units: round(rows.reduce((acc, r) => acc + r.returnUnits, 0), 6),
    n: rows.length
  };
}

function summarise(predictions, settlements, market = null) {
  const byId = new Map(settlements.map((s) => [s.predictionId, s]));
  const considered = market
    ? predictions.filter((p) => p.market && p.market.family === market)
    : predictions;

  const scored = [];
  const settled = [];
  let voided = 0;
  let pending = 0;

  for (const p of considered) {
    const s = byId.get(p.id);
    if (!s) {
      pending += 1;
      continue;
    }
    settled.push(s);
    // A void carries no information about who forecast better.
    if (s.outcome === 'void') {
      voided += 1;
      continue;
    }
    const outcome = s.outcome === 'win' ? 1 : 0;
    scored.push({ agent: p.agent.probability, baseline: p.baseline.probability, outcome });
  }

  const agentRows = scored.map((r) => ({ probability: r.agent, outcome: r.outcome }));
  const baselineRows = scored.map((r) => ({ probability: r.baseline, outcome: r.outcome }));

  const agent = { brier: brier(agentRows), logLoss: logLoss(agentRows), calibration: calibration(agentRows) };
  const baseline = { brier: brier(baselineRows), logLoss: logLoss(baselineRows) };

  let verdict = 'insufficient';
  let verdictNote = `fewer than ${INSUFFICIENT_N} settled predictions: the numbers are reported, `
    + 'but a difference this small is noise, not skill';
  if (scored.length >= INSUFFICIENT_N) {
    if (agent.brier < baseline.brier) {
      verdict = 'agent-better';
      verdictNote = 'the agent\'s judgment scored better than the baseline over this sample';
    } else if (agent.brier > baseline.brier) {
      verdict = 'baseline-better';
      verdictNote = 'the baseline scored better than the agent: the judgment is costing accuracy';
    } else {
      verdict = 'tied';
      verdictNote = 'agent and baseline scored identically';
    }
  }

  return {
    market,
    n: scored.length,
    pending,
    voided,
    agent,
    baseline,
    pnl: pnl(settled.filter((s) => typeof s.returnUnits === 'number')),
    verdict,
    verdictNote
  };
}

module.exports = { brier, logLoss, calibration, pnl, summarise, INSUFFICIENT_N, DEFAULT_BANDS };
```

- [ ] **Step 4: Add the tool to `tools/ledger.js`**

Add `const scoring = require('../ledger/scoring');` at the top and:

```js
  server.registerTool(
    'get_ledger_summary',
    {
      title: 'Score the ledger',
      description: 'Scores the agent\'s probabilities against the baseline\'s over the same '
        + 'settled predictions: Brier, log loss, calibration by band, and realised P&L in units. '
        + 'There is no win rate — with varying prices it means nothing. Below '
        + `${scoring.INSUFFICIENT_N} settled predictions the verdict is "insufficient" rather `
        + 'than a number that looks meaningful.',
      inputSchema: {
        market: z.string().optional().describe('Restrict to one market family, e.g. "corners".'),
        from: z.string().optional().describe('ISO date; include predictions recorded on or after it.'),
        to: z.string().optional().describe('ISO date; include predictions recorded before it.')
      }
    },
    async ({ market, from, to }) =>
      run('get_ledger_summary', async () => {
        const records = store.readAll();
        const inWindow = (r) => (!from || r.recordedAt >= from) && (!to || r.recordedAt < to);
        return scoring.summarise(
          records.filter((r) => r.type === 'prediction' && inWindow(r)),
          records.filter((r) => r.type === 'settlement'),
          market || null
        );
      })
  );
```

- [ ] **Step 5: Run the whole suite**

Run: `cd mcp-server && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/ledger/scoring.js mcp-server/test/scoring.test.js mcp-server/tools/ledger.js
git commit -m "feat(mcp): score the agent against the baseline over the ledger"
```

---

### Task 13: The daily bulletin skill

**Files:**
- Create: `.claude/skills/daily-bulletin/SKILL.md`
- Create: `config/bulletin.json`
- Create: `ledger/.gitkeep`
- Modify: `mcp-server/README.md` (create if absent)

**Interfaces:**
- Consumes: every tool registered in Tasks 2, 6, 8, 9, 10, 11, 12, plus the pre-existing `get_api_status`, `get_fixtures`
- Produces: the procedure. Nothing importable.

- [ ] **Step 1: Write the configuration file**

Create `config/bulletin.json`:

```json
{
  "leagues": [],
  "windowHours": 48,
  "minEdge": 0.03,
  "maxPicks": 8,
  "stakeFraction": 0.01,
  "matchCount": 10,
  "runHour": 9,
  "lines": [7.5, 8.5, 9.5, 10.5, 11.5, 12.5]
}
```

`leagues` is deliberately empty. It is the throttle on the whole run — without it the sweep has no bound — and only the owner knows which competitions they follow. Each entry is `{ "id": <leagueId>, "season": <year>, "name": "<label>" }`, resolved with `search_leagues`.

- [ ] **Step 2: Write the skill**

Create `.claude/skills/daily-bulletin/SKILL.md`:

```markdown
---
name: daily-bulletin
description: Use when producing the daily betting bulletin - grades yesterday's predictions, computes corner baselines for upcoming fixtures, records judgments against them, and publishes the bulletin artifact
---

# Daily Betting Bulletin

Produce one day's bulletin. Follow these steps in order. The order matters:
grading comes before analysis so today's bulletin opens with yesterday's result.

Pass `dry-run` as an argument to execute every step WITHOUT calling
`record_prediction` and WITHOUT publishing. Use it to validate a change to this
procedure. A test prediction written into the ledger contaminates the very
measurement the system exists to produce.

## Step 0 — Read the configuration

Read `config/bulletin.json`. If `leagues` is empty, STOP and tell the owner the
watchlist is unset. Do not substitute a guess: the watchlist is what bounds the
run.

## Step 1 — Check the budget

Call `get_api_status`. Record plan and remaining requests; they go in the
bulletin's footer. If remaining requests are fewer than
`maxPicks × 2 × matchCount`, say so in the bulletin and reduce the number of
fixtures you analyse rather than failing halfway through.

## Step 2 — Grade what has played

Call `grade_pending_predictions`. It settles everything outstanding, not just
yesterday's. Note `settled`, `stillPending` and any `failures` for the bulletin.

## Step 3 — Read the record

Call `get_ledger_summary`. This is the performance panel. Carry through: agent
Brier, baseline Brier, `verdict`, `verdictNote`, P&L in units, `n`, and the
calibration bands.

If `verdict` is `baseline-better`, say so plainly at the top of the bulletin.
That is the finding the whole system exists to surface, and burying it would
defeat the purpose.

## Step 4 — Find the fixtures

For each entry in `leagues`, call `get_fixtures` with the league, season, and a
date range covering the next `windowHours` hours. Collect every fixture not yet
played.

## Step 5 — Compute the baseline

For each fixture, call `get_corner_baseline` with `matchCount` and `lines` from
the configuration.

**Read the `caveats` array.** A baseline built on a fallback venue sample is
weaker than one that was not, and that belongs in your `confidence`, which
describes the inputs, not the outcome.

**Compare `overProbability` against `empiricalOverRate`.** A wide gap means the
Poisson model is fitting the sample badly. Say so in your reasoning rather than
trusting the parametric number silently.

## Step 6 — Read the market

For each fixture, call `get_market_probabilities`. A fixture nobody quotes on
corners cannot be bet: skip it and count it as skipped. A line whose
`consensus` is null is quoted on one side only — its best price is still real,
but you have no market probability to test yourself against, so treat it as
weaker evidence.

## Step 7 — Judge

For each line worth considering, decide YOUR probability. You may agree with the
baseline, disagree with it, or ignore it. Three rules:

1. State your own probability. Not a lean, a number.
2. If you differ from the baseline by more than 0.03, you must have a reason
   that names something concrete — a venue sample, a dispersion ratio, a
   head-to-head, a schedule. "Feels high" is not a reason and
   `record_prediction` will reject the write without one.
3. Never invent an input the tools did not give you. If you find yourself
   reasoning about team news, motivation or weather, stop: none of it is in the
   data, and none of it belongs in the record.

Call `evaluate_bet` with your probability and the best price. Do not compute
edge or expected value yourself.

## Step 8 — Filter

Keep only selections whose `edge` is at least `minEdge`. Sort by edge
descending and keep at most `maxPicks`. Zero picks is a valid bulletin — a day
with no value is information, not a malfunction.

## Step 9 — Record

For each kept selection, call `record_prediction`, copying `baseline` from
Step 5 and `marketView` from Step 6 for the exact line you are backing. Set
`stake` in units (at most 1) and `confidence` from the input quality you
assessed in Step 5.

Skip this step entirely on a dry run.

## Step 10 — Publish

Build an HTML file and publish it with the Artifact tool. **Load the
`artifact-design` skill before writing it.**

Reuse the SAME file path and the SAME artifact URL every day so the owner opens
one stable link. History lives in the ledger, not in a trail of URLs.

The page carries, in this order:

1. If `verdict` is `baseline-better`, that finding, at the top, unmissable.
2. Today's picks. Per pick: fixture and kickoff, market and line, baseline
   probability, empirical rate, market consensus, best price and bookmaker,
   YOUR probability, edge, stake, and **your divergence reason in full**. The
   reason must be visible — it is what makes the judgment auditable.
3. The performance panel from Step 3: agent Brier against baseline Brier, P&L
   in units, `n`, and the calibration bands.
4. A footer: fixtures analysed, fixtures skipped and why, grading results from
   Step 2, and the quota reading from Step 1.

Then send a push notification with one line — picks count, top edge, and the
link.

Skip this step entirely on a dry run; report what you would have published.

## Step 11 — Commit the ledger

```bash
git add ledger/
git commit -m "chore(ledger): record <n> predictions and <m> settlements for <date>"
```

The git history is what attests that each prediction was written before its
match, not after. Skip on a dry run.

## Failure handling

If the API is unreachable or the quota is exhausted, publish a bulletin that
SAYS SO and record nothing. Never write a prediction from partial data — a
prediction built on half a profile is worse than no prediction, because it
enters the record looking like the others.
```

- [ ] **Step 3: Keep the ledger directory in git**

```bash
mkdir -p ledger
printf '' > ledger/.gitkeep
```

Confirm `git check-ignore -v ledger/.gitkeep` prints nothing. If it names a pattern, fix `.gitignore` — the ledger must be tracked.

- [ ] **Step 4: Document the system in the README**

In `mcp-server/README.md`, add a section listing every tool from Tasks 2, 6, 8, 9, 10, 11 and 12 with one line each, the `MCP_LEDGER_DIR` environment variable, and a pointer to `config/bulletin.json` and the spec. State plainly that the legacy `index.js` library is non-functional (every S5 endpoint returns 403), so nobody rediscovers that the hard way.

- [ ] **Step 5: Verify the tools are all reachable over MCP**

Register the server in `.mcp.json` if it is not already, restart Claude Code, and confirm all fourteen tools list. Then run the procedure once with `dry-run` against a single league.

Expected: the run completes, reports what it would have published, and the ledger directory contains only `.gitkeep`.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/daily-bulletin/SKILL.md config/bulletin.json ledger/.gitkeep mcp-server/README.md
git commit -m "feat: add daily bulletin procedure, config and docs"
```

---

### Task 14: Schedule the run

**Files:**
- Create: `docs/superpowers/plans/notes/scheduling.md`

**Interfaces:**
- Consumes: the skill from Task 13
- Produces: a registered daily schedule

- [ ] **Step 1: Confirm the watchlist is set**

Read `config/bulletin.json`. If `leagues` is still empty, stop: scheduling a run that immediately halts at Step 0 is worse than no schedule, because it fails silently every morning. Ask the owner for their leagues, resolve them with `search_leagues`, and write them in.

- [ ] **Step 2: Register the schedule**

Use the `schedule` skill to create a daily local run at `runHour` from the configuration, invoking the `daily-bulletin` skill.

The run **must be local** — the MCP server is stdio and the ledger is local disk, so a cloud routine cannot reach either.

- [ ] **Step 3: Verify it fires**

Schedule a one-off run a few minutes out, confirm the bulletin publishes and the notification arrives, then confirm the daily schedule is registered.

- [ ] **Step 4: Write down what was set up**

Create `docs/superpowers/plans/notes/scheduling.md` recording: the mechanism used, the hour, how to change it, how to disable it, and the known limitation that a machine which is off at `runHour` misses that day — with the note that grading catches up on the next run.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/notes/scheduling.md config/bulletin.json
git commit -m "docs: record the daily bulletin schedule"
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: the split architecture to Tasks 3-12; build order to the task sequence; `get_corner_baseline` to Tasks 3, 4, 6; `get_market_probabilities` to Tasks 7, 8; `evaluate_bet` to Task 9; ledger storage, records, enforcement, grading and scoring to Tasks 10-12; the daily run, delivery, failure handling and dry-run to Task 13; the scheduling constraint to Task 14; configuration to Task 13 Step 1; open question 3 to Task 1.

**Two spec items are deliberately deferred, not dropped:**

- **The quota re-derivation.** The spec says `MCP_MAX_REQUESTS_PER_CALL` and `MAX_MATCH_COUNT` should be re-derived from the purchased tier. No task changes them, because the tier is still open question 2. Both stay configurable, and Task 13 Step 1 has the run report a shortfall rather than fail. When the tier is known, this is an environment variable and one constant — not a task.
- **The cadence limitation.** A second run near kickoff belongs to Plan 5, as the spec says. Task 14 schedules one daily run only.

**Placeholder scan.** No TBDs. Task 5 is the one task describing a code move rather than quoting the moved body in full — deliberately, because retyping ~90 lines into the plan invites transcription drift in code that already carries hard-won bug-fix comments. Its instruction is to move, and its gate is that `test/stats.test.js` passes unedited, which no transcription error would survive.

**Type consistency.** Checked across tasks: `cornerProfile`/`cornerValue`/`fetchStatistics` (Task 5) are consumed with those names in Tasks 6 and 11. `cornerBaseline(homeProfile, awayProfile, lines)` (Task 4) is called with that signature in Task 6. `devig.fairProbabilities`/`median`/`bestPrice`/`overround` (Task 7) are used with those names in Task 8. `evaluate` (Task 9) is used in Tasks 9 and 10. `store.append`/`readAll`/`ledgerDir` (Task 10) are used in Tasks 11 and 12. `scoring.summarise(predictions, settlements, market)` (Task 12) matches its tool call. Settlement field names — `predictionId`, `observed.totalCorners`, `outcome`, `returnUnits` — are identical in Tasks 11 and 12.

**Rounding tolerances** are set per assertion rather than uniformly: `baselines/corners.js` publishes probabilities rounded to four places, so Task 4's comparison against raw Poisson uses `1e-4`, while the pure Poisson tests in Task 3 compare unrounded values at `1e-9`. Both tolerances carry a comment saying which it is, so a later reader does not "tighten" one and break it.
