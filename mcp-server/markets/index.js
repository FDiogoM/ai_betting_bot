'use strict';

// The one place that knows what a market family is. Everything family-specific
// — how its odds are named, where its observed total comes from at settlement,
// which lines it trades on — is declared here, so adding a family is a new
// entry plus its data source rather than a hunt through the codebase.
//
// `shape` is what the ledger schema keys on. Both families today are `totals`
// (an over/under on a count), and that is why they share a selection enum and
// a line. A family with a different shape — 1X2 has three selections and no
// line — becomes a second shape here and a second variant in the schema union,
// not a rewrite of either.

// Second layer, deliberately redundant with the anchored patterns below: if a
// new bookmaker name ever slips past an anchor, these keywords still keep a
// non-full-match market out. Belt and braces, because the failure mode is a
// silently wrong bet rather than a crash.
const NOT_FULL_MATCH_TOTAL = [
  /\bhome\b/i, /\baway\b/i, /\bhalf\b/i, /3\s*way/i, /handicap/i,
  /odd\s*\/?\s*even/i, /range/i, /race/i, /multi/i, /1\s*x\s*2/i
];

const FAMILIES = {
  corners: {
    family: 'corners',
    shape: 'totals',
    noun: 'corners',
    // What the settlement record calls the number it observed.
    observedKey: 'totalCorners',
    // Corner counts live only in per-match statistics, one request per match.
    source: 'statistics',
    statType: 'Corner Kicks',
    defaultLines: [7.5, 8.5, 9.5, 10.5, 11.5, 12.5],
    // Confirmed by the Task 1 live probe (2026-08-17): the full-match corner
    // total is named exactly "Corners Over Under".
    //
    // ANCHORED, not loose. The same response carries "Home Corners Over/Under",
    // "Away Corners Over/Under", "Total Corners (3 way)", "Total Corners
    // (1st Half)", "Corners 1x2", "Corners Asian Handicap", "Corners. Odd/Even",
    // "Corners. Total (Range)", "Corners Race To", "Multicorners" and "Corners.
    // European Handicap". Those are different bets. A loose
    // /corner.*over.*under/ would pool a per-team 2.5 line and a first-half 4.5
    // line into the full-match buckets and back the wrong selection.
    oddsPattern: /^corners?\s+over\s*\/?\s*under$/i
  },
  goals: {
    family: 'goals',
    shape: 'totals',
    noun: 'goals',
    observedKey: 'totalGoals',
    // Goals are already on the fixture, so a goals profile costs one request
    // per team instead of one per match. This is the cheapest family there is.
    source: 'fixture',
    defaultLines: [0.5, 1.5, 2.5, 3.5, 4.5],
    // Confirmed by live probe (2026-08-17) against fixture 1622620: the
    // full-match goals total is named exactly "Goals Over/Under". The same
    // response carries "Goals Over/Under First Half", "Goals Over/Under -
    // Second Half", "Goal Line", "Exact Goals Number", "Home Team Total
    // Goals(1st Half)" and "Away Team Exact Goals Number" — every one of them
    // a different bet.
    oddsPattern: /^goals?\s+over\s*\/?\s*under$/i
  }
};

const FAMILY_NAMES = Object.keys(FAMILIES);

function get(family) {
  const spec = FAMILIES[family];
  if (!spec) {
    throw new Error(`unknown market family "${family}"; known families are ${FAMILY_NAMES.join(', ')}`);
  }
  return spec;
}

// Whether a bookmaker's market name is this family's full-match total.
function isMarket(family, name) {
  const text = String(name || '').trim();
  if (NOT_FULL_MATCH_TOTAL.some((p) => p.test(text))) return false;
  return get(family).oddsPattern.test(text);
}

module.exports = { FAMILIES, FAMILY_NAMES, NOT_FULL_MATCH_TOTAL, get, isMarket };
