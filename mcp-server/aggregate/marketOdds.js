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

module.exports = { parseQuotes, SIDE };
