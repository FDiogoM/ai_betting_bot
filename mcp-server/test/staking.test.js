'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { suggestStake, inputQuality, kellyFraction } = require('../baselines/staking');

// Inputs with nothing to complain about: a big sample, a Poisson that fits,
// model and sample agreeing, no fallbacks.
function cleanBaseline(overrides = {}) {
  return {
    probability: 0.55,
    empiricalRate: 0.55,
    empiricalSample: 20,
    dispersionRatio: 1,
    caveats: ['no league normalisation: team rates are used raw'],
    ...overrides
  };
}

const marketView = { consensusProbability: 0.5, bestPrice: 2, bookmaker: 'A', overround: 0.04 };

test('kelly is expected value over the net odds', () => {
  // p 0.6 at 2.0: EV = 0.6 - 0.4 = 0.2, net odds 1, so f = 0.2.
  assert.ok(Math.abs(kellyFraction(0.6, 2) - 0.2) < 1e-12);
  // A fair bet stakes nothing.
  assert.ok(Math.abs(kellyFraction(0.5, 2)) < 1e-12);
});

test('a bet the price does not cover stakes zero, not a little', () => {
  const s = suggestStake({
    probability: 0.4, decimalOdd: 2, baseline: cleanBaseline(), marketView
  });

  assert.strictEqual(s.stake, 0);
  assert.match(s.note, /negative-expectation/);
  assert.ok(s.kellyFraction < 0, 'the negative kelly is reported rather than hidden');
});

test('clean inputs are not penalised', () => {
  const q = inputQuality(cleanBaseline(), marketView);

  assert.strictEqual(q.factor, 1);
  assert.deepStrictEqual(q.penalties, []);
});

test('the stake is capped at one unit however large the edge', () => {
  const s = suggestStake({
    probability: 0.9, decimalOdd: 3, baseline: cleanBaseline(), marketView
  });

  assert.ok(s.uncappedUnits > 1, `quarter Kelly here is ${s.uncappedUnits} units`);
  assert.strictEqual(s.stake, 1, 'and the cap binds');
});

test('a thin sample cuts the stake and says why', () => {
  const q = inputQuality(cleanBaseline({ empiricalSample: 7 }), marketView);

  assert.ok(q.factor < 0.6, `expected a heavy cut, got ${q.factor}`);
  assert.match(q.penalties[0].reason, /only 7 matches/);
});

test('a dispersion ratio far from 1 cuts the stake: the Poisson is not fitting', () => {
  const bad = inputQuality(cleanBaseline({ dispersionRatio: 1.46 }), marketView);
  const mild = inputQuality(cleanBaseline({ dispersionRatio: 1.25 }), marketView);

  assert.ok(bad.factor < mild.factor, 'a worse fit must be penalised harder');
  assert.ok(mild.factor < 1);
  assert.match(bad.penalties[0].reason, /fits badly/);
});

test('a model that disagrees with its own sample is penalised', () => {
  const q = inputQuality(cleanBaseline({ probability: 0.55, empiricalRate: 0.79 }), marketView);

  assert.ok(q.factor < 1);
  assert.match(q.penalties[0].reason, /disagree by/);
});

test('venue fallbacks and season boundaries each cost something', () => {
  const venue = inputQuality(cleanBaseline({
    caveats: ['home team: venue sample at home is 3, below 4; used all 5 matches instead']
  }), marketView);
  const season = inputQuality(cleanBaseline({
    caveats: ['sample crosses the season boundary: 4 of 9 matches are not from season 2026']
  }), marketView);

  assert.ok(venue.factor < 1 && season.factor < 1);
  assert.match(venue.penalties[0].reason, /venue sample/);
  assert.match(season.penalties[0].reason, /season boundary/);
});

test('a goals baseline that could not use shots is worth less', () => {
  const shots = inputQuality(cleanBaseline({ signal: 'shots' }), marketView);
  const goals = inputQuality(cleanBaseline({ signal: 'goals' }), marketView);

  assert.strictEqual(shots.factor, 1, 'the intended signal is not a penalty');
  assert.ok(goals.factor < 1);
  assert.match(goals.penalties[0].reason, /shots on target/);
});

test('a one-sided quote is penalised: there is no market view to test against', () => {
  const q = inputQuality(cleanBaseline(), { consensusProbability: null, bestPrice: 2 });

  assert.ok(q.factor < 1);
  assert.match(q.penalties[0].reason, /one side only/);
});

// The case that prompted the rule. Gornik Zabrze v Monaco, recorded on
// 2026-08-18: nine matches in the pooled sample, a dispersion ratio of 1.46,
// four of nine from a previous season, both venue samples fallen back — the
// weakest evidence of the day, staked at a full unit.
test('the weakest pick of a real bulletin is sized far below a clean one', () => {
  const weak = suggestStake({
    probability: 0.555,
    decimalOdd: 1.93,
    baseline: {
      probability: 0.5576,
      empiricalRate: 0.5556,
      empiricalSample: 9,
      dispersionRatio: 1.4618,
      caveats: [
        'sample crosses the season boundary: 4 of 9 matches are not from season 2026',
        'home team: venue sample at home is 3, below 4; used all 5 matches instead',
        'away team: venue sample at away is 3, below 4; used all 4 matches instead'
      ]
    },
    marketView: { consensusProbability: 0.5253, bestPrice: 1.93 }
  });

  const clean = suggestStake({
    probability: 0.7, decimalOdd: 1.5, baseline: cleanBaseline({ empiricalSample: 20 }), marketView
  });

  assert.ok(weak.stake < 0.4, `the weakest pick should be small, got ${weak.stake}`);
  assert.strictEqual(clean.stake, 1);
  assert.ok(weak.quality.penalties.length >= 3, 'and every reason for it is listed');
});
