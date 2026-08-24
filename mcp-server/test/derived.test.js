'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { derivedMarkets, scoreMatrix, MAX_GOALS } = require('../baselines/derived');

function close(actual, expected, message, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) < tolerance,
    `${message}: expected ${expected}, got ${actual}`);
}

test('the score matrix is a probability distribution', () => {
  const { cells } = scoreMatrix(1.4, 1.1);

  close(cells.reduce((a, c) => a + c.probability, 0), 1, 'the cells must sum to 1');
  assert.ok(cells.every((c) => c.probability >= 0), 'no cell may be negative');
  assert.strictEqual(cells.length, (MAX_GOALS + 1) ** 2);
});

// The tail past ten goals a side is real but negligible, and it is redistributed
// rather than dropped so every market below still sums correctly.
test('the truncated tail is reported and is tiny', () => {
  const { truncatedMass } = scoreMatrix(1.4, 1.1);

  assert.ok(truncatedMass > 0, 'some mass is always beyond the cut');
  assert.ok(truncatedMass < 1e-6, `expected a negligible tail, got ${truncatedMass}`);
});

test('every derived market is internally consistent', () => {
  const d = derivedMarkets(1.5, 1.2);

  close(d.matchResult.home + d.matchResult.draw + d.matchResult.away, 1, '1X2 must sum to 1', 1e-4);
  close(d.bothTeamsToScore.yes + d.bothTeamsToScore.no, 1, 'BTTS must sum to 1', 1e-4);
  close(d.oddEven.odd + d.oddEven.even, 1, 'odd/even must sum to 1', 1e-4);
  // Every result makes exactly two of the three double chances good.
  close(d.doubleChance.homeOrDraw + d.doubleChance.awayOrDraw + d.doubleChance.homeOrAway, 2,
    'the three double chances must sum to 2', 1e-4);
});

test('a double chance is its two components', () => {
  const d = derivedMarkets(1.5, 1.2);

  close(d.doubleChance.homeOrDraw, d.matchResult.home + d.matchResult.draw, '1X', 1e-4);
  close(d.doubleChance.awayOrDraw, d.matchResult.away + d.matchResult.draw, 'X2', 1e-4);
  close(d.doubleChance.homeOrAway, d.matchResult.home + d.matchResult.away, '12', 1e-4);
});

test('equal scoring rates give a symmetric match', () => {
  const d = derivedMarkets(1.3, 1.3);

  close(d.matchResult.home, d.matchResult.away, 'neither side can be favoured', 1e-9);
  close(d.cleanSheet.home, d.cleanSheet.away, 'nor either clean sheet', 1e-9);
  close(d.winToNil.home, d.winToNil.away, 'nor either win to nil', 1e-9);
});

test('a stronger side is favoured, and by more as the gap widens', () => {
  const slight = derivedMarkets(1.6, 1.4);
  const wide = derivedMarkets(2.6, 0.6);

  assert.ok(slight.matchResult.home > slight.matchResult.away);
  assert.ok(wide.matchResult.home > slight.matchResult.home,
    'a bigger edge in lambda must mean a bigger edge in the market');
  assert.ok(wide.matchResult.draw < slight.matchResult.draw,
    'and a mismatched game draws less often');
});

// Under independent Poissons this has a closed form, so the matrix can be
// checked against arithmetic rather than against itself.
test('both teams to score matches its closed form', () => {
  const lh = 1.7;
  const la = 1.1;
  const expected = (1 - Math.exp(-lh)) * (1 - Math.exp(-la));

  close(derivedMarkets(lh, la).bothTeamsToScore.yes, expected, 'BTTS', 1e-4);
});

test('a clean sheet is the other side failing to score', () => {
  const d = derivedMarkets(1.7, 1.1);

  close(d.cleanSheet.home, Math.exp(-1.1), 'home clean sheet is P(away scores 0)', 1e-4);
  close(d.cleanSheet.away, Math.exp(-1.7), 'away clean sheet is P(home scores 0)', 1e-4);
});

test('correct scores are ranked and sum to less than one', () => {
  const d = derivedMarkets(1.5, 1.2);

  const total = d.correctScore.reduce((a, s) => a + s.probability, 0);
  assert.ok(total < 1, 'the listed scores are a subset, not the whole distribution');
  assert.ok(total > 0.75, 'but the common scores should cover most of it');
  for (let i = 1; i < d.correctScore.length; i += 1) {
    assert.ok(d.correctScore[i - 1].probability >= d.correctScore[i].probability,
      'most likely first');
  }
});

test('team totals read off the right side', () => {
  const d = derivedMarkets(2.0, 0.5);
  const homeOver05 = d.teamTotals.home.find((t) => t.line === 0.5);
  const awayOver05 = d.teamTotals.away.find((t) => t.line === 0.5);

  close(homeOver05.over, 1 - Math.exp(-2.0), 'home scores at all', 1e-4);
  close(awayOver05.over, 1 - Math.exp(-0.5), 'away scores at all', 1e-4);
  close(homeOver05.over + homeOver05.under, 1, 'over and under must partition', 1e-4);
});

// The assumption is not hidden and is not optional reading: it is what makes
// the draw and the low scores slightly wrong.
test('the independence assumption travels with the numbers', () => {
  const d = derivedMarkets(1.5, 1.2);

  assert.ok(d.caveats.some((c) => /independent Poissons/i.test(c) && /Dixon-Coles/i.test(c)),
    `the assumption must be declared, got: ${d.caveats.join(' | ')}`);
});

test('a negative rate is refused rather than priced', () => {
  assert.throws(() => derivedMarkets(-1, 1.2), /lambdaHome/);
  assert.throws(() => derivedMarkets(1.2, NaN), /lambdaAway/);
});
