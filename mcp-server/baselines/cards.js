'use strict';

const { totalsBaseline, MIN_VENUE_SAMPLE } = require('./totals');
const markets = require('../markets');

const DEFAULT_LINES = markets.get('cards').defaultLines;

/**
 * The yellow-card baseline. All the arithmetic lives in totalsBaseline; this
 * file says only which fields of a match hold the count. See totals.js for the
 * returned shape.
 *
 * Cards sit closer to the Poisson assumption than corners do — measured across
 * 1089 cached matches the dispersion ratio came out at 1.11 — so the parametric
 * probability deserves rather more trust here than it does on a corner line.
 * Read `dispersion.ratio` on the fixture in front of you anyway; that figure is
 * a property of the league and the referee as much as of the sport.
 */
function cardsBaseline(homeProfile, awayProfile, lines = DEFAULT_LINES, options = {}) {
  return totalsBaseline(homeProfile, awayProfile, lines, {
    ...options,
    forOf: (m) => m.yellowsFor,
    againstOf: (m) => m.yellowsAgainst
  });
}

module.exports = { cardsBaseline, DEFAULT_LINES, MIN_VENUE_SAMPLE };
