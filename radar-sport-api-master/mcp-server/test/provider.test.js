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

// /status is the one endpoint whose documented payload is an object, not an
// array, so `data[0]` reports no account at all against the real API.
test('get_api_status reports the account from the documented object payload', async () => {
  nock(BASE).get('/status').reply(200, {
    errors: [],
    response: { account: { firstname: 'test' }, subscription: { plan: 'Free' }, requests: { current: 13, limit_day: 100 } }
  });

  const server = fakeServer();
  reference.register(server);
  const result = await server.tools.get('get_api_status').handler({});

  assert.ok(!result.isError, result.content[0].text);
  const body = JSON.parse(result.content[0].text);
  assert.ok(body.account, 'an object-shaped /status payload must not read as no account');
  assert.strictEqual(body.account.subscription.plan, 'Free');
  assert.match(result.content[0].text, /100/);
});

// No code on this branch has run against the real API, so both shapes are
// pinned rather than betting on one.
test('get_api_status also tolerates an array-wrapped /status payload', async () => {
  nock(BASE).get('/status').reply(200, {
    errors: [],
    response: [{ account: { firstname: 'test' }, subscription: { plan: 'Free' }, requests: { current: 13, limit_day: 100 } }]
  });

  const server = fakeServer();
  reference.register(server);
  const result = await server.tools.get('get_api_status').handler({});

  assert.ok(!result.isError, result.content[0].text);
  const body = JSON.parse(result.content[0].text);
  assert.ok(body.account, 'an array-shaped /status payload must still yield an account');
  assert.strictEqual(body.account.subscription.plan, 'Free');
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
