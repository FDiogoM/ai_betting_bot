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

// record_prediction derives the baseline and the market view rather than being
// handed them, so a test that records anything has to stand up the data they
// are derived FROM. That is the point: there is no longer a way to write a
// prediction whose baseline nobody computed.
//
// The scenario below is fixed so the derived numbers are known:
//   home team 33 — four home matches, 6 corners for and 4 against
//   away team 34 — four away matches, 5 corners for and 5 against
//   λ_home = (6 + 5) / 2 = 5.5, λ_away = (5 + 4) / 2 = 4.5, λ_total = 10
//   P(over 9.5 | λ = 10) = 0.5421, so P(under 9.5) = 0.4579
const DERIVED_OVER = 0.5421;
const DERIVED_UNDER = 0.4579;
const BEST_PRICE = 1.95;

function finished(id, homeId, awayId) {
  return {
    fixture: { id, status: { short: 'FT' }, date: `2026-08-0${id}T12:00:00+00:00` },
    league: { id: 94, name: 'Primeira Liga', season: 2026 },
    teams: { home: { id: homeId, name: `T${homeId}` }, away: { id: awayId, name: `T${awayId}` } },
    goals: { home: 1, away: 1 }
  };
}

function cornerStats(fixtureId, teamA, cornersA, teamB, cornersB) {
  nock(BASE).get('/fixtures/statistics').query({ fixture: String(fixtureId) })
    .reply(200, {
      errors: [],
      response: [
        { team: { id: teamA }, statistics: [{ type: 'Corner Kicks', value: cornersA }] },
        { team: { id: teamB }, statistics: [{ type: 'Corner Kicks', value: cornersB }] }
      ]
    });
}

function stubScenario() {
  nock(BASE).get('/fixtures').query({ id: '500' }).reply(200, {
    errors: [],
    response: [{
      fixture: { id: 500, status: { short: 'NS' }, date: '2026-08-22T19:00:00+00:00' },
      league: { id: 94, name: 'Primeira Liga', season: 2026 },
      teams: { home: { id: 33, name: 'Home FC' }, away: { id: 34, name: 'Away FC' } }
    }]
  });

  nock(BASE).get('/fixtures').query({ team: '33', last: '4' }).reply(200, {
    errors: [], response: [1, 2, 3, 4].map((i) => finished(i, 33, 90 + i))
  });
  nock(BASE).get('/fixtures').query({ team: '34', last: '4' }).reply(200, {
    errors: [], response: [5, 6, 7, 8].map((i) => finished(i, 90 + i, 34))
  });

  for (const i of [1, 2, 3, 4]) cornerStats(i, 33, 6, 90 + i, 4);
  for (const i of [5, 6, 7, 8]) cornerStats(i, 34, 5, 90 + i, 5);

  nock(BASE).get('/odds').query({ fixture: '500' }).reply(200, {
    errors: [],
    response: [{
      bookmakers: [{
        name: 'Bet365',
        bets: [{
          name: 'Corners Over Under',
          values: [{ value: 'Over 9.5', odd: String(BEST_PRICE) },
            { value: 'Under 9.5', odd: String(BEST_PRICE) }]
        }]
      }]
    }]
  });
}

function prediction(overrides = {}) {
  return {
    fixtureId: 500,
    market: { family: 'corners', selection: 'over', line: 9.5 },
    matchCount: 4,
    agent: { probability: 0.62, confidence: 'medium', divergenceReason: 'both keepers punt long',
      stake: 1 },
    ...overrides
  };
}

test.beforeEach(() => {
  nock.cleanAll();
  process.env.API_FOOTBALL_KEY = 'test-key-123';
  process.env.MCP_LEDGER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ledger-'));
  // Without this the suite would write into the real cache beside the server.
  process.env.MCP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ledger-cache-'));
  stubScenario();
});

test.afterEach(() => {
  fs.rmSync(process.env.MCP_LEDGER_DIR, { recursive: true, force: true });
  fs.rmSync(process.env.MCP_CACHE_DIR, { recursive: true, force: true });
});

test('append writes one JSON line into the month file', () => {
  store.append({ type: 'prediction', id: 'a', recordedAt: '2026-08-22T09:00:00.000Z' });
  store.append({ type: 'prediction', id: 'b', recordedAt: '2026-08-23T09:00:00.000Z' });

  const file = path.join(store.ledgerDir(), '2026-08.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(JSON.parse(lines[0]).id, 'a');
});

test('records in different months land in different files', () => {
  store.append({ type: 'prediction', id: 'a', recordedAt: '2026-08-31T23:00:00.000Z' });
  store.append({ type: 'prediction', id: 'b', recordedAt: '2026-09-01T01:00:00.000Z' });

  assert.deepStrictEqual(
    fs.readdirSync(store.ledgerDir()).sort(),
    ['2026-08.jsonl', '2026-09.jsonl']
  );
});

test('readAll returns every record across months in order', () => {
  store.append({ type: 'prediction', id: 'a', recordedAt: '2026-08-31T23:00:00.000Z' });
  store.append({ type: 'prediction', id: 'b', recordedAt: '2026-09-01T01:00:00.000Z' });

  assert.deepStrictEqual(store.readAll().map((r) => r.id), ['a', 'b']);
});

test('readAll on an absent ledger is empty, not an error', () => {
  fs.rmSync(process.env.MCP_LEDGER_DIR, { recursive: true, force: true });

  assert.deepStrictEqual(store.readAll(), []);
});

// A truncated final line (a crash mid-write) must not make the whole record
// unreadable — the rest of the history is still good.
test('readAll skips a corrupt line and keeps the rest', () => {
  store.append({ type: 'prediction', id: 'a', recordedAt: '2026-08-22T09:00:00.000Z' });
  fs.appendFileSync(path.join(store.ledgerDir(), '2026-08.jsonl'), '{"type":"pred\n', 'utf8');
  store.append({ type: 'prediction', id: 'c', recordedAt: '2026-08-22T10:00:00.000Z' });

  assert.deepStrictEqual(store.readAll().map((r) => r.id), ['a', 'c']);
});

test('record_prediction writes a prediction and returns its id', async () => {
  const result = await handlers().get('record_prediction').handler(prediction());

  assert.ok(!result.isError, result.content[0].text);
  const body = JSON.parse(result.content[0].text);
  assert.match(body.id, /^2026-08-22-500-corners-over9\.5$/);

  const stored = store.readAll();
  assert.strictEqual(stored.length, 1);
  assert.strictEqual(stored[0].type, 'prediction');
  assert.strictEqual(stored[0].agent.probability, 0.62);
});

test('record_prediction computes edge and expected value itself', async () => {
  await handlers().get('record_prediction').handler(prediction());

  const [stored] = store.readAll();
  // 0.62 - 1/1.95 = 0.107179..., and 0.62*0.95 - 0.38 = 0.209
  assert.ok(Math.abs(stored.edge - 0.107179) < 1e-5, `edge was ${stored.edge}`);
  assert.ok(Math.abs(stored.expectedValue - 0.209) < 1e-6, `EV was ${stored.expectedValue}`);
});

// This is where the design stops being an intention and becomes mechanism.
test('a divergence from the baseline without a reason is refused', async () => {
  const p = prediction();
  delete p.agent.divergenceReason;

  const result = await handlers().get('record_prediction').handler(p);

  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /divergenceReason/i);
  assert.deepStrictEqual(store.readAll(), [], 'nothing may be written when validation fails');
});

test('agreeing with the baseline needs no reason', async () => {
  const p = prediction();
  p.agent.probability = DERIVED_OVER;     // exactly the derived baseline
  delete p.agent.divergenceReason;

  const result = await handlers().get('record_prediction').handler(p);

  assert.ok(!result.isError, result.content[0].text);
});

test('a divergence inside the threshold needs no reason', async () => {
  const p = prediction();
  p.agent.probability = DERIVED_OVER + 0.02;
  delete p.agent.divergenceReason;

  const result = await handlers().get('record_prediction').handler(p);

  assert.ok(!result.isError, result.content[0].text);
});

// The whole reason record_prediction was changed. A caller used to hand in the
// baseline as text, and a run on 2026-08-18 quietly tidied the duplicated venue
// caveats out of what it wrote — harmless in itself, and proof that the number
// the entire record rests on was editable in transit.
test('a baseline supplied by the caller is ignored in favour of the derived one', async () => {
  const p = prediction();
  p.baseline = {
    probability: 0.99, empiricalRate: 0.99, empiricalSample: 999,
    lambda: 99, dispersionRatio: 1, caveats: ['nothing to worry about here']
  };
  p.marketView = { consensusProbability: 0.99, bestPrice: 50, bookmaker: 'Invented', overround: 0 };

  const result = await handlers().get('record_prediction').handler(p);

  assert.ok(!result.isError, result.content[0].text);
  const [stored] = store.readAll();

  assert.strictEqual(stored.baseline.probability, DERIVED_OVER, 'the derived probability wins');
  assert.strictEqual(stored.baseline.lambda, 10);
  assert.strictEqual(stored.marketView.bestPrice, BEST_PRICE);
  assert.strictEqual(stored.marketView.bookmaker, 'Bet365');
  assert.ok(stored.baseline.caveats.some((c) => /league normalisation/.test(c)),
    'the real caveats are recorded, not the flattering ones');
  assert.ok(!stored.baseline.caveats.includes('nothing to worry about here'));
});

test('the derived record is echoed back so the caller can check it', async () => {
  const result = await handlers().get('record_prediction').handler(prediction());

  const body = JSON.parse(result.content[0].text);
  assert.strictEqual(body.baseline.probability, DERIVED_OVER);
  assert.strictEqual(body.marketView.bestPrice, BEST_PRICE);
});

test('an under records the under side of both the baseline and the market', async () => {
  const p = prediction({ market: { family: 'corners', selection: 'under', line: 9.5 } });
  p.agent.probability = DERIVED_UNDER;
  delete p.agent.divergenceReason;

  const result = await handlers().get('record_prediction').handler(p);

  assert.ok(!result.isError, result.content[0].text);
  const [stored] = store.readAll();
  assert.strictEqual(stored.baseline.probability, DERIVED_UNDER);
});

test('a selection nobody quotes is refused rather than recorded without a price', async () => {
  // The scenario quotes 9.5 only. A baseline exists for 8.5, but no price does,
  // and a prediction with no price has no edge.
  const p = prediction({ market: { family: 'corners', selection: 'over', line: 8.5 } });
  delete p.agent.divergenceReason;
  p.agent.probability = 0.7;

  const result = await handlers().get('record_prediction').handler(p);

  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /quotes line 8\.5|no bookmaker/i);
  assert.deepStrictEqual(store.readAll(), []);
});

test('a prediction with no agent probability is refused', async () => {
  const p = prediction();
  delete p.agent.probability;

  const result = await handlers().get('record_prediction').handler(p);

  assert.strictEqual(result.isError, true);
  assert.deepStrictEqual(store.readAll(), []);
});

test('a whole market line is refused', async () => {
  const p = prediction();
  p.market.line = 10;

  const result = await handlers().get('record_prediction').handler(p);

  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /half-integer|line/i);
});

test('recording the same selection twice is refused', async () => {
  await handlers().get('record_prediction').handler(prediction());

  const result = await handlers().get('record_prediction').handler(prediction());

  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /already recorded/i);
  assert.strictEqual(store.readAll().length, 1, 'the ledger must not gain a duplicate');
});

test('a confidence outside the enum is refused', async () => {
  const p = prediction();
  p.agent.confidence = 'very high';

  const result = await handlers().get('record_prediction').handler(p);

  assert.strictEqual(result.isError, true);
});
