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
