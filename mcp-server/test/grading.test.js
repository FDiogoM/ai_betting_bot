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
