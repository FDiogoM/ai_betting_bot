'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../ledger/store');
const ledger = require('../tools/ledger');

function fakeServer() {
  const tools = new Map();
  return { tools, registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
}

function handlers() {
  const server = fakeServer();
  ledger.register(server);
  return server.tools;
}

function prediction(overrides = {}) {
  return {
    fixture: { id: 500, league: 'Primeira Liga', home: 'Home FC', away: 'Away FC',
      kickoff: '2026-08-22T19:00:00+00:00' },
    market: { family: 'corners', selection: 'over', line: 9.5 },
    baseline: { probability: 0.58, empiricalRate: 0.5, empiricalSample: 10, lambda: 9.9,
      dispersionRatio: 1.4, caveats: ['no league normalisation'] },
    marketView: { consensusProbability: 0.54, bestPrice: 1.95, bookmaker: 'Bet365', overround: 0.045 },
    agent: { probability: 0.62, confidence: 'medium', divergenceReason: 'both keepers punt long',
      stake: 1 },
    ...overrides
  };
}

test.beforeEach(() => {
  process.env.MCP_LEDGER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ledger-'));
});

test.afterEach(() => {
  fs.rmSync(process.env.MCP_LEDGER_DIR, { recursive: true, force: true });
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
  p.agent.probability = 0.58;             // exactly the baseline
  delete p.agent.divergenceReason;

  const result = await handlers().get('record_prediction').handler(p);

  assert.ok(!result.isError, result.content[0].text);
});

test('a divergence inside the threshold needs no reason', async () => {
  const p = prediction();
  p.agent.probability = 0.60;             // 0.02 from the baseline's 0.58
  delete p.agent.divergenceReason;

  const result = await handlers().get('record_prediction').handler(p);

  assert.ok(!result.isError, result.content[0].text);
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
