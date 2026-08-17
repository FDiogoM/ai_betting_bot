'use strict';

const test = require('node:test');
const assert = require('node:assert');

const poisson = require('../baselines/poisson');

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9,
    `${message}: expected ${expected}, got ${actual}`);
}

test('pmf matches hand-computed values', () => {
  // P(X=0 | λ=2) = e^-2
  close(poisson.pmf(2, 0), Math.exp(-2), 'pmf(2,0)');
  // P(X=1 | λ=2) = 2 e^-2
  close(poisson.pmf(2, 1), 2 * Math.exp(-2), 'pmf(2,1)');
  // P(X=2 | λ=2) = 2 e^-2
  close(poisson.pmf(2, 2), 2 * Math.exp(-2), 'pmf(2,2)');
});

test('cdf sums the pmf', () => {
  // P(X<=2 | λ=2) = e^-2 (1 + 2 + 2) = 5 e^-2
  close(poisson.cdf(2, 2), 5 * Math.exp(-2), 'cdf(2,2)');
});

test('probOver at a half line is one minus the cdf below it', () => {
  // Over 2.5 means X >= 3, so 1 - P(X<=2) = 1 - 5 e^-2
  close(poisson.probOver(2, 2.5), 1 - 5 * Math.exp(-2), 'probOver(2, 2.5)');
});

test('over and under are complementary', () => {
  close(poisson.probOver(9.9, 9.5) + poisson.probUnder(9.9, 9.5), 1, 'over + under');
});

// A whole line produces a push, and the ledger has no representation for a
// pushed corner bet. Rejecting it is better than silently pricing it as a loss.
test('a whole line is rejected', () => {
  assert.throws(() => poisson.probOver(9.9, 10), /half-integer/i);
});

test('probOver decreases monotonically as the line rises', () => {
  const lines = [7.5, 8.5, 9.5, 10.5, 11.5];
  const ps = lines.map((l) => poisson.probOver(9.9, l));
  for (let i = 1; i < ps.length; i += 1) {
    assert.ok(ps[i] < ps[i - 1], `P(over ${lines[i]}) must be below P(over ${lines[i - 1]})`);
  }
});

test('a lambda of zero can never clear a line', () => {
  assert.strictEqual(poisson.probOver(0, 0.5), 0);
  assert.strictEqual(poisson.pmf(0, 0), 1);
});

test('a large lambda stays numerically sane', () => {
  const p = poisson.probOver(25, 24.5);
  assert.ok(p > 0.4 && p < 0.6, `expected roughly a half, got ${p}`);
});

test('a negative lambda is rejected', () => {
  assert.throws(() => poisson.pmf(-1, 0), /lambda/i);
});
