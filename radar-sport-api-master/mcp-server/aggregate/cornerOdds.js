'use strict';

// Confirmed by the Task 1 live probe (2026-08-17): the full-match corner
// total over/under market is named exactly "Corners Over Under", quoted by
// 10Bet, Bet365, Marathonbet, Unibet and Pinnacle.
//
// ANCHORED, not loose. The same response carries "Home Corners Over/Under",
// "Away Corners Over/Under", "Total Corners (3 way)", "Total Corners
// (1st Half)", "Corners 1x2", "Corners Asian Handicap", "Corners. Odd/Even",
// "Corners. Total (Range)", "Corners Race To", "Multicorners" and "Corners.
// European Handicap". Those are different bets. A loose /corner.*over.*under/
// would pool a per-team 2.5 line and a first-half 4.5 line into the full-match
// buckets and back the wrong selection.
const CORNER_MARKET_PATTERNS = [
  /^corners?\s+over\s*\/?\s*under$/i
];

// Second layer, deliberately redundant with the anchors above: if a new
// bookmaker name ever slips past them, these keywords still keep a non-total
// market out. Belt and braces, because the failure mode is a silently wrong bet
// rather than a crash.
const NOT_FULL_MATCH_TOTAL = [
  /\bhome\b/i, /\baway\b/i, /\bhalf\b/i, /3\s*way/i, /handicap/i,
  /odd\s*\/?\s*even/i, /range/i, /race/i, /multi/i, /1\s*x\s*2/i
];

const SIDE = /^(over|under)\s+(\d+(?:\.\d+)?)$/i;

function isCornerMarket(name) {
  const text = String(name || '').trim();
  if (NOT_FULL_MATCH_TOTAL.some((p) => p.test(text))) return false;
  return CORNER_MARKET_PATTERNS.some((p) => p.test(text));
}

// Returns [{ line, over: [{bookmaker, odd}], under: [{bookmaker, odd}] }],
// ascending by line. A value that does not parse is skipped, never guessed: a
// misread line would price the wrong bet.
function parseCornerQuotes(oddsResponse) {
  const byLine = new Map();

  for (const entry of oddsResponse || []) {
    for (const bookmaker of entry.bookmakers || []) {
      for (const bet of bookmaker.bets || []) {
        if (!isCornerMarket(bet.name)) continue;
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

module.exports = {
  parseCornerQuotes, CORNER_MARKET_PATTERNS, NOT_FULL_MATCH_TOTAL, isCornerMarket
};
