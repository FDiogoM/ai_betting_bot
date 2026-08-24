'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { timeline, runStrategy, compare, STRATEGIES } = require('../sim/replay');
const { bootstrapStrategy, rng } = require('../sim/bootstrap');

function prediction(id, overrides = {}) {
  return {
    type: 'prediction',
    id,
    recordedAt: overrides.recordedAt || `2026-08-2${id}T09:00:00.000Z`,
    market: { family: overrides.family || 'goals', selection: 'over', line: 2.5 },
    baseline: { probability: overrides.baselineProbability || 0.5 },
    marketView: { bestPrice: overrides.price || 2 },
    agent: { probability: overrides.probability || 0.5, stake: overrides.stake || 1 },
    edge: overrides.edge === undefined ? 0.04 : overrides.edge
  };
}

function settlement(id, outcome) {
  return { type: 'settlement', predictionId: id, outcome, returnUnits: 0 };
}

// --- the timeline ------------------------------------------------------------

test('predictions are replayed in the order they were recorded', () => {
  const rows = timeline(
    [prediction('3'), prediction('1'), prediction('2')],
    [settlement('1', 'win'), settlement('2', 'loss'), settlement('3', 'win')]
  );

  assert.deepStrictEqual(rows.map((r) => r.prediction.id), ['1', '2', '3']);
});

test('an unsettled prediction is carried through marked, not dropped', () => {
  const rows = timeline([prediction('1'), prediction('2')], [settlement('1', 'win')]);

  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].settled, true);
  assert.strictEqual(rows[1].settled, false);
});

// --- staking rules -----------------------------------------------------------

test('the recorded strategy reproduces what was actually staked', () => {
  const rows = timeline(
    [prediction('1', { stake: 0.5, price: 3 }), prediction('2', { stake: 0.25, price: 2 })],
    [settlement('1', 'win'), settlement('2', 'loss')]
  );

  const r = runStrategy(rows, STRATEGIES.recorded);

  assert.strictEqual(r.bets, 2);
  // 0.5 at 3.0 returns 1.0 profit; 0.25 lost.
  assert.ok(Math.abs(r.profitUnits - 0.75) < 1e-9, `profit was ${r.profitUnits}`);
  assert.strictEqual(r.staked, 0.75);
});

test('a void returns the stake and scores nothing', () => {
  const rows = timeline([prediction('1')], [settlement('1', 'void')]);

  const r = runStrategy(rows, STRATEGIES.flat);

  assert.strictEqual(r.voids, 1);
  assert.strictEqual(r.profitUnits, 0, 'a void must not move the bankroll');
  assert.strictEqual(r.hitRate, null, 'and must not count toward a hit rate');
});

test('a filter that passes nothing bets nothing rather than failing', () => {
  const rows = timeline([prediction('1', { edge: 0.01 })], [settlement('1', 'win')]);

  const r = runStrategy(rows, STRATEGIES.edgeFilter5);

  assert.strictEqual(r.bets, 0);
  assert.strictEqual(r.profitUnits, 0);
  assert.strictEqual(r.roi, null, 'no stake means no return on it');
});

test('family filters bet only their own family', () => {
  const rows = timeline(
    [prediction('1', { family: 'goals' }), prediction('2', { family: 'corners' })],
    [settlement('1', 'win'), settlement('2', 'win')]
  );

  assert.strictEqual(runStrategy(rows, STRATEGIES.goalsOnly).bets, 1);
  assert.strictEqual(runStrategy(rows, STRATEGIES.cornersOnly).bets, 1);
});

// The one rule the whole replay depends on. A strategy that could see the
// result would be a fortune teller, and every number it produced would be a
// lie in the flattering direction.
test('no strategy can see the outcome it is about to be scored on', () => {
  const seen = [];
  const spy = new Proxy(prediction('1'), {
    get(target, key) {
      seen.push(String(key));
      return target[key];
    }
  });

  for (const strategy of Object.values(STRATEGIES)) strategy.stake(spy);

  for (const key of seen) {
    assert.ok(!/outcome|settle|won|result|returnUnits/i.test(key),
      `a strategy read "${key}", which is knowledge from after the match`);
  }
});

test('the drawdown is the worst fall from a peak, not the final loss', () => {
  // Win, then two losses: the bankroll peaks after the first and falls twice.
  const rows = timeline(
    [prediction('1'), prediction('2'), prediction('3')],
    [settlement('1', 'win'), settlement('2', 'loss'), settlement('3', 'loss')]
  );

  const r = runStrategy(rows, STRATEGIES.flat, { startingBankroll: 100 });

  assert.strictEqual(r.finalBankroll, 99, '+1 then -1 then -1');
  assert.strictEqual(r.maxDrawdown, 2, 'from a peak of 101 down to 99');
});

test('the comparison runs every strategy over the same history', () => {
  const c = compare(
    [prediction('1'), prediction('2')],
    [settlement('1', 'win'), settlement('2', 'loss')]
  );

  assert.strictEqual(c.settled, 2);
  assert.strictEqual(c.results.length, Object.keys(STRATEGIES).length);
  assert.ok(c.results.every((r) => r.strategy && r.note), 'each must say what it is');
});

// --- the bootstrap -----------------------------------------------------------

function curve(results) {
  return results.map((result, i) => ({ id: String(i), outcome: result > 0 ? 'win' : 'loss', result }));
}

test('the generator is seeded, so a run is reproducible', () => {
  const a = rng(7);
  const b = rng(7);
  const c = rng(8);

  const first = [a(), a(), a()];
  assert.deepStrictEqual([b(), b(), b()], first, 'the same seed must give the same sequence');
  assert.notDeepStrictEqual([c(), c(), c()], first, 'a different one must not');
});

test('the same history and seed give the same distribution twice', () => {
  const rows = curve([1, -1, 1, -1, 1, -1, 1, -1]);

  const a = bootstrapStrategy(rows, { iterations: 500, seed: 3 });
  const b = bootstrapStrategy(rows, { iterations: 500, seed: 3 });

  assert.deepStrictEqual(a, b, 'a simulation that moves between runs cannot be argued with');
});

test('the percentiles bracket the mean and the observed total', () => {
  const rows = curve([2, -1, 2, -1, 2, -1, 2, -1, 2, -1]);

  const b = bootstrapStrategy(rows, { iterations: 5000, seed: 1 });

  assert.strictEqual(b.observedProfit, 5, '5 wins at +2 and 5 losses at -1');
  assert.ok(b.p05 <= b.median && b.median <= b.p95, 'percentiles must be ordered');
  assert.ok(b.p05 < b.observedProfit && b.observedProfit < b.p95,
    'the observed result must sit inside its own distribution');
});

// The verdict the module exists to deliver.
test('a spread that includes zero is reported as not establishing a sign', () => {
  const noisy = bootstrapStrategy(curve([3, -1, -1, 3, -1, -1, 3, -1]), { iterations: 5000, seed: 2 });

  assert.strictEqual(noisy.straddlesZero, true);
  assert.match(noisy.note, /does not establish/);
  assert.ok(noisy.probabilityOfLoss > 0 && noisy.probabilityOfLoss < 1);
});

test('an overwhelming record does not straddle zero', () => {
  const strong = bootstrapStrategy(curve(new Array(40).fill(1)), { iterations: 5000, seed: 4 });

  assert.strictEqual(strong.straddlesZero, false);
  assert.strictEqual(strong.probabilityOfLoss, 0);
});

test('voids are excluded from the resampling', () => {
  const rows = [
    { id: '1', outcome: 'win', result: 1 },
    { id: '2', outcome: 'void', result: 0 },
    { id: '3', outcome: 'loss', result: -1 }
  ];

  assert.strictEqual(bootstrapStrategy(rows, { iterations: 100, seed: 1 }).n, 2);
});

test('too few bets to resample says so rather than returning a distribution', () => {
  const b = bootstrapStrategy(curve([1]), { iterations: 100, seed: 1 });

  assert.strictEqual(b.iterations, 0);
  assert.match(b.note, /too few/);
});
