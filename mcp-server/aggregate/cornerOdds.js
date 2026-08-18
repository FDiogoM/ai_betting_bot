'use strict';

// Corners were the first market, so this file was once the only odds parser.
// The parsing is now generic (aggregate/marketOdds.js) and the corner-specific
// knowledge — the anchored market name, and why it must be anchored — lives
// with every other family's in markets/index.js. What remains here is the
// corner-shaped door onto both, kept because it is the name the rest of the
// corner slice already calls.
const markets = require('../markets');
const { parseQuotes } = require('./marketOdds');

const CORNER_MARKET_PATTERNS = [markets.get('corners').oddsPattern];
const { NOT_FULL_MATCH_TOTAL } = markets;

function isCornerMarket(name) {
  return markets.isMarket('corners', name);
}

function parseCornerQuotes(oddsResponse) {
  return parseQuotes('corners', oddsResponse);
}

module.exports = {
  parseCornerQuotes, CORNER_MARKET_PATTERNS, NOT_FULL_MATCH_TOTAL, isCornerMarket
};
