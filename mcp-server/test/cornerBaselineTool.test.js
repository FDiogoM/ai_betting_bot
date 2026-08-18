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

// Task 5b: the season split is only meaningful if the tool tells the pure
// baseline which season the fixture belongs to.
test('the fixture\'s season is passed through so the sample split is reported', async () => {
  const withSeason = upcomingFixture();
  withSeason.response[0].league.season = 2026;

  nock(BASE).get('/fixtures').query({ id: '500' }).reply(200, withSeason);
  mockTeam(33, 34, 'home', 6, 4);
  mockTeam(34, 33, 'away', 5, 5);

  const result = await handlers().get('get_corner_baseline').handler({ fixtureId: 500, matchCount: 4 });

  const body = JSON.parse(result.content[0].text);
  assert.ok(body.sampleSeasons, 'a fixture carrying a season must produce a split');
  assert.strictEqual(body.sampleSeasons.home.current + body.sampleSeasons.home.previous, 4);
});
