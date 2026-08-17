'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nock = require('nock');

const markets = require('../markets');
const { goalsBaseline } = require('../baselines/goals');
const { goalsProfile } = require('../aggregate/goalsProfile');
const { parseQuotes } = require('../aggregate/marketOdds');
const { predictionSchema } = require('../ledger/schema');
const store = require('../ledger/store');
const baselines = require('../tools/baselines');
const ledgerTools = require('../tools/ledger');

const BASE = 'https://v3.football.api-sports.io';

function fakeServer() {
  const tools = new Map();
  return { tools, registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
}

function handlers(mod) {
  const server = fakeServer();
  mod.register(server);
  return server.tools;
}

// A finished match with a score already on it — which is the whole point: no
// statistics call is ever needed to profile goals.
function playedFixture(id, homeId, awayId, homeGoals, awayGoals, season = 2026) {
  return {
    fixture: { id, status: { short: 'FT' }, date: `2026-08-${String(id % 28 + 1).padStart(2, '0')}T12:00:00+00:00` },
    league: { id: 94, name: 'Primeira Liga', season },
    teams: { home: { id: homeId, name: `T${homeId}` }, away: { id: awayId, name: `T${awayId}` } },
    goals: { home: homeGoals, away: awayGoals }
  };
}

test.beforeEach(() => {
  nock.cleanAll();
  process.env.API_FOOTBALL_KEY = 'test-key-123';
  process.env.MCP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-goals-cache-'));
  process.env.MCP_LEDGER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-goals-ledger-'));
});

test.afterEach(() => {
  fs.rmSync(process.env.MCP_CACHE_DIR, { recursive: true, force: true });
  fs.rmSync(process.env.MCP_LEDGER_DIR, { recursive: true, force: true });
});

// --- the registry -----------------------------------------------------------

test('the goals market is declared with its own lines and observed key', () => {
  const spec = markets.get('goals');
  assert.strictEqual(spec.shape, 'totals');
  assert.strictEqual(spec.observedKey, 'totalGoals');
  assert.strictEqual(spec.source, 'fixture');
  assert.ok(spec.defaultLines.includes(2.5), 'the goals lines must cover the main market');
});

test('an unknown family is refused by name rather than silently ignored', () => {
  assert.throws(() => markets.get('bookings'), /unknown market family "bookings"/);
});

// --- odds parsing -----------------------------------------------------------

function oddsBody(marketName, values) {
  return [{
    bookmakers: [{ name: 'A', bets: [{ name: marketName, values }] }]
  }];
}

const TWO_SIDES = [{ value: 'Over 2.5', odd: '1.95' }, { value: 'Under 2.5', odd: '1.85' }];

test('the exact full-match goals market is accepted', () => {
  const quotes = parseQuotes('goals', oddsBody('Goals Over/Under', TWO_SIDES));
  assert.strictEqual(quotes.length, 1);
  assert.strictEqual(quotes[0].line, 2.5);
  assert.strictEqual(quotes[0].over[0].odd, 1.95);
  assert.strictEqual(quotes[0].under[0].odd, 1.85);
});

test('every adjacent goals market a real response carries is rejected', () => {
  // Read off the live probe against fixture 1622620 on 2026-08-17. Each of
  // these is a different bet, and pooling any of them into the full-match
  // buckets would back a selection nobody priced.
  const adjacent = [
    'Goals Over/Under First Half',
    'Goals Over/Under - Second Half',
    'Goal Line',
    'Goal Line (1st Half)',
    'Exact Goals Number',
    'Exact Goals Number - First Half',
    'Home Team Total Goals(1st Half)',
    'Away Team Total Goals(2nd Half)',
    'Away Team Exact Goals Number'
  ];

  for (const name of adjacent) {
    assert.deepStrictEqual(parseQuotes('goals', oddsBody(name, TWO_SIDES)), [],
      `"${name}" must not be read as the full-match goals total`);
  }
});

test('the corner market is not read as goals, nor goals as corners', () => {
  assert.deepStrictEqual(parseQuotes('goals', oddsBody('Corners Over Under', TWO_SIDES)), []);
  assert.deepStrictEqual(parseQuotes('corners', oddsBody('Goals Over/Under', TWO_SIDES)), []);
});

// --- the profile ------------------------------------------------------------

test('a goals profile costs one request per team and no statistics call', async () => {
  // No /fixtures/statistics interceptor is registered. nock fails any request
  // that is not mocked, so this test passing IS the proof that none is made.
  nock(BASE).get('/fixtures').query({ team: '33', last: '3' }).reply(200, {
    errors: [],
    response: [
      playedFixture(1, 33, 99, 2, 1),
      playedFixture(2, 98, 33, 0, 3),
      playedFixture(3, 33, 97, 1, 1)
    ]
  });

  const profile = await goalsProfile(33, 3, false);

  assert.strictEqual(profile.matchesAnalyzed, 3);
  assert.strictEqual(profile.totals.goalsFor, 2 + 3 + 1);
  assert.strictEqual(profile.totals.goalsAgainst, 1 + 0 + 1);
  assert.ok(nock.isDone(), 'the fixtures request should be the only one made');
});

test('goals are attributed to the right side when the team played away', async () => {
  nock(BASE).get('/fixtures').query({ team: '33', last: '1' }).reply(200, {
    errors: [],
    response: [playedFixture(2, 98, 33, 0, 3)]
  });

  const [match] = (await goalsProfile(33, 1, false)).matches;

  assert.strictEqual(match.venue, 'away');
  assert.strictEqual(match.goalsFor, 3);
  assert.strictEqual(match.goalsAgainst, 0);
});

test('a match with no score recorded is a failure, never a goalless draw', async () => {
  nock(BASE).get('/fixtures').query({ team: '33', last: '2' }).reply(200, {
    errors: [],
    response: [playedFixture(1, 33, 99, 2, 1), playedFixture(2, 33, 98, null, null)]
  });

  const profile = await goalsProfile(33, 2, false);

  assert.strictEqual(profile.matchesAnalyzed, 1);
  assert.strictEqual(profile.failures.length, 1);
  assert.match(profile.failures[0].reason, /no score recorded/);
});

// --- the baseline -----------------------------------------------------------

function profileOf(matches) {
  return { matches };
}

test('the goals baseline blends each side against the other', () => {
  // Home scores 2 and concedes 1 at home; away scores 1 and concedes 2 away.
  const home = profileOf(Array.from({ length: 4 }, () => (
    { venue: 'home', season: 2026, goalsFor: 2, goalsAgainst: 1 })));
  const away = profileOf(Array.from({ length: 4 }, () => (
    { venue: 'away', season: 2026, goalsFor: 1, goalsAgainst: 2 })));

  const baseline = goalsBaseline(home, away, [2.5], { currentSeason: 2026 });

  assert.strictEqual(baseline.lambda.home, 2);   // (2 + 2) / 2
  assert.strictEqual(baseline.lambda.away, 1);   // (1 + 1) / 2
  assert.strictEqual(baseline.lambda.total, 3);
  assert.strictEqual(baseline.lines[0].line, 2.5);
  assert.ok(baseline.caveats.some((c) => /no league normalisation/.test(c)),
    'the goals baseline inherits the same declared simplifications');
});

test('the goals baseline refuses a team with no matches rather than inventing one', () => {
  assert.throws(
    () => goalsBaseline(profileOf([]), profileOf([{ venue: 'away', goalsFor: 1, goalsAgainst: 1 }]), [2.5]),
    /home team has no matches/);
});

// --- the ledger schema ------------------------------------------------------

function predictionInput(family, line) {
  return {
    fixture: { id: 700, home: 'Home FC', away: 'Away FC', kickoff: '2026-08-22T19:00:00+00:00' },
    market: { family, selection: 'over', line },
    baseline: {
      probability: 0.55, empiricalRate: 0.5, empiricalSample: 10,
      lambda: 3, dispersionRatio: 1, caveats: []
    },
    marketView: { consensusProbability: 0.5, bestPrice: 2.1, bookmaker: 'A', overround: 0.05 },
    agent: { probability: 0.56, confidence: 'medium', stake: 0.5 }
  };
}

test('the ledger accepts a goals prediction', () => {
  const parsed = predictionSchema.parse(predictionInput('goals', 2.5));
  assert.strictEqual(parsed.market.family, 'goals');
});

test('the ledger still accepts a corners prediction', () => {
  const parsed = predictionSchema.parse(predictionInput('corners', 9.5));
  assert.strictEqual(parsed.market.family, 'corners');
});

test('a family nobody has built is refused at the schema, not recorded', () => {
  assert.throws(() => predictionSchema.parse(predictionInput('cards', 4.5)));
});

test('a whole line is refused for goals too, because it can push', () => {
  assert.throws(() => predictionSchema.parse(predictionInput('goals', 3)));
});

// --- settlement -------------------------------------------------------------

test('a goals prediction settles from the fixture score, with its own observed key', async () => {
  const tools = handlers(ledgerTools);

  const recorded = await tools.get('record_prediction').handler(predictionInput('goals', 2.5));
  assert.ok(!recorded.isError, recorded.content[0].text);

  // 2-1 clears 2.5. Again no statistics interceptor: settling goals must not
  // reach for the statistics endpoint the way corners do.
  nock(BASE).get('/fixtures').query({ id: '700' }).reply(200, {
    errors: [],
    response: [playedFixture(700, 1, 2, 2, 1)]
  });

  const graded = await tools.get('grade_pending_predictions').handler({});
  const body = JSON.parse(graded.content[0].text);

  assert.strictEqual(body.settled, 1);
  assert.deepStrictEqual(body.failures, []);

  const settlement = store.readAll().find((r) => r.type === 'settlement');
  assert.strictEqual(settlement.observed.totalGoals, 3);
  assert.strictEqual(settlement.outcome, 'win');
  assert.ok(nock.isDone(), 'settling goals should need only the fixture');
});

test('a finished match with no score is void, not graded as under', async () => {
  const tools = handlers(ledgerTools);
  await tools.get('record_prediction').handler(predictionInput('goals', 2.5));

  nock(BASE).get('/fixtures').query({ id: '700' }).reply(200, {
    errors: [],
    response: [playedFixture(700, 1, 2, null, null)]
  });

  await tools.get('grade_pending_predictions').handler({});

  const settlement = store.readAll().find((r) => r.type === 'settlement');
  assert.strictEqual(settlement.outcome, 'void');
  assert.strictEqual(settlement.observed.totalGoals, null);
  assert.strictEqual(settlement.returnUnits, 0);
});

// --- the tool ---------------------------------------------------------------

test('get_goals_baseline resolves the fixture and prices the goals lines', async () => {
  nock(BASE).get('/fixtures').query({ id: '500' }).reply(200, {
    errors: [],
    response: [{
      fixture: { id: 500, status: { short: 'NS' }, date: '2026-08-22T19:00:00+00:00' },
      league: { id: 94, name: 'Primeira Liga', season: 2026 },
      teams: { home: { id: 33, name: 'Home FC' }, away: { id: 34, name: 'Away FC' } }
    }]
  });
  nock(BASE).get('/fixtures').query({ team: '33', last: '4' }).reply(200, {
    errors: [],
    response: [1, 2, 3, 4].map((i) => playedFixture(i, 33, 90 + i, 2, 1))
  });
  nock(BASE).get('/fixtures').query({ team: '34', last: '4' }).reply(200, {
    errors: [],
    response: [5, 6, 7, 8].map((i) => playedFixture(i, 90 + i, 34, 2, 1))
  });

  const result = await handlers(baselines).get('get_goals_baseline')
    .handler({ fixtureId: 500, matchCount: 4 });

  assert.ok(!result.isError, result.content[0].text);
  const body = JSON.parse(result.content[0].text);
  assert.strictEqual(body.market, 'goals');
  assert.strictEqual(body.fixture.home, 'Home FC');
  assert.strictEqual(body.lambda.total, 3);   // home 2 for, away 1 for
  assert.ok(body.lines.some((l) => l.line === 2.5), 'the main goals line must be priced');
  assert.ok(body.caveats.length > 0, 'simplifications must be declared');
});
