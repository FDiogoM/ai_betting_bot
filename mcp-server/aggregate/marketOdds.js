'use strict';

const markets = require('../markets');

const SIDE = /^(over|under)\s+(\d+(?:\.\d+)?)$/i;

// Returns [{ line, over: [{bookmaker, odd}], under: [{bookmaker, odd}] }],
// ascending by line, for one market family. A value that does not parse is
// skipped, never guessed: a misread line would price the wrong bet.
//
// Which bookmaker market names count as this family's full-match total is
// decided in markets/index.js, against names read off a real response rather
// than assumed.
function parseQuotes(family, oddsResponse) {
  const byLine = new Map();

  for (const entry of oddsResponse || []) {
    for (const bookmaker of entry.bookmakers || []) {
      for (const bet of bookmaker.bets || []) {
        if (!markets.isMarket(family, bet.name)) continue;
        for (const value of bet.values || []) {
          const parsed = SIDE.exec(String(value.value || '').trim());
          if (!parsed) continue;
          const odd = Number(value.odd);
          if (!Number.isFinite(odd) || odd <= 1) continue;

          const line = Number(parsed[2]);
          // Half-integer lines only; a whole line pushes and nothing
          // downstream can represent that.
          if ((line * 2) % 2 !== 1) continue;

          if (!byLine.has(line)) byLine.set(line, { line, over: [], under: [] });
          byLine.get(line)[parsed[1].toLowerCase()].push({ bookmaker: bookmaker.name, odd });
        }
      }
    }
  }

  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

// The same job for a family with named selections and no line. Returns
// { selection: [{ bookmaker, odd }] } for every selection the family declares,
// including the ones nobody quoted — an empty array is the honest answer to
// "who priced the draw", and a missing key would read as a parse failure.
//
// A value string the registry does not recognise is skipped rather than
// guessed, for the same reason a misread line is: it would price a bet nobody
// offered.
function parseOutcomes(family, oddsResponse) {
  const spec = markets.get(family);
  const bySelection = {};
  for (const selection of spec.selections) bySelection[selection] = [];

  for (const entry of oddsResponse || []) {
    for (const bookmaker of entry.bookmakers || []) {
      for (const bet of bookmaker.bets || []) {
        if (!markets.isMarket(family, bet.name)) continue;
        for (const value of bet.values || []) {
          const selection = markets.selectionOf(family, value.value);
          if (!selection) continue;
          const odd = Number(value.odd);
          if (!Number.isFinite(odd) || odd <= 1) continue;
          bySelection[selection].push({ bookmaker: bookmaker.name, odd });
        }
      }
    }
  }

  return bySelection;
}

module.exports = { parseQuotes, parseOutcomes, SIDE };
