'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { cornerBaseline, MIN_VENUE_SAMPLE } = require('../baselines/corners');
const poisson = require('../baselines/poisson');

// Six matches per team so the venue split clears MIN_VENUE_SAMPLE nowhere by
// accident: three home, three away. Adjust per test as needed.
function profile(matches) {
  return { matches };
}

function match(venue, cornersFor, cornersAgainst) {
  return { venue, cornersFor, cornersAgainst };
}

// Home team: 4 home matches at 6 for / 4 against. Away team: 4 away matches at
// 5 for / 5 against. Both clear the venue sample, so venue figures are used.
function homeProfile() {
  return profile([
    match('home', 6, 4), match('home', 6, 4), match('home', 6, 4), match('home', 6, 4),
    match('away', 1, 9)
  ]);
}

function awayProfile() {
  return profile([
    match('away', 5, 5), match('away', 5, 5), match('away', 5, 5), match('away', 5, 5),
    match('home', 12, 1)
  ]);
}

test('lambdas blend one team\'s attack with the other\'s concession, by venue', () => {
  const b = cornerBaseline(homeProfile(), awayProfile());

  // λ_home = (home's for-at-home 6 + away's against-when-away 5) / 2 = 5.5
  assert.strictEqual(b.lambda.home, 5.5);
  // λ_away = (away's for-when-away 5 + home's against-at-home 4) / 2 = 4.5
  assert.strictEqual(b.lambda.away, 4.5);
  assert.strictEqual(b.lambda.total, 10);
});

test('each line carries a parametric and an empirical probability', () => {
  const b = cornerBaseline(homeProfile(), awayProfile());
  const line95 = b.lines.find((l) => l.line === 9.5);

  // Tolerance is 1e-4, not 1e-9: the module rounds published probabilities to
  // four places on purpose, so the test must accept the rounding.
  assert.ok(Math.abs(line95.overProbability - poisson.probOver(10, 9.5)) < 1e-4,
    'the parametric figure must come from Poisson at lambda.total');
  // Pooled totals: home team 10,10,10,10,10 and away team 10,10,10,10,13.
  // Nine of ten matches totalled 10, which clears 9.5; one totalled 13.
  assert.strictEqual(line95.empiricalOverRate, 1);
  assert.strictEqual(line95.empiricalSample, 10);
});

test('over and under sum to one on every line', () => {
  for (const line of cornerBaseline(homeProfile(), awayProfile()).lines) {
    assert.ok(Math.abs(line.overProbability + line.underProbability - 1) < 1e-9,
      `line ${line.line} probabilities must sum to 1`);
  }
});

test('dispersion reports the pooled mean, variance and their ratio', () => {
  const b = cornerBaseline(homeProfile(), awayProfile());

  // Totals: 10 nine times and 13 once. Mean = 103/10 = 10.3.
  assert.strictEqual(b.dispersion.mean, 10.3);
  assert.ok(b.dispersion.variance > 0, 'a sample with a 13 in it is not degenerate');
  assert.ok(Math.abs(b.dispersion.ratio - b.dispersion.variance / b.dispersion.mean) < 1e-9);
});

test('a thin venue sample falls back to all matches and says so', () => {
  const thin = profile([match('home', 6, 4), match('away', 8, 2)]);

  const b = cornerBaseline(thin, awayProfile());

  // Only one home match, below MIN_VENUE_SAMPLE, so all matches are used:
  // for = (6+8)/2 = 7, against = (4+2)/2 = 3.
  assert.strictEqual(b.lambda.home, (7 + 5) / 2);
  assert.ok(b.caveats.some((c) => /venue sample/i.test(c) && /home/i.test(c)),
    `expected a venue-sample caveat, got: ${b.caveats.join(' | ')}`);
});

test('the standing simplifications are always declared', () => {
  const b = cornerBaseline(homeProfile(), awayProfile());

  assert.ok(b.caveats.some((c) => /league/i.test(c)), 'no league normalisation must be declared');
  assert.ok(b.caveats.some((c) => /recency|weighting/i.test(c)), 'equal weighting must be declared');
});

test('a profile with no matches is refused rather than priced', () => {
  assert.throws(() => cornerBaseline(profile([]), awayProfile()), /no matches/i);
});

test('MIN_VENUE_SAMPLE is exported so callers can explain the fallback', () => {
  assert.strictEqual(MIN_VENUE_SAMPLE, 4);
});

test('custom lines are honoured', () => {
  const b = cornerBaseline(homeProfile(), awayProfile(), [8.5]);

  assert.strictEqual(b.lines.length, 1);
  assert.strictEqual(b.lines[0].line, 8.5);
});
