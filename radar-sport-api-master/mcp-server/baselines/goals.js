'use strict';

const { totalsBaseline, MIN_VENUE_SAMPLE } = require('./totals');
const markets = require('../markets');

const DEFAULT_LINES = markets.get('goals').defaultLines;

/**
 * The goals baseline. Identical arithmetic to corners — a Poisson on a blended
 * scoring rate — differing only in the field the count comes from and in how
 * the model behaves: goal counts sit near the Poisson assumption far more
 * comfortably than corner counts do, so the dispersion ratio this returns
 * should usually be closer to 1. Read it anyway. See totals.js for the shape.
 */
function goalsBaseline(homeProfile, awayProfile, lines = DEFAULT_LINES, options = {}) {
  return totalsBaseline(homeProfile, awayProfile, lines, {
    ...options,
    forOf: (m) => m.goalsFor,
    againstOf: (m) => m.goalsAgainst
  });
}

module.exports = { goalsBaseline, DEFAULT_LINES, MIN_VENUE_SAMPLE };
