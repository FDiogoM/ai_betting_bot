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
const stats = require('../tools/stats');

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

function statsHandlers() {
  const server = fakeServer();
  stats.register(server);
  return server.tools;
}

// Cache entries are sha256 hex names. quota.json is a sibling in the same
// directory, so an index-0 read would silently pick up the wrong file the
// moment a mock starts sending rate-limit headers.
function entryNames(dir) {
  return fs.readdirSync(dir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f));
}

function readEntry(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
}

function soleCacheEntry(dir) {
  const names = entryNames(dir);
  assert.strictEqual(names.length, 1,
    `expected exactly one cache entry, found: ${fs.readdirSync(dir).join(', ')}`);
  return readEntry(dir, names[0]);
}

function finishedFixture(id, homeId, awayId) {
  return {
    fixture: { id, status: { short: 'FT' }, date: `2026-08-0${id}T12:00:00+00:00` },
    teams: { home: { id: homeId, name: `T${homeId}` }, away: { id: awayId, name: `T${awayId}` } }
  };
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

  const entry = soleCacheEntry(process.env.MCP_CACHE_DIR);
  assert.strictEqual(entry.expiresAt, null, 'a finished fixture must never expire');
});

test('a scheduled fixture is cached with a short expiry', async () => {
  nock(BASE).get('/fixtures').query({ id: '2' })
    .reply(200, { errors: [], response: [{ fixture: { id: 2, status: { short: 'NS' } } }] });

  await handlers().get('get_fixture').handler({ fixtureId: 2 });

  const entry = soleCacheEntry(process.env.MCP_CACHE_DIR);
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

// {team, last: N} is a sliding window: every member is immutable, but the
// membership changes as soon as the team plays again. Caching it permanently
// pins the answer forever, which the all-finished branch did by construction.
test('a last-N window of finished matches is not cached permanently', async () => {
  nock(BASE).get('/fixtures').query({ team: '33', last: '2' }).reply(200, {
    errors: [], response: [finishedFixture(1, 33, 34), finishedFixture(2, 35, 33)]
  });

  await handlers().get('get_team_fixtures').handler({ teamId: 33, last: 2 });

  const entry = soleCacheEntry(process.env.MCP_CACHE_DIR);
  assert.notStrictEqual(entry.expiresAt, null,
    'a sliding window must expire even when every match in it is finished');
  assert.strictEqual(entry.expiresAt - entry.storedAt, cache.TTL.LIVE);
});

// Same defect: the next meeting between two teams would never appear.
test('a head-to-head history of finished matches is not cached permanently', async () => {
  nock(BASE).get('/fixtures/headtohead').query({ h2h: '33-34' }).reply(200, {
    errors: [], response: [finishedFixture(1, 33, 34), finishedFixture(2, 34, 33)]
  });

  await handlers().get('get_head_to_head').handler({ teamId: 33, opponentId: 34 });

  const entry = soleCacheEntry(process.env.MCP_CACHE_DIR);
  assert.notStrictEqual(entry.expiresAt, null,
    'head-to-head gains new meetings, so it must expire');
  assert.strictEqual(entry.expiresAt - entry.storedAt, cache.TTL.TABLE);
});

// One cache key must have one expiry policy, whichever tool wrote it last.
test('get_team_fixtures and the corner profile agree on the TTL for the same key', async () => {
  const body = { errors: [], response: [finishedFixture(1, 33, 34)] };
  const dirA = process.env.MCP_CACHE_DIR;

  nock(BASE).get('/fixtures').query({ team: '33', last: '1' }).reply(200, body);
  await handlers().get('get_team_fixtures').handler({ teamId: 33, last: 1 });
  const names = entryNames(dirA);
  assert.strictEqual(names.length, 1);
  const fromFixturesTool = readEntry(dirA, names[0]);

  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-fix-b-'));
  process.env.MCP_CACHE_DIR = dirB;
  try {
    nock(BASE).get('/fixtures').query({ team: '33', last: '1' }).reply(200, body);
    nock(BASE).get('/fixtures/statistics').query({ fixture: '1' }).reply(200, {
      errors: [],
      response: [
        { team: { id: 33 }, statistics: [{ type: 'Corner Kicks', value: 5 }] },
        { team: { id: 34 }, statistics: [{ type: 'Corner Kicks', value: 4 }] }
      ]
    });
    await statsHandlers().get('get_team_corner_profile').handler({ teamId: 33, matchCount: 1 });

    assert.ok(entryNames(dirB).includes(names[0]),
      'both paths derive the same cache key, so both must own the same TTL');
    const fromCornerProfile = readEntry(dirB, names[0]);

    const windowA = fromFixturesTool.expiresAt === null
      ? null : fromFixturesTool.expiresAt - fromFixturesTool.storedAt;
    const windowB = fromCornerProfile.expiresAt === null
      ? null : fromCornerProfile.expiresAt - fromCornerProfile.storedAt;
    assert.notStrictEqual(windowA, null, 'the fixtures tool must not write this key permanently');
    assert.notStrictEqual(windowB, null, 'the corner profile must not write this key permanently');
    assert.strictEqual(windowA, windowB,
      `TTL disagreement for one key: ${windowA}ms vs ${windowB}ms`);
  } finally {
    process.env.MCP_CACHE_DIR = dirA;
    fs.rmSync(dirB, { recursive: true, force: true });
  }
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
