'use strict';

// Pure: no imports, no clock, no filesystem.

// Kelly staked in full is the growth-optimal bet only if the probability is
// exactly right. It never is, and Kelly punishes over-estimation brutally —
// a probability 5 points too high can turn the optimal bet into a losing one.
// A quarter is the conventional hedge against exactly that.
const KELLY_DIVISOR = 4;

// One unit is this fraction of the bankroll unless the caller says otherwise.
// Matches `stakeFraction` in config/bulletin.json.
const DEFAULT_BANKROLL_FRACTION = 0.01;

/**
 * The Kelly fraction of bankroll for a binary bet: EV divided by the net odds.
 * Negative when the bet is bad, which the caller must treat as "do not bet"
 * rather than as a small stake.
 */
function kellyFraction(probability, decimalOdd) {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) {
    throw new Error(`probability must be between 0 and 1 exclusive, got ${probability}`);
  }
  if (!Number.isFinite(decimalOdd) || decimalOdd <= 1) {
    throw new Error(`decimal odd must be a finite number above 1, got ${decimalOdd}`);
  }
  const net = decimalOdd - 1;
  return (probability * net - (1 - probability)) / net;
}

/**
 * How much the inputs behind a baseline can be trusted, as a multiplier in
 * (0, 1] plus the reasons it is not 1.
 *
 * Every penalty reads something the baseline already reports about itself. None
 * of it is a view on the match: this scales the bet by how much the arithmetic
 * deserves to be believed, which is what `confidence` was always supposed to
 * mean and what a hand-picked stake never enforced. On 2026-08-18 all seven
 * predictions went in at a full unit, including one built on nine matches with
 * a dispersion ratio of 1.46 — the weakest evidence in the book at the largest
 * size available.
 */
function inputQuality(baseline, marketView) {
  const penalties = [];
  const penalise = (multiplier, reason) => penalties.push({ multiplier, reason });

  const sample = baseline.empiricalSample;
  if (typeof sample === 'number') {
    if (sample < 8) penalise(0.5, `only ${sample} matches in the pooled sample`);
    else if (sample < 12) penalise(0.75, `${sample} matches in the pooled sample is thin`);
  }

  // The Poisson assumes variance equals mean. The further the sample is from
  // that, the less the parametric probability means — and a high-probability
  // selection is a claim about exactly the tail this distorts.
  const ratio = baseline.dispersionRatio;
  if (typeof ratio === 'number') {
    const off = Math.abs(ratio - 1);
    if (off > 0.4) penalise(0.6, `dispersion ratio ${round(ratio)} is far from 1: the Poisson fits badly`);
    else if (off > 0.2) penalise(0.8, `dispersion ratio ${round(ratio)} is some way from 1`);
  }

  // The parametric probability against what actually happened in the sample.
  // A wide gap means the model is describing something the data did not do.
  if (typeof baseline.probability === 'number' && typeof baseline.empiricalRate === 'number') {
    const gap = Math.abs(baseline.probability - baseline.empiricalRate);
    if (gap > 0.15) penalise(0.6, `the model and the sample disagree by ${round(gap)}`);
    else if (gap > 0.08) penalise(0.8, `the model and the sample disagree by ${round(gap)}`);
  }

  const caveats = Array.isArray(baseline.caveats) ? baseline.caveats : [];
  if (caveats.some((c) => /venue sample/i.test(c))) {
    penalise(0.85, 'a venue sample was too thin and fell back to all matches');
  }
  if (caveats.some((c) => /season boundary/i.test(c))) {
    penalise(0.85, 'the sample crosses a season boundary');
  }

  // A goals baseline that could not use shots is running the older, noisier
  // model. It is still usable; it is not as good.
  if (baseline.signal === 'goals') {
    penalise(0.85, 'the goals rate fell back to goals scored rather than shots on target');
  }

  if (marketView && marketView.consensusProbability === null) {
    penalise(0.7, 'the line is quoted on one side only, so there is no market probability to test against');
  }

  const factor = penalties.reduce((acc, p) => acc * p.multiplier, 1);
  return { factor: round(factor), penalties };
}

function round(n, places = 4) {
  return Math.round(n * 10 ** places) / 10 ** places;
}

/**
 * The stake this bet deserves, in units, given the price and the quality of the
 * evidence behind it.
 *
 * Fractional Kelly for the size, capped at one unit, then scaled by input
 * quality. The cap binds far more often than not at these edges — which is the
 * point: past the cap the only thing separating two bets is how much the
 * numbers behind them can be believed.
 */
function suggestStake(options) {
  const {
    probability, decimalOdd, baseline, marketView,
    bankrollFraction = DEFAULT_BANKROLL_FRACTION,
    kellyDivisor = KELLY_DIVISOR
  } = options;

  const kelly = kellyFraction(probability, decimalOdd);
  const quality = inputQuality(baseline || {}, marketView);

  if (kelly <= 0) {
    return {
      stake: 0,
      kellyFraction: round(kelly, 6),
      fractionalKelly: 0,
      uncappedUnits: 0,
      quality,
      note: 'the price does not cover the probability: this is a negative-expectation bet and '
        + 'the stake is zero, not small'
    };
  }

  const fractional = kelly / kellyDivisor;
  const uncapped = fractional / bankrollFraction;
  const capped = Math.min(uncapped, 1);
  const stake = round(capped * quality.factor, 2);

  return {
    stake,
    kellyFraction: round(kelly, 6),
    fractionalKelly: round(fractional, 6),
    uncappedUnits: round(uncapped, 3),
    quality,
    note: `${kellyDivisor === 1 ? 'full' : `1/${kellyDivisor}`} Kelly is `
      + `${round(uncapped, 2)} units, capped at 1, then scaled by an input-quality factor of `
      + `${quality.factor}`
      + (quality.penalties.length ? '' : ' (nothing about these inputs argues for less)')
  };
}

module.exports = {
  suggestStake, inputQuality, kellyFraction, KELLY_DIVISOR, DEFAULT_BANKROLL_FRACTION
};
