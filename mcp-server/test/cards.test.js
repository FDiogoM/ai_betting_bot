'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nock = require('nock');

const markets = require('../markets');
const { cardProfile, cardValue, CARD_TYPE } = require('../aggregate/cardProfile');
const { cardsBaseline } = require('../baselines/cards');
const { makeStatProfile } = require('../aggregate/statProfile');

const BASE = 'https://v3.football.api-sports.io';

test.beforeEach(() => {
  nock.cleanAll();
  process.env.API_FOOTBALL_KEY = 'test-key-123';
  process.env.MCP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cards-'));
});

test.afterEach(() => {
  fs.rmSync(process.env.MCP_CACHE_DIR, { recursive: true, force: true });
});

// --- the market --------------------------------------------------------------

// Read off the live probe against fixture 1557376 on 2026-08-24, which carried
// 185 markets. These are the ones sharing words with the yellow total without
// being it, and matching any would back a different bet without erroring.
const ADJACENT = [
  'Yellow Over/Under (1st Half)', 'Yellow Over/Under (2nd Half)',
  'Yellow Asian Handicap', 'Yellow Asian Handicap (1st Half)',
  'Yellow Cards 1x2', 'Yellow Cards 1x2 (1st Half)', 'Yellow Double Chance',
  'Yellow Odd/Even', 'Cards Over/Under', 'Cards Asian Handicap',
  'Cards European Handicap', 'Cards over/under between 0 and 10 m',
  'Home Team Yellow Cards', 'Away Team Yellow Cards',
  'Home Team Total Cards', 'Away Team Total Cards', 'First Card Received (3 way)'
];

test('the card family matches its own market and none of the adjacent ones', () => {
  assert.ok(markets.isMarket('cards', 'Yellow Over/Under'));
  for (const other of ADJACENT) {
    assert.ok(!markets.isMarket('cards', other), `must NOT match "${other}"`);
  }
  // Nor may another family reach it.
  assert.ok(!markets.isMarket('corners', 'Yellow Over/Under'));
  assert.ok(!markets.isMarket('goals', 'Yellow Over/Under'));
});

test('cards are declared as a totals family with half-integer lines', () => {
  const spec = markets.get('cards');

  assert.strictEqual(spec.shape, 'totals');
  assert.strictEqual(spec.observedKey, 'totalYellows');
  assert.strictEqual(spec.statType, 'Yellow Cards');
  for (const line of spec.defaultLines) {
    assert.strictEqual((line * 2) % 2, 1, `${line} must be a half-integer`);
  }
});

// --- the profile -------------------------------------------------------------

function played(id, homeId, awayId) {
  return {
    fixture: { id, status: { short: 'FT' }, date: `2026-08-0${id}T12:00:00+00:00` },
    league: { id: 39, name: 'Premier League', season: 2026 },
    teams: { home: { id: homeId, name: `T${homeId}` }, away: { id: awayId, name: `T${awayId}` } },
    goals: { home: 1, away: 1 }
  };
}

function stats(fixtureId, teamA, cardsA, teamB, cardsB) {
  nock(BASE).get('/fixtures/statistics').query({ fixture: String(fixtureId) }).reply(200, {
    errors: [],
    response: [
      { team: { id: teamA }, statistics: [{ type: CARD_TYPE, value: cardsA }] },
      { team: { id: teamB }, statistics: [{ type: CARD_TYPE, value: cardsB }] }
    ]
  });
}

test('a card profile counts yellows for and against', async () => {
  nock(BASE).get('/fixtures').query({ team: '33', last: '2' }).reply(200, {
    errors: [], response: [played(1, 33, 90), played(2, 91, 33)]
  });
  stats(1, 33, 2, 90, 3);
  stats(2, 91, 4, 33, 1);

  const profile = await cardProfile(33, 2, false);

  assert.strictEqual(profile.matchesAnalyzed, 2);
  assert.strictEqual(profile.totals.yellowsFor, 3);      // 2 at home, 1 away
  assert.strictEqual(profile.totals.yellowsAgainst, 7);  // 3 and 4
  assert.strictEqual(profile.averages.totalYellows, 5);
  assert.strictEqual(profile.matches[0].venue, 'away', 'most recent first');
});

// A missing count is not a clean game. Coerced to zero it would settle every
// under as a winner and drag every average down with it.
test('a missing card count fails the match rather than reading as zero', async () => {
  nock(BASE).get('/fixtures').query({ team: '33', last: '2' }).reply(200, {
    errors: [], response: [played(1, 33, 90), played(2, 33, 91)]
  });
  stats(1, 33, 2, 90, 3);
  stats(2, 33, null, 91, 2);

  const profile = await cardProfile(33, 2, false);

  assert.strictEqual(profile.matchesAnalyzed, 1);
  assert.strictEqual(profile.failures.length, 1);
  assert.match(profile.failures[0].reason, /yellow card statistics/);
});

test('a card count of zero is a real observation, not a missing one', () => {
  const entries = [{ team: { id: 7 }, statistics: [{ type: CARD_TYPE, value: 0 }] }];

  assert.strictEqual(cardValue(entries, 7), 0, 'a clean game is zero, and zero is a number');
});

// --- the shared machinery ----------------------------------------------------

// Corners and cards are the same shape over a different column. The factory
// exists so a third statistic is a registry entry rather than a third copy.
test('the profile factory names its fields after the statistic', async () => {
  const fouls = makeStatProfile({
    statType: 'Fouls', forKey: 'foulsFor', againstKey: 'foulsAgainst', totalKey: 'totalFouls'
  });

  nock(BASE).get('/fixtures').query({ team: '33', last: '1' }).reply(200, {
    errors: [], response: [played(1, 33, 90)]
  });
  nock(BASE).get('/fixtures/statistics').query({ fixture: '1' }).reply(200, {
    errors: [],
    response: [
      { team: { id: 33 }, statistics: [{ type: 'Fouls', value: 12 }] },
      { team: { id: 90 }, statistics: [{ type: 'Fouls', value: 9 }] }
    ]
  });

  const profile = await fouls.profile(33, 1, false);

  assert.strictEqual(profile.matches[0].foulsFor, 12);
  assert.strictEqual(profile.matches[0].foulsAgainst, 9);
  assert.strictEqual(profile.averages.totalFouls, 21);
});

// --- the baseline ------------------------------------------------------------

function profileOf(matches) {
  return { matches };
}

test('the card baseline blends each side against the other', () => {
  const home = profileOf(Array.from({ length: 5 }, () => (
    { venue: 'home', season: 2026, yellowsFor: 2, yellowsAgainst: 3 })));
  const away = profileOf(Array.from({ length: 5 }, () => (
    { venue: 'away', season: 2026, yellowsFor: 3, yellowsAgainst: 2 })));

  const b = cardsBaseline(home, away, [4.5], { currentSeason: 2026 });

  assert.strictEqual(b.lambda.home, 2);   // (2 home-for + 2 away-conceded) / 2
  assert.strictEqual(b.lambda.away, 3);   // (3 away-for + 3 home-conceded) / 2
  assert.strictEqual(b.lambda.total, 5);
  assert.strictEqual(b.lines[0].line, 4.5);
  assert.ok(b.caveats.some((c) => /no league normalisation/.test(c)),
    'cards inherit the same declared simplifications');
});

test('the empirical rate is computed from the real counts', () => {
  // Every match had exactly 5 yellows, so over 4.5 always and over 5.5 never.
  const side = (venue) => profileOf(Array.from({ length: 5 }, () => (
    { venue, season: 2026, yellowsFor: 2, yellowsAgainst: 3 })));

  const b = cardsBaseline(side('home'), side('away'), [4.5, 5.5], { currentSeason: 2026 });

  assert.strictEqual(b.lines.find((l) => l.line === 4.5).empiricalOverRate, 1);
  assert.strictEqual(b.lines.find((l) => l.line === 5.5).empiricalOverRate, 0);
});

test('a team with no matches is refused rather than priced', () => {
  assert.throws(
    () => cardsBaseline(profileOf([]), profileOf([{ venue: 'away', yellowsFor: 2, yellowsAgainst: 2 }])),
    /home team has no matches/);
});
