'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { account, activeDays } = require('../sim/accounting');
const correlation = require('../baselines/correlation');
const markets = require('../markets');

function prediction(id, day, stake = 1, price = 2) {
  return {
    type: 'prediction',
    id,
    recordedAt: `${day}T09:00:00.000Z`,
    fixture: { home: 'H', away: 'A', kickoff: `${day}T19:00:00+00:00` },
    market: { family: 'goals', selection: 'over', line: 2.5 },
    marketView: { bestPrice: price },
    agent: { stake }
  };
}

function settlement(id, day, outcome, returnUnits) {
  return { type: 'settlement', predictionId: id, settledAt: `${day}T22:00:00.000Z`,
    outcome, returnUnits };
}

// --- the day ledger ----------------------------------------------------------

test('only days on which something happened get a row', () => {
  const days = activeDays(
    [prediction('1', '2026-08-01'), prediction('2', '2026-08-05')],
    [settlement('1', '2026-08-02', 'win', 1)]
  );

  // The 3rd and 4th are absent, not flat: padding the curve with days that
  // never existed would invent a shape the money never had.
  assert.deepStrictEqual(days, ['2026-08-01', '2026-08-02', '2026-08-05']);
});

// The balance moves once, at settlement, by the net result. The stake is never
// taken out and put back, because returnUnits is already net of it.
test('the balance moves at settlement, not at placement', () => {
  const a = account(
    [prediction('1', '2026-08-01')],
    [settlement('1', '2026-08-02', 'win', 1)],
    { openingBalance: 100 }
  );

  const [placed, settled] = a.days;
  assert.strictEqual(placed.closingBalance, 100, 'placing a bet does not move the balance');
  assert.strictEqual(placed.openExposure, 1, 'it moves the exposure');
  assert.strictEqual(settled.closingBalance, 101);
  assert.strictEqual(settled.openExposure, 0, 'and settling releases it');
});

test('exposure is carried, never folded into the balance', () => {
  const a = account(
    [prediction('1', '2026-08-01', 3), prediction('2', '2026-08-01', 6)],
    [],
    { openingBalance: 100 }
  );

  assert.strictEqual(a.closingBalance, 100, 'nothing has resolved, so nothing is won or lost');
  assert.strictEqual(a.openExposure, 9, 'but nine units are committed');
  assert.strictEqual(a.openBets, 2);
});

test('a bet opened one day and closed another is counted in both', () => {
  const a = account(
    [prediction('1', '2026-08-01')],
    [settlement('1', '2026-08-03', 'loss', -1)],
    { openingBalance: 100 }
  );

  assert.strictEqual(a.days[0].betsOpened, 1);
  assert.strictEqual(a.days[0].betsClosed, 0);
  assert.strictEqual(a.days[1].betsOpened, 0);
  assert.strictEqual(a.days[1].betsClosed, 1);
  assert.strictEqual(a.days[1].closingBalance, 99);
});

test('the open count runs across days rather than resetting', () => {
  const a = account(
    [prediction('1', '2026-08-01'), prediction('2', '2026-08-02'), prediction('3', '2026-08-02')],
    [settlement('1', '2026-08-03', 'win', 1)],
    { openingBalance: 100 }
  );

  assert.deepStrictEqual(a.days.map((d) => d.openBets), [1, 3, 2]);
});

test('a void releases the exposure and leaves the balance alone', () => {
  const a = account(
    [prediction('1', '2026-08-01', 2)],
    [settlement('1', '2026-08-02', 'void', 0)],
    { openingBalance: 100 }
  );

  assert.strictEqual(a.closingBalance, 100);
  assert.strictEqual(a.openExposure, 0);
  assert.strictEqual(a.days[1].voided, 1);
});

test('the drawdown is measured from the peak, not from the start', () => {
  const a = account(
    [prediction('1', '2026-08-01'), prediction('2', '2026-08-02'), prediction('3', '2026-08-03')],
    [settlement('1', '2026-08-01', 'win', 5),
      settlement('2', '2026-08-02', 'loss', -3),
      settlement('3', '2026-08-03', 'loss', -1)],
    { openingBalance: 100 }
  );

  assert.strictEqual(a.closingBalance, 101);
  assert.strictEqual(a.maxDrawdown, 4, 'from a peak of 105 down to 101');
});

// --- the month ---------------------------------------------------------------

test('a month opens where its first active day opened and closes where its last closed', () => {
  const a = account(
    [prediction('1', '2026-08-20'), prediction('2', '2026-09-02')],
    [settlement('1', '2026-08-21', 'win', 2), settlement('2', '2026-09-03', 'loss', -1)],
    { openingBalance: 100 }
  );

  const [august, september] = a.months;
  assert.strictEqual(august.month, '2026-08');
  assert.strictEqual(august.openingBalance, 100);
  assert.strictEqual(august.closingBalance, 102);
  assert.strictEqual(august.resultUnits, 2);
  assert.strictEqual(september.openingBalance, 102, 'the next month opens where the last closed');
  assert.strictEqual(september.closingBalance, 101);
  assert.strictEqual(september.resultUnits, -1);
});

test('a month reports what is still riding when it ends', () => {
  const a = account(
    [prediction('1', '2026-08-30', 2), prediction('2', '2026-08-31', 3)],
    [settlement('1', '2026-08-30', 'win', 2)],
    { openingBalance: 100 }
  );

  const [august] = a.months;
  assert.strictEqual(august.betsOpened, 2);
  assert.strictEqual(august.betsClosed, 1);
  assert.strictEqual(august.openAtClose, 1);
  assert.strictEqual(august.exposureAtClose, 3);
});

// An exposure figure with no contents is a number nobody can act on.
test('open bets are listed, with what a win would return', () => {
  const a = account([prediction('1', '2026-08-01', 0.5, 3)], [], { openingBalance: 100 });

  const [open] = a.openDetail;
  assert.strictEqual(open.fixture, 'H–A');
  assert.strictEqual(open.stake, 0.5);
  assert.strictEqual(open.toReturn, 1, '0.5 at 3.0 returns 1.0 profit');
  assert.strictEqual(open.selection, 'over 2.5');
});

test('an outcomes bet lists its selection without a line', () => {
  const p = prediction('1', '2026-08-01');
  p.market = { family: 'matchResult', selection: 'home' };

  const a = account([p], [], { openingBalance: 100 });

  assert.strictEqual(a.openDetail[0].selection, 'home', 'no line means no line in the label');
});

test('an empty ledger accounts to the opening balance rather than failing', () => {
  const a = account([], [], { openingBalance: 250 });

  assert.strictEqual(a.closingBalance, 250);
  assert.deepStrictEqual(a.days, []);
  assert.deepStrictEqual(a.months, []);
  assert.strictEqual(a.openExposure, 0);
});

// --- correlation across shapes -----------------------------------------------

// A same-game multiple can mix an outcomes leg with a totals one, so the
// correlation module has to evaluate both against the same historical match
// without learning what either means.
test('a mixed-shape pair is correlated from the same sample', () => {
  const rows = [];
  for (let i = 0; i < 12; i += 1) rows.push({ home: 2, away: 0, totalGoals: 2, totalCorners: 8 });
  for (let i = 0; i < 12; i += 1) rows.push({ home: 1, away: 2, totalGoals: 3, totalCorners: 11 });

  const j = correlation.empiricalJoint(rows, [
    { needs: ['home', 'away'], test: (s) => markets.settles('matchResult', 'away', s) },
    { key: 'totalGoals', selection: 'over', line: 2.5 }
  ]);

  assert.deepStrictEqual(j.marginalRates, [0.5, 0.5]);
  assert.strictEqual(j.jointRate, 0.5, 'the away wins are exactly the high-scoring games');
  // Raw lift of 2 is beyond what a sample this size can justify.
  assert.strictEqual(j.clamped, true);
  assert.strictEqual(j.lift, correlation.MAX_LIFT);
});

test('a row missing a count needed by a predicate is not counted as a failure', () => {
  const rows = [];
  for (let i = 0; i < 20; i += 1) rows.push({ home: 1, away: 0, totalGoals: 1 });
  rows.push({ totalGoals: 5 });   // no score, so no outcomes condition can be judged

  const j = correlation.empiricalJoint(rows, [
    { needs: ['home', 'away'], test: (s) => markets.settles('matchResult', 'home', s) }
  ]);

  assert.strictEqual(j.n, 20, 'the row without a score is excluded, not read as a loss');
});
