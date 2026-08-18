'use strict';

const { totalsBaseline, MIN_VENUE_SAMPLE } = require('./totals');
const markets = require('../markets');

const DEFAULT_LINES = markets.get('corners').defaultLines;

/**
 * The corner baseline. All the arithmetic lives in totalsBaseline; this file
 * says only which fields of a match hold the count. See totals.js for the
 * returned shape.
 */
function cornerBaseline(homeProfile, awayProfile, lines = DEFAULT_LINES, options = {}) {
  return totalsBaseline(homeProfile, awayProfile, lines, {
    ...options,
    forOf: (m) => m.cornersFor,
    againstOf: (m) => m.cornersAgainst
  });
}

module.exports = { cornerBaseline, DEFAULT_LINES, MIN_VENUE_SAMPLE };
