'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { evaluateMultiple } = require('../baselines/multiple');
const correlation = require('../baselines/correlation');
const { totalsByFixture } = require('../aggregate/jointProfile');

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: expected ${expected}, got ${actual}`);
}

// --- combining ---------------------------------------------------------------

test('prices and probabilities both multiply', () => {
  const m = evaluateMultiple([
    { probability: 0.5, decimalOdd: 2.2 },
    { probability: 0.5, decimalOdd: 2.2 }
  ]);

  close(m.probability, 0.25, 'combined probability');
  close(m.decimalOdd, 4.84, 'combined price');
  assert.strictEqual(m.independence.assumed, true);
});

// The case for multiples, and it is real: an edge on every leg compounds.
test('an edge on every leg compounds into a larger one', () => {
  const legs = [{ probability: 0.55, decimalOdd: 2 }, { probability: 0.55, decimalOdd: 2 }];
  const single = legs[0].probability * legs[0].decimalOdd - 1;   // +10%
  const m = evaluateMultiple(legs);

  // 0.55^2 x 4 = 1.21, so +21% against +10% on either leg alone.
  close(m.expectedValue, 0.21, 'combined expected value');
  assert.ok(m.expectedValue > single * 2 * 0.9, 'the edges must compound, not merely add');
});

// And the case against, which is just as real.
test('the bookmaker margin compounds too', () => {
  const m = evaluateMultiple([
    { probability: 0.5, decimalOdd: 2, overround: 0.06 },
    { probability: 0.5, decimalOdd: 2, overround: 0.06 },
    { probability: 0.5, decimalOdd: 2, overround: 0.06 },
    { probability: 0.5, decimalOdd: 2, overround: 0.06 }
  ]);

  // 1.06^4 - 1 = 0.2625: four 6% markets are a 26% one.
  close(m.margin.compounded, 0.262477, 'compounded margin');
  assert.match(m.margin.note, /26\.2%/);
});

test('a leg without an overround leaves the compounded margin unstated, not guessed', () => {
  const m = evaluateMultiple([
    { probability: 0.5, decimalOdd: 2, overround: 0.06 },
    { probability: 0.5, decimalOdd: 2 }
  ]);

  assert.strictEqual(m.margin.compounded, null);
  assert.match(m.margin.note, /cannot be stated/);
});

test('the singles comparison is returned beside every answer', () => {
  const m = evaluateMultiple([
    { probability: 0.8, decimalOdd: 1.35 },
    { probability: 0.8, decimalOdd: 1.35 },
    { probability: 0.8, decimalOdd: 1.35 },
    { probability: 0.8, decimalOdd: 1.35 }
  ]);

  // Four "safe" legs at 80% win together 41% of the time.
  close(m.probability, 0.4096, 'combined probability');
  close(m.versusSingles.multipleLosesEverything, 0.5904, 'multiple total loss');
  // The same four singles all lose 0.2^4 = 0.16% of the time.
  close(m.versusSingles.singlesLoseEverything, 0.0016, 'singles total loss');
  assert.ok(m.versusSingles.multipleLosesEverything > m.versusSingles.singlesLoseEverything * 100,
    'the variance difference is the whole decision and must be visible');
});

test('a combination needs at least two legs and refuses bad inputs', () => {
  assert.throws(() => evaluateMultiple([{ probability: 0.5, decimalOdd: 2 }]), /at least two/);
  assert.throws(() => evaluateMultiple([
    { probability: 1.2, decimalOdd: 2 }, { probability: 0.5, decimalOdd: 2 }
  ]), /probability must be between/);
  assert.throws(() => evaluateMultiple([
    { probability: 0.5, decimalOdd: 0.9 }, { probability: 0.5, decimalOdd: 2 }
  ]), /decimal odd must be above 1/);
});

// --- correlation -------------------------------------------------------------

function sample(pairs) {
  return pairs.map(([totalGoals, totalCorners]) => ({ totalGoals, totalCorners }));
}

const OVER_GOALS = { key: 'totalGoals', selection: 'over', line: 2.5 };
const OVER_CORNERS = { key: 'totalCorners', selection: 'over', line: 9.5 };

test('a sample too thin to support a joint rate says so instead of guessing', () => {
  const thin = correlation.empiricalJoint(sample([[3, 10], [1, 8]]), [OVER_GOALS, OVER_CORNERS]);

  assert.strictEqual(thin.lift, null);
  assert.match(thin.note, /below the 16/);
});

test('a pair that lands together more often than chance lifts above 1', () => {
  // 20 matches: both high in 10, both low in 10. Perfectly tied.
  const rows = [];
  for (let i = 0; i < 10; i += 1) rows.push([4, 12]);
  for (let i = 0; i < 10; i += 1) rows.push([1, 6]);

  const c = correlation.empiricalJoint(sample(rows), [OVER_GOALS, OVER_CORNERS]);

  assert.deepStrictEqual(c.marginalRates, [0.5, 0.5]);
  close(c.independentProduct, 0.25, 'independent product');
  close(c.jointRate, 0.5, 'observed joint rate');
  // Raw lift is 2, clamped: no sample of this size justifies doubling.
  assert.strictEqual(c.clamped, true);
  assert.strictEqual(c.lift, correlation.MAX_LIFT);
  assert.match(c.note, /describes the sample, not football/);
});

test('a pair that is close to independent reports a lift near 1', () => {
  // Deliberately mixed, so neither total predicts the other.
  const rows = [];
  for (let i = 0; i < 5; i += 1) { rows.push([4, 12]); rows.push([4, 6]); rows.push([1, 12]); rows.push([1, 6]); }

  const c = correlation.empiricalJoint(sample(rows), [OVER_GOALS, OVER_CORNERS]);

  close(c.lift, 1, 'independence must read as a lift of 1');
  assert.strictEqual(c.clamped, false);
});

test('a selection that never landed yields no ratio rather than a zero one', () => {
  const rows = [];
  for (let i = 0; i < 20; i += 1) rows.push([1, 12]);   // over 2.5 goals never happens

  const c = correlation.empiricalJoint(sample(rows), [OVER_GOALS, OVER_CORNERS]);

  assert.strictEqual(c.lift, null);
  assert.match(c.note, /never landed/);
});

test('the joint probability applies the lift to the model marginals', () => {
  const applied = correlation.jointProbability([0.5, 0.5], 1.2);
  close(applied.probability, 0.3, 'lifted product');
  assert.strictEqual(applied.independent, false);

  const none = correlation.jointProbability([0.5, 0.5], null);
  close(none.probability, 0.25, 'no lift means the bare product');
  assert.strictEqual(none.independent, true);
});

test('a lift cannot push the combined probability to a certainty', () => {
  const applied = correlation.jointProbability([0.95, 0.95], correlation.MAX_LIFT);

  assert.ok(applied.probability < 1, `probability must stay below 1, got ${applied.probability}`);
});

test('pearson reads zero when the two totals do not move together', () => {
  const rows = [];
  for (let i = 0; i < 5; i += 1) { rows.push([4, 12]); rows.push([4, 6]); rows.push([1, 12]); rows.push([1, 6]); }

  close(correlation.pearson(sample(rows), 'totalGoals', 'totalCorners'), 0, 'pearson');
});

// --- the joint sample --------------------------------------------------------

test('matches are joined by fixture id, and one missing either count is dropped', () => {
  const corners = [
    { fixtureId: 1, cornersFor: 6, cornersAgainst: 4 },
    { fixtureId: 2, cornersFor: 5, cornersAgainst: 5 }
  ];
  const goals = [
    { fixtureId: 1, goalsFor: 2, goalsAgainst: 1, date: 'd', season: 2026 },
    { fixtureId: 3, goalsFor: 1, goalsAgainst: 1, date: 'd', season: 2026 }   // no corners
  ];

  const rows = totalsByFixture(corners, goals);

  assert.strictEqual(rows.length, 1, 'only the fixture carrying both counts survives');
  assert.strictEqual(rows[0].fixtureId, 1);
  assert.strictEqual(rows[0].totalGoals, 3);
  assert.strictEqual(rows[0].totalCorners, 10);
});
