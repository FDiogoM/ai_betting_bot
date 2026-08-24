'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nock = require('nock');

const context = require('../aggregate/context');

const BASE = 'https://v3.football.api-sports.io';

test.beforeEach(() => {
  nock.cleanAll();
  process.env.API_FOOTBALL_KEY = 'test-key-123';
  process.env.MCP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ctx-'));
});

test.afterEach(() => {
  fs.rmSync(process.env.MCP_CACHE_DIR, { recursive: true, force: true });
});

function fixture(id, date, opts = {}) {
  return {
    fixture: { id, date, referee: opts.referee || null, status: { short: opts.status || 'FT' } },
    league: { id: 39, name: opts.competition || 'Premier League', season: 2026 },
    teams: { home: { id: opts.homeId || 33, name: 'Home' }, away: { id: opts.awayId || 34, name: 'Away' } },
    goals: { home: opts.homeGoals === undefined ? 1 : opts.homeGoals,
      away: opts.awayGoals === undefined ? 1 : opts.awayGoals }
  };
}

function stats(fixtureId, homeId, awayId, values) {
  nock(BASE).get('/fixtures/statistics').query({ fixture: String(fixtureId) }).reply(200, {
    errors: [],
    response: [
      { team: { id: homeId }, statistics: Object.entries(values.home).map(([type, value]) => ({ type, value })) },
      { team: { id: awayId }, statistics: Object.entries(values.away).map(([type, value]) => ({ type, value })) }
    ]
  });
}

// --- rest --------------------------------------------------------------------

test('rest counts days back and days forward, and names the next competition', async () => {
  nock(BASE).get('/fixtures').query({ team: '33', last: '1' }).reply(200, {
    errors: [], response: [fixture(1, '2026-08-15T14:00:00+00:00')]
  });
  nock(BASE).get('/fixtures').query({ team: '33', next: '3' }).reply(200, {
    errors: [],
    response: [
      fixture(2, '2026-08-24T19:00:00+00:00', { status: 'NS' }),                       // this one
      fixture(3, '2026-08-27T19:00:00+00:00', { status: 'NS', competition: 'League Cup' }),
      fixture(4, '2026-08-30T13:00:00+00:00', { status: 'NS' })
    ]
  });

  const rest = await context.restProfile(33, '2026-08-24T19:00:00+00:00', false);

  assert.strictEqual(rest.daysSinceLast, 9.2);
  assert.strictEqual(rest.daysUntilNext, 3);
  assert.strictEqual(rest.nextCompetition, 'League Cup',
    'the fixture being priced must not be read as its own next match');
  assert.strictEqual(rest.upcoming.length, 2);
});

test('a team with nothing scheduled after reports null rather than zero', async () => {
  nock(BASE).get('/fixtures').query({ team: '33', last: '1' }).reply(200, {
    errors: [], response: [fixture(1, '2026-08-20T14:00:00+00:00')]
  });
  nock(BASE).get('/fixtures').query({ team: '33', next: '3' }).reply(200, {
    errors: [], response: [fixture(2, '2026-08-24T19:00:00+00:00', { status: 'NS' })]
  });

  const rest = await context.restProfile(33, '2026-08-24T19:00:00+00:00', false);

  assert.strictEqual(rest.daysUntilNext, null, 'no next match is null, not a rest of zero days');
});

// --- referee -----------------------------------------------------------------

// The provider answers "The Referee field do not exist" to /fixtures?referee=,
// so the league season is fetched whole and filtered by name.
test('a referee profile averages only their own finished matches', async () => {
  nock(BASE).get('/fixtures').query({ league: '39', season: '2026' }).reply(200, {
    errors: [],
    response: [
      fixture(1, '2026-08-01T14:00:00+00:00', { referee: 'J. Brooks' }),
      fixture(2, '2026-08-08T14:00:00+00:00', { referee: 'J. Brooks' }),
      fixture(3, '2026-08-08T14:00:00+00:00', { referee: 'M. Oliver' }),        // someone else
      fixture(4, '2026-08-30T14:00:00+00:00', { referee: 'J. Brooks', status: 'NS' })  // not played
    ]
  });
  stats(1, 33, 34, { home: { 'Yellow Cards': 3, Fouls: 12 }, away: { 'Yellow Cards': 2, Fouls: 10 } });
  stats(2, 33, 34, { home: { 'Yellow Cards': 4, Fouls: 14 }, away: { 'Yellow Cards': 1, Fouls: 8 } });

  const referee = await context.refereeProfile('J. Brooks', 39, 2026, false);

  assert.strictEqual(referee.matches, 2, 'only their own, and only the finished ones');
  assert.strictEqual(referee.averages.yellows, 5);   // (5 + 5) / 2
  assert.strictEqual(referee.averages.fouls, 22);    // (22 + 22) / 2
});

// Early in a season everyone has taken charge of one match, and an average over
// one match is a number about one match.
test('a thin referee sample is reported as insufficient rather than smoothed', async () => {
  nock(BASE).get('/fixtures').query({ league: '39', season: '2026' }).reply(200, {
    errors: [], response: [fixture(1, '2026-08-01T14:00:00+00:00', { referee: 'J. Brooks' })]
  });
  stats(1, 33, 34, { home: { 'Yellow Cards': 3 }, away: { 'Yellow Cards': 2 } });

  const referee = await context.refereeProfile('J. Brooks', 39, 2026, false);

  assert.strictEqual(referee.sufficient, false);
  assert.match(referee.note, /below the 5/);
  assert.match(referee.note, /do not price on it/);
});

test('a referee with no finished match says so instead of returning an average', async () => {
  nock(BASE).get('/fixtures').query({ league: '39', season: '2026' }).reply(200, {
    errors: [], response: [fixture(1, '2026-08-30T14:00:00+00:00', { referee: 'J. Brooks', status: 'NS' })]
  });

  const referee = await context.refereeProfile('J. Brooks', 39, 2026, false);

  assert.strictEqual(referee.matches, 0);
  assert.strictEqual(referee.sufficient, false);
  assert.strictEqual(referee.averages, undefined, 'no matches means no averages, not zeroes');
});

test('an unassigned referee is not an error', async () => {
  const referee = await context.refereeProfile(null, 39, 2026, false);

  assert.strictEqual(referee.referee, null);
  assert.strictEqual(referee.sufficient, false);
  assert.match(referee.note, /no referee assigned/);
});

// --- head to head ------------------------------------------------------------

test('head to head summarises recent meetings', async () => {
  nock(BASE).get('/fixtures/headtohead').query({ h2h: '33-34' }).reply(200, {
    errors: [],
    response: [
      fixture(10, '2026-05-01T14:00:00+00:00', { homeGoals: 2, awayGoals: 1 }),
      fixture(11, '2025-12-01T14:00:00+00:00', { homeGoals: 0, awayGoals: 0 }),
      fixture(12, '2026-08-30T14:00:00+00:00', { status: 'NS' })     // not played
    ]
  });
  stats(10, 33, 34, { home: { 'Yellow Cards': 3, 'Corner Kicks': 6 }, away: { 'Yellow Cards': 4, 'Corner Kicks': 5 } });
  stats(11, 33, 34, { home: { 'Yellow Cards': 2, 'Corner Kicks': 4 }, away: { 'Yellow Cards': 1, 'Corner Kicks': 3 } });

  const h2h = await context.headToHead(33, 34, 6, false);

  assert.strictEqual(h2h.meetings, 2, 'an unplayed meeting is not a meeting');
  assert.strictEqual(h2h.averages.goals, 1.5);     // 3 and 0
  assert.strictEqual(h2h.averages.yellows, 5);     // 7 and 3
  assert.strictEqual(h2h.matches[0].date > h2h.matches[1].date, true, 'most recent first');
});

// A rivalry shows in the numbers without anyone having to assert that a fixture
// is a derby.
test('the head-to-head caveat travels with it', async () => {
  nock(BASE).get('/fixtures/headtohead').query({ h2h: '33-34' }).reply(200, {
    errors: [], response: [fixture(10, '2026-05-01T14:00:00+00:00')]
  });
  stats(10, 33, 34, { home: { 'Yellow Cards': 3 }, away: { 'Yellow Cards': 4 } });

  const h2h = await context.headToHead(33, 34, 6, false);

  assert.match(h2h.note, /describes a rivalry, not a forecast/);
});

test('two teams that have never met is a fact, not a failure', async () => {
  nock(BASE).get('/fixtures/headtohead').query({ h2h: '33-34' }).reply(200, {
    errors: [], response: []
  });

  const h2h = await context.headToHead(33, 34, 6, false);

  assert.strictEqual(h2h.meetings, 0);
  assert.match(h2h.note, /no finished meeting/);
});

// The goals are on the fixture; the statistics are a separate request that can
// fail. Losing the second must not lose the first.
test('a meeting whose statistics fail keeps its score', async () => {
  nock(BASE).get('/fixtures/headtohead').query({ h2h: '33-34' }).reply(200, {
    errors: [], response: [fixture(10, '2026-05-01T14:00:00+00:00', { homeGoals: 3, awayGoals: 2 })]
  });
  // No statistics interceptor: nock fails the request.

  const h2h = await context.headToHead(33, 34, 6, false);

  assert.strictEqual(h2h.meetings, 1);
  assert.strictEqual(h2h.averages.goals, 5);
  assert.strictEqual(h2h.averages.yellows, null, 'the missing statistic is null, not zero');
});
