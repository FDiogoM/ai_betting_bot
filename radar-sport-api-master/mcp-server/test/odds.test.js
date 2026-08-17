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
