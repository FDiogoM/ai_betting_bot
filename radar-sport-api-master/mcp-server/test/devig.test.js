'use strict';

const test = require('node:test');
const assert = require('node:assert');

const devig = require('../baselines/devig');

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
}

test('implied probability is the reciprocal of the price', () => {
  close(devig.impliedProbability(2), 0.5, 'even money');
  close(devig.impliedProbability(1.95), 1 / 1.95, '1.95');
});

test('overround is what the two sides sum to above one', () => {
  // 1/1.95 + 1/1.85 = 0.512820... + 0.540540... = 1.053361...
  close(devig.overround([1.95, 1.85]), 1 / 1.95 + 1 / 1.85 - 1, 'two-way overround');
});

test('a fair book has no overround', () => {
  close(devig.overround([2, 2]), 0, 'two evens');
});

test('fair probabilities sum to one and keep their ordering', () => {
  const fair = devig.fairProbabilities([1.95, 1.85]);

  close(fair[0] + fair[1], 1, 'de-vigged sum');
  assert.ok(fair[1] > fair[0], 'the shorter price must carry the larger probability');
  close(fair[0], (1 / 1.95) / (1 / 1.95 + 1 / 1.85), 'proportional de-vig');
});

test('median takes the middle of an odd-length sample', () => {
  assert.strictEqual(devig.median([0.5, 0.52, 0.55]), 0.52);
});

test('median averages the two middles of an even-length sample', () => {
  assert.strictEqual(devig.median([0.5, 0.52, 0.54, 0.56]), 0.53);
});

test('median does not mutate its input', () => {
  const input = [0.6, 0.4, 0.5];
  devig.median(input);
  assert.deepStrictEqual(input, [0.6, 0.4, 0.5], 'sorting must happen on a copy');
});

test('bestPrice picks the highest odd and names the bookmaker', () => {
  const best = devig.bestPrice([
    { bookmaker: 'A', odd: 1.9 },
    { bookmaker: 'B', odd: 2.05 },
    { bookmaker: 'C', odd: 1.95 }
  ]);

  assert.strictEqual(best.bookmaker, 'B');
  assert.strictEqual(best.odd, 2.05);
});

test('an odd of one or less is rejected', () => {
  assert.throws(() => devig.impliedProbability(1), /decimal odd/i);
  assert.throws(() => devig.impliedProbability(0), /decimal odd/i);
});

test('an empty quote list has no best price', () => {
  assert.throws(() => devig.bestPrice([]), /no quotes/i);
});
