'use strict';

// Pure: no imports beyond de-vigging, no clock, no filesystem.
//
// Closing line value: whether the price you took was better than the price the
// market finished at.
//
// It matters because the alternative measurements are too slow. A settled bet
// yields ONE bit — won or lost — and separating a 55% forecaster from a 50% one
// through results takes hundreds of bets. This ledger has 26 and will say
// `insufficient` for months. CLV yields a continuous measurement on every bet:
// you beat the close by 4.2%, or you did not. The variance collapses and a
// usable reading arrives in dozens rather than hundreds.
//
// The closing line is the benchmark because it is the market's last word, after
// every team-sheet and every wager has been absorbed. Consistently beating it is
// the strongest available evidence that an edge is real; consistently losing to
// it means the edge is not there, whatever this month's P&L happens to say.
//
// WHAT MADE THIS CHEAP. The plan had been a scheduled job firing near kickoff,
// because pre-match odds were assumed to vanish once a match starts. They do
// not: the provider keeps its last snapshot, and across ten settled fixtures on
// 2026-08-25 eight of them carried one taken between 7 and 67 minutes before
// kickoff. So CLV is computed at SETTLEMENT, retroactively, and needs no new
// infrastructure at all.
//
// What that snapshot is not, and the record says so: a guaranteed close. It is
// whatever the provider last wrote down. `minutesBeforeKickoff` travels with
// every measurement so a reader can weigh one taken three hours out differently
// from one taken seven minutes out.

const { impliedProbability } = require('./devig');

// Beyond this, the snapshot is too far from kickoff to be called a close. Three
// hours still absorbs most team-sheet news; a snapshot from the previous day
// absorbs nothing and would flatter or damn a bet at random.
const MAX_SNAPSHOT_AGE_MINUTES = 180;

function round(n, places = 6) {
  return typeof n === 'number' ? Math.round(n * 10 ** places) / 10 ** places : n;
}

/**
 * The value of the price taken against the closing line.
 *
 * `takenPrice`      — the decimal odd actually recorded
 * `closingPrice`    — the best price at the snapshot, from the same books
 * `closingFairProbability` — the de-vigged consensus at the snapshot, or null
 * `minutesBeforeKickoff`   — how close the snapshot was
 *
 * Two measures, because they answer different questions and neither subsumes
 * the other. `priceValue` is the intuitive one: how much more this pays than
 * the close. `probabilityValue` is the scoreable one: it is in probability
 * units, so it is comparable across a 1.20 and a 6.00 in a way a percentage of
 * price is not.
 */
function closingLineValue(options) {
  const {
    takenPrice, closingPrice = null, closingFairProbability = null,
    minutesBeforeKickoff = null
  } = options;

  if (!Number.isFinite(takenPrice) || takenPrice <= 1) {
    throw new Error(`the price taken must be above 1, got ${takenPrice}`);
  }

  const stale = minutesBeforeKickoff === null
    || minutesBeforeKickoff > MAX_SNAPSHOT_AGE_MINUTES
    || minutesBeforeKickoff < 0;

  if (closingPrice === null && closingFairProbability === null) {
    return {
      measurable: false,
      note: 'no closing snapshot for this selection, so its value against the close is unknown'
    };
  }

  const taken = impliedProbability(takenPrice);

  // Against the closing PRICE: how much more the bet pays than it would at the
  // close. Positive means the price shortened after it was taken.
  const priceValue = closingPrice === null ? null
    : round(takenPrice / closingPrice - 1);

  // Against the closing FAIR probability: bought below what the market finally
  // thought it was worth. This is the one worth scoring — the price comparison
  // still carries the bookmaker's margin, and the margin is not value.
  const probabilityValue = closingFairProbability === null ? null
    : round(closingFairProbability - taken);

  const beat = probabilityValue === null
    ? (priceValue !== null && priceValue > 0)
    : probabilityValue > 0;

  return {
    measurable: true,
    takenPrice,
    takenImpliedProbability: round(taken),
    closingPrice,
    closingFairProbability,
    priceValue,
    probabilityValue,
    beatTheClose: beat,
    minutesBeforeKickoff,
    stale,
    note: stale
      ? `the closing snapshot is ${minutesBeforeKickoff === null ? 'of unknown age'
        : `${minutesBeforeKickoff} minutes before kickoff`}, beyond the `
        + `${MAX_SNAPSHOT_AGE_MINUTES} that makes it a close: treat this as indicative`
      : `measured against a snapshot ${minutesBeforeKickoff} minutes before kickoff`
  };
}

/**
 * Scores a set of measurements.
 *
 * Stale ones are counted and excluded rather than dropped silently: a reader
 * needs to know how much of the record could not be measured properly.
 *
 * There is no `insufficient` floor here, unlike the Brier verdict, and that is
 * the point — CLV is a continuous measurement, so a dozen of them already say
 * something a dozen win/loss outcomes cannot. The mean is still a mean and the
 * spread is still reported.
 */
function summariseClv(measurements) {
  const usable = (measurements || []).filter((m) => m && m.measurable && !m.stale
    && typeof m.probabilityValue === 'number');
  const staleCount = (measurements || []).filter((m) => m && m.measurable && m.stale).length;
  const unmeasured = (measurements || []).filter((m) => !m || !m.measurable).length;

  if (!usable.length) {
    return {
      n: 0,
      stale: staleCount,
      unmeasured,
      note: 'nothing measurable against a close yet'
    };
  }

  const values = usable.map((m) => m.probabilityValue).sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  const beat = usable.filter((m) => m.beatTheClose).length;

  return {
    n: usable.length,
    stale: staleCount,
    unmeasured,
    meanProbabilityValue: round(mean, 4),
    medianProbabilityValue: round(median, 4),
    beatTheClose: beat,
    beatRate: round(beat / usable.length, 4),
    note: mean > 0
      ? `on average ${round(mean * 100, 2)} points of probability better than the close, `
        + `beating it ${beat} times in ${usable.length}. Sustained, that is the strongest `
        + 'evidence of an edge available'
      : `on average ${round(mean * 100, 2)} points of probability WORSE than the close, `
        + `beating it ${beat} times in ${usable.length}. Sustained, that says the edge is not `
        + 'there, whatever the P&L happens to say this month'
  };
}

module.exports = { closingLineValue, summariseClv, MAX_SNAPSHOT_AGE_MINUTES };
