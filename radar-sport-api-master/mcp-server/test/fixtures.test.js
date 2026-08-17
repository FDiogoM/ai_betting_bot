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
