'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { evaluate } = require('../baselines/value');

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: expected ${expected}, got ${actual}`);
}

// The worked example from the spec: p = 0.62 at 1.95.
test('edge and expected value match the spec\'s worked example', () => {
  const v = evaluate(0.62, 1.95);

  close(v.impliedProbability, 1 / 1.95, 'implied');
  close(v.edge, 0.62 - 1 / 1.95, 'edge');          // 0.107179...
  close(v.expectedValue, 0.209, 'EV per unit');    // 0.62*0.95 - 0.38
});

// The margin is a real cost to whoever takes the price, so the edge is measured
// against the raw implied probability, not against a de-vigged consensus.
test('the edge is measured against the raw price, not a fair one', () => {
  const v = evaluate(0.5, 1.90);

  assert.ok(v.edge < 0, 'backing a coin flip at 1.90 is a losing bet, and must read as one');
  close(v.edge, 0.5 - 1 / 1.9, 'negative edge');
});

test('a fair bet has zero edge and zero expected value', () => {
  const v = evaluate(0.5, 2);

  close(v.edge, 0, 'edge');
  close(v.expectedValue, 0, 'EV');
});

test('expected value scales with the stake', () => {
  const v = evaluate(0.62, 1.95, 0.5);

  close(v.expectedValueOnStake, 0.209 * 0.5, 'half a unit');
  assert.strictEqual(v.stakeUnits, 0.5);
});

test('stake defaults to one full unit', () => {
  assert.strictEqual(evaluate(0.62, 1.95).stakeUnits, 1);
});

test('a probability outside zero and one is rejected', () => {
  assert.throws(() => evaluate(1.2, 1.95), /probability/i);
  assert.throws(() => evaluate(-0.1, 1.95), /probability/i);
});

test('a stake above one unit is rejected', () => {
  assert.throws(() => evaluate(0.62, 1.95, 1.5), /stake/i);
});

test('an invalid odd is rejected', () => {
  assert.throws(() => evaluate(0.62, 1), /decimal odd/i);
});
