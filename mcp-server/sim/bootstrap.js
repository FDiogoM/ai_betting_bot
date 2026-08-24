'use strict';

// Pure: no imports, no clock, no filesystem, and no Math.random — the generator
// is seeded, so the same history and the same seed give the same distribution
// every time. A simulation whose answer moves between runs cannot be argued
// with, and this one exists to be argued with.
//
// WHY THIS EXISTS. Replaying eight strategies over twenty-six outcomes and
// keeping the best one is data mining, not analysis: with that many rules and
// that few results, one of them is guaranteed to look excellent by luck alone.
// The bootstrap is the counterweight. It resamples the bets a strategy actually
// took, thousands of times, and reports the whole distribution of outcomes it
// could plausibly have produced. A profit that sits comfortably inside that
// spread is noise wearing a result's clothes.
//
// It cannot fix a small sample. Resampling twenty-six outcomes tells you how
// uncertain those twenty-six are; it does not conjure a twenty-seventh.

const DEFAULT_ITERATIONS = 10000;

// mulberry32: small, fast, and good enough for resampling. Seeded explicitly so
// runs are reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round(n, places = 3) {
  return typeof n === 'number' ? Math.round(n * 10 ** places) / 10 ** places : n;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * The distribution of profit a strategy could have produced, from the bets it
 * actually took.
 *
 * Resamples WITH REPLACEMENT to the same number of bets. Each draw keeps the
 * stake, the price and the outcome together — they are one observation, and
 * splitting them would invent bets that never happened.
 */
function bootstrapStrategy(curve, options = {}) {
  const { iterations = DEFAULT_ITERATIONS, seed = 1 } = options;
  const bets = (curve || []).filter((b) => b.outcome !== 'void');

  if (bets.length < 2) {
    return {
      n: bets.length,
      iterations: 0,
      note: 'too few settled bets to resample: a distribution needs something to draw from'
    };
  }

  const next = rng(seed);
  const totals = new Array(iterations);
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    for (let k = 0; k < bets.length; k += 1) {
      sum += bets[Math.floor(next() * bets.length)].result;
    }
    totals[i] = sum;
  }
  totals.sort((a, b) => a - b);

  const observed = bets.reduce((acc, b) => acc + b.result, 0);
  const mean = totals.reduce((a, b) => a + b, 0) / iterations;
  // How much of the distribution sits at or below zero: the share of plausible
  // worlds in which this strategy lost money.
  const losingShare = totals.filter((t) => t <= 0).length / iterations;

  return {
    n: bets.length,
    iterations,
    observedProfit: round(observed),
    mean: round(mean),
    p05: round(percentile(totals, 0.05)),
    p25: round(percentile(totals, 0.25)),
    median: round(percentile(totals, 0.5)),
    p75: round(percentile(totals, 0.75)),
    p95: round(percentile(totals, 0.95)),
    probabilityOfLoss: round(losingShare),
    // The verdict this whole module exists to deliver. A spread that straddles
    // zero means the sign of the result is not established, however pleasing it
    // is.
    straddlesZero: percentile(totals, 0.05) < 0 && percentile(totals, 0.95) > 0,
    note: percentile(totals, 0.05) < 0 && percentile(totals, 0.95) > 0
      ? `over ${bets.length} bets the 90% range runs from ${round(percentile(totals, 0.05), 1)} `
        + `to ${round(percentile(totals, 0.95), 1)} units and includes zero: this result does not `
        + 'establish whether the strategy wins or loses'
      : `over ${bets.length} bets the 90% range excludes zero — but a range this narrow on a `
        + 'sample this small is worth re-checking as the ledger grows'
  };
}

/**
 * Every strategy in a comparison, bootstrapped.
 *
 * The seed advances per strategy so they are not all drawing the same sequence,
 * while the whole run stays reproducible from one number.
 */
function bootstrapComparison(comparison, options = {}) {
  const { iterations = DEFAULT_ITERATIONS, seed = 1 } = options;
  return {
    iterations,
    seed,
    warning: 'these strategies were chosen after seeing the outcomes. Any one of them looking '
      + 'good over a sample this size is expected, and the ranges below are the reason to '
      + 'distrust it rather than the reason to act on it.',
    results: comparison.results.map((r, i) => ({
      key: r.key,
      strategy: r.strategy,
      profitUnits: r.profitUnits,
      ...bootstrapStrategy(r.curve, { iterations, seed: seed + i * 7919 })
    }))
  };
}

module.exports = { bootstrapStrategy, bootstrapComparison, rng, DEFAULT_ITERATIONS };
