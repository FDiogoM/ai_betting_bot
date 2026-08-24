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

FAMILIES.cards = {
  family: 'cards',
  shape: 'totals',
  noun: 'yellow cards',
  observedKey: 'totalYellows',
  source: 'statistics',
  statType: 'Yellow Cards',
  // Half-integers only, as everywhere else. The feed also quotes 2.75 and 3.0
  // on this market: a quarter line splits the stake across two lines and a
  // whole line pushes when the total lands on it, and neither is representable
  // in a ledger whose outcomes are win, loss and void. A push is not a void —
  // one carries information about the forecast and the other does not — so
  // recording them as the same thing would corrupt the scoring rather than
  // extend it. The existing half-line guard drops both.
  defaultLines: [2.5, 3.5, 4.5, 5.5, 6.5],
  // Confirmed by live probe (2026-08-24) against fixture 1557376, which carried
  // 185 distinct markets. The full-match yellow total is named exactly "Yellow
  // Over/Under". The same response also carries "Yellow Over/Under (1st Half)",
  // "Yellow Over/Under (2nd Half)", "Yellow Asian Handicap", "Yellow Cards 1x2",
  // "Yellow Double Chance", "Yellow Odd/Even", "Cards Over/Under",
  // "Cards Asian Handicap", "Home Team Yellow Cards" and "Away Team Total
  // Cards" — every one of them a different bet.
  oddsPattern: /^yellow\s+over\s*\/?\s*under$/i
};

// --- the outcomes shape ------------------------------------------------------
//
// A second shape, exactly as this file's opening comment anticipated: a fixed
// set of named selections and no line. Everything below was read off a live
// response for Fulham v Chelsea on 2026-08-24 — both the market name and the
// literal strings the bookmaker uses for each selection — because neither can
// be guessed and getting either wrong backs a different bet without erroring.
//
// Each family declares three things nothing else may know: what the market is
// called, what each selection is called in the odds feed, and how to tell from
// a finished score whether it won. `won` is a predicate rather than a function
// returning the winning selection, because more than one can win at once —
// every result makes two of the three double chances good.

const outcomes = (spec) => ({ ...spec, shape: 'outcomes' });

const OUTCOME_FAMILIES = {
  matchResult: outcomes({
    family: 'matchResult',
    noun: 'match result',
    selections: ['home', 'draw', 'away'],
    // Exactly one of the three happens, so the true probabilities sum to 1 and
    // the book can be normalised to it.
    partitionSum: 1,
    // `Home/Away` is Draw No Bet and `First Half Winner` is a different match:
    // the anchor keeps both out.
    oddsPattern: /^match\s+winner$/i,
    oddsValues: { home: 'Home', draw: 'Draw', away: 'Away' },
    observedKey: 'score',
    won: (s, o) => (s === 'home' ? o.home > o.away : s === 'away' ? o.away > o.home : o.home === o.away),
    from: (d) => ({ home: d.matchResult.home, draw: d.matchResult.draw, away: d.matchResult.away })
  }),
  doubleChance: outcomes({
    family: 'doubleChance',
    noun: 'double chance',
    selections: ['homeOrDraw', 'homeOrAway', 'drawOrAway'],
    // NOT a partition. Every result makes exactly TWO of the three good, so the
    // true probabilities sum to 2. Normalising to 1 reported a 112% margin on a
    // live book — the probe that caught it is why this field exists.
    partitionSum: 2,
    // The same response carries `Double Chance - First Half`, `Corners. Double
    // Chance`, `Yellow Double Chance`, `Fouls. Double Chance` and `Offsides
    // Double Chance`. Five different bets sharing two words.
    oddsPattern: /^double\s+chance$/i,
    oddsValues: { homeOrDraw: 'Home/Draw', homeOrAway: 'Home/Away', drawOrAway: 'Draw/Away' },
    observedKey: 'score',
    won: (s, o) => (s === 'homeOrDraw' ? o.home >= o.away
      : s === 'drawOrAway' ? o.away >= o.home : o.home !== o.away),
    from: (d) => ({ homeOrDraw: d.doubleChance.homeOrDraw,
      homeOrAway: d.doubleChance.homeOrAway, drawOrAway: d.doubleChance.awayOrDraw })
  }),
  bothTeamsScore: outcomes({
    family: 'bothTeamsScore',
    noun: 'both teams to score',
    selections: ['yes', 'no'],
    partitionSum: 1,
    // Named `Both Teams Score` at full match; the half variants are spelled
    // `Both Teams To Score`, with the extra word, and are different bets.
    oddsPattern: /^both\s+teams\s+score$/i,
    oddsValues: { yes: 'Yes', no: 'No' },
    observedKey: 'score',
    won: (s, o) => ((o.home > 0 && o.away > 0) === (s === 'yes')),
    from: (d) => ({ yes: d.bothTeamsToScore.yes, no: d.bothTeamsToScore.no })
  }),
  oddEven: outcomes({
    family: 'oddEven',
    noun: 'odd or even total goals',
    selections: ['odd', 'even'],
    partitionSum: 1,
    // Anchored hard: `Home Odd/Even`, `Away Odd/Even`, `Corners. Odd/Even`,
    // `Yellow Odd/Even`, `Fouls. Odd/Even` and `Odd/Even - First Half` all
    // exist on the same fixture.
    oddsPattern: /^odd\s*\/\s*even$/i,
    oddsValues: { odd: 'Odd', even: 'Even' },
    observedKey: 'score',
    won: (s, o) => (((o.home + o.away) % 2 === 1) === (s === 'odd')),
    from: (d) => ({ odd: d.oddEven.odd, even: d.oddEven.even })
  }),
  cleanSheetHome: outcomes({
    family: 'cleanSheetHome',
    noun: 'home clean sheet',
    selections: ['yes', 'no'],
    partitionSum: 1,
    oddsPattern: /^clean\s+sheet\s*-\s*home$/i,
    oddsValues: { yes: 'Yes', no: 'No' },
    observedKey: 'score',
    won: (s, o) => ((o.away === 0) === (s === 'yes')),
    from: (d) => ({ yes: d.cleanSheet.home, no: 1 - d.cleanSheet.home })
  }),
  cleanSheetAway: outcomes({
    family: 'cleanSheetAway',
    noun: 'away clean sheet',
    selections: ['yes', 'no'],
    partitionSum: 1,
    oddsPattern: /^clean\s+sheet\s*-\s*away$/i,
    oddsValues: { yes: 'Yes', no: 'No' },
    observedKey: 'score',
    won: (s, o) => ((o.home === 0) === (s === 'yes')),
    from: (d) => ({ yes: d.cleanSheet.away, no: 1 - d.cleanSheet.away })
  }),
  winToNil: outcomes({
    family: 'winToNil',
    noun: 'win to nil',
    selections: ['home', 'away'],
    // NOT a partition and not completable either: in most matches NEITHER side
    // wins to nil, so these two sum to well under 1 and there is no third
    // selection to make up the difference. A live book read -55.6% margin when
    // normalised. Null means the margin cannot be removed from within this
    // market, so no consensus is offered — only the raw price.
    partitionSum: null,
    // The feed also carries `Win to Nil - Home` and `Win to Nil - Away` as
    // separate yes/no markets, in different casing. This is the two-way one.
    oddsPattern: /^win\s+to\s+nil$/i,
    oddsValues: { home: 'Home', away: 'Away' },
    observedKey: 'score',
    won: (s, o) => (s === 'home' ? o.home > o.away && o.away === 0 : o.away > o.home && o.home === 0),
    from: (d) => ({ home: d.winToNil.home, away: d.winToNil.away })
  })
};

Object.assign(FAMILIES, OUTCOME_FAMILIES);

const FAMILY_NAMES = Object.keys(FAMILIES);
const TOTALS_FAMILIES = FAMILY_NAMES.filter((n) => FAMILIES[n].shape === 'totals');
const OUTCOME_FAMILY_NAMES = FAMILY_NAMES.filter((n) => FAMILIES[n].shape === 'outcomes');

function get(family) {
  const spec = FAMILIES[family];
  if (!spec) {
    throw new Error(`unknown market family "${family}"; known families are ${FAMILY_NAMES.join(', ')}`);
  }
  return spec;
}

// Whether a bookmaker's market name is this family's market.
//
// The NOT_FULL_MATCH_TOTAL screen applies to TOTALS ONLY. It exists to keep
// per-team and per-half variants out of an over/under, and applied blindly it
// would reject half the outcomes families by their own names: `Clean Sheet -
// Home` contains "home", and `Odd/Even` is itself one of the excluded patterns.
// Those families are protected instead by anchors so tight that no adjacent
// market can satisfy them.
function isMarket(family, name) {
  const text = String(name || '').trim();
  const spec = get(family);
  if (spec.shape === 'totals' && NOT_FULL_MATCH_TOTAL.some((p) => p.test(text))) return false;
  return spec.oddsPattern.test(text);
}

// Which selection a bookmaker's value string names, or null when it names none
// of them. Compared case-insensitively and with whitespace collapsed, because
// the same feed writes both `Win To Nil` and `Win to Nil - Away`.
function selectionOf(family, value) {
  const spec = get(family);
  if (spec.shape !== 'outcomes') return null;
  const text = String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  for (const [selection, label] of Object.entries(spec.oddsValues)) {
    if (label.toLowerCase() === text) return selection;
  }
  return null;
}

// Whether a selection won, given the finished score. Throws for a family that
// declares no rule rather than guessing — an unsettleable prediction must fail
// loudly at settlement, not resolve to a plausible-looking loss.
function settles(family, selection, observed) {
  const spec = get(family);
  if (typeof spec.won !== 'function') {
    throw new Error(`market family "${family}" declares no settlement rule`);
  }
  if (!spec.selections.includes(selection)) {
    throw new Error(`"${selection}" is not a selection of ${family}; `
      + `it offers ${spec.selections.join(', ')}`);
  }
  return spec.won(selection, observed);
}

module.exports = {
  FAMILIES, FAMILY_NAMES, TOTALS_FAMILIES, OUTCOME_FAMILY_NAMES,
  NOT_FULL_MATCH_TOTAL, get, isMarket, selectionOf, settles
};
