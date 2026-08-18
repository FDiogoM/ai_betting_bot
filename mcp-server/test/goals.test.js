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
const { predictionSchema, predictionId } = require('../ledger/schema');
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

test('the goals half of a profile survives statistics being unavailable', async () => {
  // No /fixtures/statistics interceptor is registered, so every shots request
  // fails. The goals come off the fixture and are unaffected: the profile is
  // complete, and only the shots signal is lost.
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

  // A shots request that failed is NOT a match failure: the match is a
  // perfectly good goals observation. The two are reported separately so a
  // degraded signal never reads as lost data.
  assert.strictEqual(profile.failures.length, 0, 'no match was lost');
  assert.strictEqual(profile.shots.coverage, 0);
  assert.strictEqual(profile.shots.failures.length, 3, 'the lost shots are reported, not hidden');
});

test('shots are read for both sides and coverage is reported', async () => {
  nock(BASE).get('/fixtures').query({ team: '33', last: '2' }).reply(200, {
    errors: [],
    response: [playedFixture(1, 33, 99, 2, 1), playedFixture(2, 98, 33, 0, 3)]
  });
  // Match 1 has shots for both teams; match 2 records none, so it keeps its
  // goals and carries nulls rather than being dropped or read as zero.
  nock(BASE).get('/fixtures/statistics').query({ fixture: '1' }).reply(200, {
    errors: [],
    response: [
      { team: { id: 33 }, statistics: [{ type: 'Shots on Goal', value: 7 }] },
      { team: { id: 99 }, statistics: [{ type: 'Shots on Goal', value: 3 }] }
    ]
  });
  nock(BASE).get('/fixtures/statistics').query({ fixture: '2' }).reply(200, {
    errors: [],
    response: [
      { team: { id: 98 }, statistics: [{ type: 'Shots on Goal', value: null }] },
      { team: { id: 33 }, statistics: [{ type: 'Shots on Goal', value: null }] }
    ]
  });

  const profile = await goalsProfile(33, 2, false);

  assert.strictEqual(profile.matchesAnalyzed, 2);
  assert.strictEqual(profile.shots.matchesWithShots, 1);
  assert.strictEqual(profile.shots.coverage, 0.5);

  const withShots = profile.matches.find((m) => m.fixtureId === 1);
  assert.strictEqual(withShots.shotsOnTargetFor, 7);
  assert.strictEqual(withShots.shotsOnTargetAgainst, 3);

  const without = profile.matches.find((m) => m.fixtureId === 2);
  assert.strictEqual(without.shotsOnTargetFor, null, 'a missing shot count is null, never 0');
  assert.strictEqual(without.goalsFor, 3, 'and the goals are still there');
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

// --- the shots signal -------------------------------------------------------

// Six matches per team, all at the relevant venue so the venue sample never
// falls back and the numbers below are the ones under test.
function shotProfile(venue, goalsFor, goalsAgainst, shotsFor, shotsAgainst, n = 6) {
  return profileOf(Array.from({ length: n }, () => ({
    venue,
    season: 2026,
    goalsFor,
    goalsAgainst,
    shotsOnTargetFor: shotsFor,
    shotsOnTargetAgainst: shotsAgainst
  })));
}

test('the rate comes from shots on target, not from goals scored', () => {
  // Home creates 8 shots on target and scores 1; away creates 2 and scores 2.
  // Read as goals, away is the dangerous side. Read as shots, home is — and
  // shots are what repeats.
  const home = shotProfile('home', 1, 1, 8, 2);
  const away = shotProfile('away', 2, 1, 2, 8);

  const b = goalsBaseline(home, away, [2.5], { currentSeason: 2026 });

  assert.strictEqual(b.signal, 'shots');
  // Pooled conversion: 30 goals from 120 shots on target = 0.25.
  assert.strictEqual(b.conversion.rate, 0.25);
  assert.strictEqual(b.conversion.shotsOnTarget, 120);
  // λ_home = (home's 8 shots + away's 8 conceded) / 2 × 0.25 = 2
  assert.strictEqual(b.lambda.home, 2);
  // λ_away = (away's 2 shots + home's 2 conceded) / 2 × 0.25 = 0.5
  assert.strictEqual(b.lambda.away, 0.5);

  // The old model had it the other way round, and says so beside the answer:
  // λ_away = (away's 2 scored away + home's 1 conceded at home) / 2 = 1.5,
  // against a home side it put at 1.0.
  assert.strictEqual(b.comparison.signal, 'goals');
  assert.strictEqual(b.comparison.lambda.home, 1);
  assert.strictEqual(b.comparison.lambda.away, 1.5);
  assert.ok(b.lambda.home > b.comparison.lambda.home,
    'the shots signal must raise the side that was creating and not converting');
  assert.ok(b.lambda.away < b.comparison.lambda.away,
    'and lower the side that was converting without creating');
});

test('the empirical rate is computed from real goals, never from the shots proxy', () => {
  // Every match ended with 2 goals, so over 1.5 happened every time and over
  // 2.5 never did — regardless of what the shots-implied rate says.
  const home = shotProfile('home', 1, 1, 9, 1);
  const away = shotProfile('away', 1, 1, 9, 1);

  const b = goalsBaseline(home, away, [1.5, 2.5], { currentSeason: 2026 });

  const over15 = b.lines.find((l) => l.line === 1.5);
  const over25 = b.lines.find((l) => l.line === 2.5);
  assert.strictEqual(over15.empiricalOverRate, 1, 'every match cleared 1.5 actual goals');
  assert.strictEqual(over25.empiricalOverRate, 0, 'no match cleared 2.5 actual goals');
  // Dispersion likewise reads the real counts: every match was exactly 2.
  assert.strictEqual(b.dispersion.variance, 0);
});

test('a sample without shots falls back to goals and says so', () => {
  const home = profileOf(Array.from({ length: 6 }, () => (
    { venue: 'home', season: 2026, goalsFor: 2, goalsAgainst: 1 })));
  const away = profileOf(Array.from({ length: 6 }, () => (
    { venue: 'away', season: 2026, goalsFor: 1, goalsAgainst: 2 })));

  const b = goalsBaseline(home, away, [2.5], { currentSeason: 2026 });

  assert.strictEqual(b.signal, 'goals');
  assert.strictEqual(b.conversion, null);
  assert.strictEqual(b.comparison, null);
  assert.strictEqual(b.lambda.total, 3, 'the old arithmetic is used unchanged');
  assert.ok(b.caveats.some((c) => /goals scored/.test(c) && /shots/.test(c)),
    `the fallback must be declared, got: ${b.caveats.join(' | ')}`);
});

test('thin shots coverage on one team falls back rather than half-using the signal', () => {
  // Home has shots on one match in six; away has them on all six.
  const home = profileOf(Array.from({ length: 6 }, (unused, i) => ({
    venue: 'home', season: 2026, goalsFor: 2, goalsAgainst: 1,
    shotsOnTargetFor: i === 0 ? 8 : null,
    shotsOnTargetAgainst: i === 0 ? 3 : null
  })));
  const away = shotProfile('away', 1, 2, 3, 8);

  const b = goalsBaseline(home, away, [2.5], { currentSeason: 2026 });

  assert.strictEqual(b.signal, 'goals');
  assert.ok(b.caveats.some((c) => /coverage/.test(c)),
    `the coverage fallback must be declared, got: ${b.caveats.join(' | ')}`);
});

test('too few pooled shots to divide by falls back rather than trusting the ratio', () => {
  // Two matches each, one shot on target apiece: four shots is not a
  // conversion rate.
  const home = shotProfile('home', 1, 1, 1, 1, 2);
  const away = shotProfile('away', 1, 1, 1, 1, 2);

  const b = goalsBaseline(home, away, [2.5], { currentSeason: 2026 });

  assert.strictEqual(b.signal, 'goals');
  assert.strictEqual(b.conversion, null);
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

// Settlement tests write the prediction straight into the store. Going through
// record_prediction would mean standing up an entire baseline derivation —
// fixtures, statistics, odds — to get one row into the ledger, and none of that
// is what these tests are about.
function alreadyRecorded(family, line) {
  const value = predictionInput(family, line);
  store.append({
    type: 'prediction',
    id: predictionId(value),
    recordedAt: '2026-08-22T09:00:00.000Z',
    ...value
  });
}

test('a goals prediction settles from the fixture score, with its own observed key', async () => {
  const tools = handlers(ledgerTools);

  alreadyRecorded('goals', 2.5);

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
  alreadyRecorded('goals', 2.5);

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

test('get_goals_baseline reports the fallback when no statistics are available', async () => {
  // The test above stubs no /fixtures/statistics, so the shots pass finds
  // nothing and the tool must say so rather than silently claiming a signal it
  // did not have.
  nock(BASE).get('/fixtures').query({ id: '501' }).reply(200, {
    errors: [],
    response: [{
      fixture: { id: 501, status: { short: 'NS' }, date: '2026-08-22T19:00:00+00:00' },
      league: { id: 94, name: 'Primeira Liga', season: 2026 },
      teams: { home: { id: 33, name: 'Home FC' }, away: { id: 34, name: 'Away FC' } }
    }]
  });
  nock(BASE).get('/fixtures').query({ team: '33', last: '4' }).reply(200, {
    errors: [], response: [1, 2, 3, 4].map((i) => playedFixture(i, 33, 90 + i, 2, 1))
  });
  nock(BASE).get('/fixtures').query({ team: '34', last: '4' }).reply(200, {
    errors: [], response: [5, 6, 7, 8].map((i) => playedFixture(i, 90 + i, 34, 2, 1))
  });

  const result = await handlers(baselines).get('get_goals_baseline')
    .handler({ fixtureId: 501, matchCount: 4 });

  const body = JSON.parse(result.content[0].text);
  assert.strictEqual(body.signal, 'goals');
  assert.strictEqual(body.conversion, null);
});

test('get_goals_baseline prices from shots end to end when statistics are there', async () => {
  const statistics = (fixtureId, teamA, sotA, teamB, sotB) =>
    nock(BASE).get('/fixtures/statistics').query({ fixture: String(fixtureId) }).reply(200, {
      errors: [],
      response: [
        { team: { id: teamA }, statistics: [{ type: 'Shots on Goal', value: sotA }] },
        { team: { id: teamB }, statistics: [{ type: 'Shots on Goal', value: sotB }] }
      ]
    });

  nock(BASE).get('/fixtures').query({ id: '502' }).reply(200, {
    errors: [],
    response: [{
      fixture: { id: 502, status: { short: 'NS' }, date: '2026-08-22T19:00:00+00:00' },
      league: { id: 94, name: 'Primeira Liga', season: 2026 },
      teams: { home: { id: 33, name: 'Home FC' }, away: { id: 34, name: 'Away FC' } }
    }]
  });

  // Home won each match 2-1 at home; away lost each 1-2 away. Both create 6
  // shots on target and concede 4, every match.
  nock(BASE).get('/fixtures').query({ team: '33', last: '4' }).reply(200, {
    errors: [], response: [1, 2, 3, 4].map((i) => playedFixture(i, 33, 90 + i, 2, 1))
  });
  nock(BASE).get('/fixtures').query({ team: '34', last: '4' }).reply(200, {
    errors: [], response: [5, 6, 7, 8].map((i) => playedFixture(i, 90 + i, 34, 1, 2))
  });
  for (const i of [1, 2, 3, 4]) statistics(i, 33, 6, 90 + i, 4);
  for (const i of [5, 6, 7, 8]) statistics(i, 34, 6, 90 + i, 4);

  const result = await handlers(baselines).get('get_goals_baseline')
    .handler({ fixtureId: 502, matchCount: 4 });

  assert.ok(!result.isError, result.content[0].text);
  const body = JSON.parse(result.content[0].text);

  assert.strictEqual(body.signal, 'shots');
  // 24 goals from 80 shots on target across 8 matches = 0.3 exactly.
  assert.strictEqual(body.conversion.rate, 0.3);
  assert.strictEqual(body.conversion.matches, 8);
  // Every side creates 6 and concedes 4, so both lambdas are (6 + 4)/2 × 0.3.
  assert.strictEqual(body.lambda.home, 1.5);
  assert.strictEqual(body.lambda.away, 1.5);
  // The goals-based model is reported beside it for comparison.
  assert.strictEqual(body.comparison.signal, 'goals');
  assert.strictEqual(body.comparison.lambda.total, 3);
});
