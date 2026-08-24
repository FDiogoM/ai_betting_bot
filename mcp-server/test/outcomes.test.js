'use strict';

const test = require('node:test');
const assert = require('node:assert');

const markets = require('../markets');
const { parseOutcomes } = require('../aggregate/marketOdds');
const { predictionSchema, predictionId } = require('../ledger/schema');

// Read off a live response for Fulham v Chelsea on 2026-08-24. The fixture
// carried 185 distinct market names, and these are the ones that share words
// with the seven families below without being them. Every one of these is a
// different bet, and matching one would place it without erroring.
const ADJACENT = [
  'Home/Away', 'First Half Winner', 'Second Half Winner', '1x2 - 15 minutes',
  'Double Chance - First Half', 'Double Chance - Second Half', 'Corners. Double Chance',
  'Yellow Double Chance', 'Fouls. Double Chance', 'Offsides Double Chance',
  'Both Teams Score - First Half', 'Both Teams To Score - Second Half',
  'Both Teams To Score in Both Halves',
  'Home Odd/Even', 'Away Odd/Even', 'Corners. Odd/Even', 'Yellow Odd/Even',
  'Fouls. Odd/Even', 'Odd/Even - First Half', 'Odd/Even - Second Half',
  'Win to Nil - Home', 'Win to Nil - Away', 'Win Both Halves', 'To Win Either Half',
  'Corners 1x2', 'Yellow Cards 1x2', 'Offsides 1x2', 'Shots.1x2', 'Fouls. 1x2'
];

const EXACT = {
  matchResult: 'Match Winner',
  doubleChance: 'Double Chance',
  bothTeamsScore: 'Both Teams Score',
  oddEven: 'Odd/Even',
  cleanSheetHome: 'Clean Sheet - Home',
  cleanSheetAway: 'Clean Sheet - Away',
  winToNil: 'Win To Nil'
};

// --- the registry ------------------------------------------------------------

test('every outcomes family matches its own market and no adjacent one', () => {
  for (const [family, name] of Object.entries(EXACT)) {
    assert.ok(markets.isMarket(family, name), `${family} must match "${name}"`);
    for (const other of ADJACENT) {
      assert.ok(!markets.isMarket(family, other),
        `${family} must NOT match "${other}" — it is a different bet`);
    }
  }
});

test('no family matches another family\'s market', () => {
  for (const [family, name] of Object.entries(EXACT)) {
    for (const [otherFamily, otherName] of Object.entries(EXACT)) {
      if (family === otherFamily) continue;
      assert.ok(!markets.isMarket(family, otherName),
        `${family} must not match ${otherFamily}'s "${otherName}"`);
    }
    assert.ok(!markets.isMarket('goals', name), `goals must not match "${name}"`);
    assert.ok(!markets.isMarket('corners', name), `corners must not match "${name}"`);
  }
});

// The screen that keeps per-team totals out of an over/under would reject half
// these families by their own names — "Clean Sheet - Home" contains "home", and
// "Odd/Even" is itself one of the excluded patterns.
test('the totals-only exclusion screen does not apply to outcomes families', () => {
  assert.ok(markets.NOT_FULL_MATCH_TOTAL.some((p) => p.test('Clean Sheet - Home')),
    'the screen would reject this name');
  assert.ok(markets.isMarket('cleanSheetHome', 'Clean Sheet - Home'),
    'yet the family must still match it');
  assert.ok(markets.isMarket('oddEven', 'Odd/Even'));
});

test('bookmaker value strings map to selections, and unknown ones to nothing', () => {
  assert.strictEqual(markets.selectionOf('matchResult', 'Home'), 'home');
  assert.strictEqual(markets.selectionOf('matchResult', 'Draw'), 'draw');
  assert.strictEqual(markets.selectionOf('doubleChance', 'Home/Draw'), 'homeOrDraw');
  assert.strictEqual(markets.selectionOf('bothTeamsScore', 'Yes'), 'yes');
  // Case and spacing vary across the feed; meaning does not.
  assert.strictEqual(markets.selectionOf('winToNil', 'home'), 'home');
  assert.strictEqual(markets.selectionOf('matchResult', 'Over 2.5'), null);
  assert.strictEqual(markets.selectionOf('matchResult', ''), null);
});

// Only a set of selections that is mutually exclusive AND exhaustive can be
// normalised to 1. A live book read 112% margin on double chance and -56% on
// win to nil before this was declared.
test('each family declares what its true probabilities sum to', () => {
  assert.strictEqual(markets.get('matchResult').partitionSum, 1);
  assert.strictEqual(markets.get('bothTeamsScore').partitionSum, 1);
  assert.strictEqual(markets.get('oddEven').partitionSum, 1);
  assert.strictEqual(markets.get('cleanSheetHome').partitionSum, 1);
  assert.strictEqual(markets.get('cleanSheetAway').partitionSum, 1);
  // Every result makes two of the three good.
  assert.strictEqual(markets.get('doubleChance').partitionSum, 2);
  // Usually neither happens, and there is no third selection to complete it.
  assert.strictEqual(markets.get('winToNil').partitionSum, null);
});

// --- settlement --------------------------------------------------------------

const SCORES = {
  '1-3': { home: 1, away: 3 },
  '2-0': { home: 2, away: 0 },
  '0-0': { home: 0, away: 0 },
  '1-1': { home: 1, away: 1 }
};

test('a home win settles every family the right way', () => {
  const o = SCORES['2-0'];
  assert.strictEqual(markets.settles('matchResult', 'home', o), true);
  assert.strictEqual(markets.settles('matchResult', 'draw', o), false);
  assert.strictEqual(markets.settles('matchResult', 'away', o), false);
  assert.strictEqual(markets.settles('doubleChance', 'homeOrDraw', o), true);
  assert.strictEqual(markets.settles('doubleChance', 'homeOrAway', o), true);
  assert.strictEqual(markets.settles('doubleChance', 'drawOrAway', o), false);
  assert.strictEqual(markets.settles('bothTeamsScore', 'no', o), true);
  assert.strictEqual(markets.settles('oddEven', 'even', o), true);
  assert.strictEqual(markets.settles('cleanSheetHome', 'yes', o), true);
  assert.strictEqual(markets.settles('cleanSheetAway', 'yes', o), false);
  assert.strictEqual(markets.settles('winToNil', 'home', o), true);
});

test('an away win to nil is not a home one', () => {
  const o = SCORES['1-3'];
  assert.strictEqual(markets.settles('matchResult', 'away', o), true);
  assert.strictEqual(markets.settles('doubleChance', 'drawOrAway', o), true);
  assert.strictEqual(markets.settles('bothTeamsScore', 'yes', o), true);
  assert.strictEqual(markets.settles('oddEven', 'even', o), true);
  // The home side scored, so neither clean sheet nor a win to nil.
  assert.strictEqual(markets.settles('cleanSheetAway', 'yes', o), false);
  assert.strictEqual(markets.settles('winToNil', 'away', o), false);
});

test('a goalless draw makes both clean sheets good and neither win to nil', () => {
  const o = SCORES['0-0'];
  assert.strictEqual(markets.settles('matchResult', 'draw', o), true);
  assert.strictEqual(markets.settles('bothTeamsScore', 'no', o), true);
  assert.strictEqual(markets.settles('cleanSheetHome', 'yes', o), true);
  assert.strictEqual(markets.settles('cleanSheetAway', 'yes', o), true);
  assert.strictEqual(markets.settles('winToNil', 'home', o), false);
  assert.strictEqual(markets.settles('winToNil', 'away', o), false);
});

test('exactly two double chances win on every result', () => {
  for (const o of Object.values(SCORES)) {
    const won = markets.get('doubleChance').selections
      .filter((s) => markets.settles('doubleChance', s, o));
    assert.strictEqual(won.length, 2, `expected two winners for ${o.home}-${o.away}`);
  }
});

test('a selection the family does not offer is refused, not resolved', () => {
  assert.throws(() => markets.settles('matchResult', 'yes', SCORES['1-1']),
    /not a selection of matchResult/);
});

// --- odds parsing ------------------------------------------------------------

function book(name, bets) {
  return [{ bookmakers: [{ name, bets }] }];
}

test('outcomes odds are grouped by selection', () => {
  const parsed = parseOutcomes('matchResult', book('A', [{
    name: 'Match Winner',
    values: [{ value: 'Home', odd: '2.88' }, { value: 'Draw', odd: '3.25' },
      { value: 'Away', odd: '2.40' }]
  }]));

  assert.strictEqual(parsed.home[0].odd, 2.88);
  assert.strictEqual(parsed.draw[0].odd, 3.25);
  assert.strictEqual(parsed.away[0].bookmaker, 'A');
});

test('a selection nobody quoted is an empty list, not a missing key', () => {
  const parsed = parseOutcomes('matchResult', book('A', [{
    name: 'Match Winner',
    values: [{ value: 'Home', odd: '2.88' }]
  }]));

  assert.deepStrictEqual(parsed.draw, [], 'an empty array is the honest answer');
  assert.ok('away' in parsed, 'every declared selection must be present as a key');
});

test('an adjacent market is not read as this one', () => {
  const parsed = parseOutcomes('matchResult', book('A', [{
    name: 'First Half Winner',
    values: [{ value: 'Home', odd: '2.88' }]
  }]));

  assert.deepStrictEqual(parsed.home, [], 'a different match must contribute nothing');
});

test('an unparseable price is skipped rather than guessed', () => {
  const parsed = parseOutcomes('bothTeamsScore', book('A', [{
    name: 'Both Teams Score',
    values: [{ value: 'Yes', odd: 'evens' }, { value: 'No', odd: '1.00' },
      { value: 'Maybe', odd: '2.00' }]
  }]));

  assert.deepStrictEqual(parsed.yes, [], 'a non-numeric price is not a price');
  assert.deepStrictEqual(parsed.no, [], 'and 1.00 pays nothing back');
});

// --- the ledger --------------------------------------------------------------

const FIXTURE = { id: 1557376, home: 'Fulham', away: 'Chelsea',
  kickoff: '2026-08-24T14:00:00+00:00' };
const BASELINE = { probability: 0.44, empiricalRate: 0.44, empiricalSample: 20,
  lambda: 2.7, dispersionRatio: 1, caveats: [] };
const VIEW = { consensusProbability: 0.5, bestPrice: 2.4, bookmaker: 'X', overround: 0.045 };
const AGENT = { probability: 0.44, confidence: 'medium', stake: 0.5 };

function prediction(market) {
  return { fixture: FIXTURE, market, baseline: BASELINE, marketView: VIEW, agent: AGENT };
}

test('the ledger accepts a selection from every outcomes family', () => {
  for (const family of markets.OUTCOME_FAMILY_NAMES) {
    for (const selection of markets.get(family).selections) {
      const parsed = predictionSchema.parse(prediction({ family, selection }));
      assert.strictEqual(parsed.market.family, family);
      assert.strictEqual(parsed.market.selection, selection);
    }
  }
});

test('a totals prediction still validates unchanged', () => {
  const parsed = predictionSchema.parse(prediction({ family: 'goals', selection: 'over', line: 2.5 }));
  assert.strictEqual(parsed.market.line, 2.5);
});

test('a selection belonging to another family is refused', () => {
  assert.throws(() => predictionSchema.parse(prediction({ family: 'matchResult', selection: 'yes' })));
  assert.throws(() => predictionSchema.parse(prediction({ family: 'bothTeamsScore', selection: 'home' })));
  assert.throws(() => predictionSchema.parse(prediction({ family: 'matchResult', selection: 'over' })));
});

// A market with named selections has no line. Recording one would be writing
// down a number the bet does not have.
test('a line on a market that has none is refused', () => {
  assert.throws(() => predictionSchema.parse(
    prediction({ family: 'matchResult', selection: 'home', line: 2.5 })));
});

test('the id carries a line only where the bet has one', () => {
  const outcome = predictionSchema.parse(prediction({ family: 'matchResult', selection: 'away' }));
  const totals = predictionSchema.parse(prediction({ family: 'goals', selection: 'over', line: 2.5 }));

  assert.strictEqual(predictionId(outcome), '2026-08-24-1557376-matchResult-away');
  assert.strictEqual(predictionId(totals), '2026-08-24-1557376-goals-over2.5');
  assert.ok(!predictionId(outcome).includes('undefined'), 'no absent line may leak into the id');
});
