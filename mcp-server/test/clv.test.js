'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { closingLineValue, summariseClv, MAX_SNAPSHOT_AGE_MINUTES } = require('../baselines/clv');

function close(actual, expected, message, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) < tolerance,
    `${message}: expected ${expected}, got ${actual}`);
}

// --- one measurement ---------------------------------------------------------

test('a price that shortened after being taken is positive value', () => {
  // Taken at 2.95, closed at 2.32: the market moved toward this selection.
  const v = closingLineValue({
    takenPrice: 2.95, closingPrice: 2.32, closingFairProbability: 0.42,
    minutesBeforeKickoff: 18
  });

  assert.strictEqual(v.measurable, true);
  assert.strictEqual(v.beatTheClose, true);
  close(v.priceValue, 2.95 / 2.32 - 1, 'price value');
  close(v.probabilityValue, 0.42 - 1 / 2.95, 'probability value');
});

test('a price that drifted is negative value, however the bet finished', () => {
  const v = closingLineValue({
    takenPrice: 2.10, closingPrice: 2.20, closingFairProbability: 0.44,
    minutesBeforeKickoff: 30
  });

  assert.strictEqual(v.beatTheClose, false);
  assert.ok(v.priceValue < 0);
  assert.ok(v.probabilityValue < 0, 'bought above what the market finally thought it was worth');
});

// The two measures answer different questions and neither subsumes the other:
// the price ratio still carries the bookmaker's margin, and margin is not value.
test('the two measures can disagree, and the probability one is the scoreable one', () => {
  // The price is better, but the de-vigged close says it was still too short.
  const v = closingLineValue({
    takenPrice: 2.05, closingPrice: 2.00, closingFairProbability: 0.47,
    minutesBeforeKickoff: 20
  });

  assert.ok(v.priceValue > 0, 'it pays more than the closing price');
  assert.ok(v.probabilityValue < 0, 'and is still short of the market\'s final estimate');
  assert.strictEqual(v.beatTheClose, false, 'the probability measure decides');
});

test('a snapshot too far from kickoff is marked stale rather than trusted', () => {
  const fresh = closingLineValue({
    takenPrice: 2.5, closingPrice: 2.2, closingFairProbability: 0.44, minutesBeforeKickoff: 15
  });
  const old = closingLineValue({
    takenPrice: 2.5, closingPrice: 2.2, closingFairProbability: 0.44,
    minutesBeforeKickoff: MAX_SNAPSHOT_AGE_MINUTES + 1
  });

  assert.strictEqual(fresh.stale, false);
  assert.strictEqual(old.stale, true);
  assert.match(old.note, /indicative/);
  // The numbers are still computed; only their weight changes.
  assert.strictEqual(old.probabilityValue, fresh.probabilityValue);
});

test('an unknown snapshot age is stale, not assumed fresh', () => {
  const v = closingLineValue({
    takenPrice: 2.5, closingPrice: 2.2, closingFairProbability: 0.44, minutesBeforeKickoff: null
  });

  assert.strictEqual(v.stale, true);
});

test('no closing reading at all is unmeasurable rather than zero', () => {
  const v = closingLineValue({ takenPrice: 2.5 });

  assert.strictEqual(v.measurable, false);
  assert.strictEqual(v.probabilityValue, undefined, 'absent, not a value of zero');
  assert.match(v.note, /unknown/);
});

test('a closing price with no consensus still yields the price comparison', () => {
  const v = closingLineValue({
    takenPrice: 3.0, closingPrice: 2.5, closingFairProbability: null, minutesBeforeKickoff: 10
  });

  assert.strictEqual(v.measurable, true);
  assert.ok(v.priceValue > 0);
  assert.strictEqual(v.probabilityValue, null);
  assert.strictEqual(v.beatTheClose, true, 'it falls back to the price when that is all there is');
});

test('an impossible price taken is refused rather than measured', () => {
  assert.throws(() => closingLineValue({ takenPrice: 1, closingPrice: 2 }), /above 1/);
});

// --- the summary -------------------------------------------------------------

function measurement(probabilityValue, opts = {}) {
  return {
    measurable: true,
    stale: Boolean(opts.stale),
    probabilityValue,
    beatTheClose: probabilityValue > 0
  };
}

test('the summary averages only what could be measured against a real close', () => {
  const s = summariseClv([
    measurement(0.04), measurement(-0.02), measurement(0.01),
    measurement(0.30, { stale: true }),        // excluded: not a close
    { measurable: false }                       // excluded: no reading
  ]);

  assert.strictEqual(s.n, 3);
  assert.strictEqual(s.stale, 1);
  assert.strictEqual(s.unmeasured, 1);
  close(s.meanProbabilityValue, 0.01, 'mean over the usable three');
  assert.strictEqual(s.beatTheClose, 2);
});

// The stale and unreadable ones are counted, not silently dropped: a reader
// needs to know how much of the record could not be measured.
test('what could not be measured is reported rather than hidden', () => {
  const s = summariseClv([{ measurable: false }, measurement(0.1, { stale: true })]);

  assert.strictEqual(s.n, 0);
  assert.strictEqual(s.stale, 1);
  assert.strictEqual(s.unmeasured, 1);
  assert.match(s.note, /nothing measurable/);
});

test('a positive average is called the strongest evidence available, and a negative one is not', () => {
  const good = summariseClv([measurement(0.03), measurement(0.02), measurement(0.04)]);
  const bad = summariseClv([measurement(-0.03), measurement(-0.02), measurement(-0.04)]);

  assert.match(good.note, /strongest evidence of an edge/);
  assert.match(bad.note, /the edge is not there/);
  assert.match(bad.note, /whatever the P&L happens to say/);
});

// Unlike the Brier verdict there is no `insufficient` floor, and that is the
// point: a settled bet yields one bit, a CLV measurement yields a number.
test('a handful of measurements already reports a mean, unlike the Brier verdict', () => {
  const s = summariseClv([measurement(0.02), measurement(0.01)]);

  assert.strictEqual(s.n, 2);
  assert.ok(typeof s.meanProbabilityValue === 'number');
  assert.ok(!/insufficient/i.test(s.note));
});

test('the median is reported beside the mean, so one outlier cannot carry it', () => {
  const s = summariseClv([
    measurement(0.30), measurement(-0.01), measurement(-0.01),
    measurement(-0.01), measurement(-0.01)
  ]);

  assert.ok(s.meanProbabilityValue > 0, 'the outlier pulls the mean positive');
  assert.ok(s.medianProbabilityValue < 0, 'the median says what the typical bet did');
});
