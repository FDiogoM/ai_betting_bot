'use strict';

const test = require('node:test');
const assert = require('node:assert');

const books = require('../bookmakers');
const { summariseLine, selectionView } = require('../aggregate/marketView');

test.beforeEach(() => { delete process.env.MCP_BOOKMAKERS; });
test.afterEach(() => { delete process.env.MCP_BOOKMAKERS; });

const QUOTE = {
  line: 3.5,
  over: [
    { bookmaker: '10Bet', odd: 4.5 },
    { bookmaker: 'Betano', odd: 3.0 },
    { bookmaker: 'Bet365', odd: 4.2 }
  ],
  under: [
    { bookmaker: '10Bet', odd: 1.2 },
    { bookmaker: 'Betano', odd: 1.42 },
    { bookmaker: 'Bet365', odd: 1.25 }
  ]
};

// --- the restriction ---------------------------------------------------------

test('unset means unrestricted, which is the old behaviour', () => {
  assert.strictEqual(books.configured(), null);
  assert.strictEqual(books.isAllowed('anyone at all'), true);
  assert.strictEqual(books.usable(QUOTE.over).length, 3);
});

test('a configured list admits only its own', () => {
  process.env.MCP_BOOKMAKERS = 'Betano';

  assert.deepStrictEqual(books.configured(), ['Betano']);
  assert.strictEqual(books.isAllowed('Betano'), true);
  assert.strictEqual(books.isAllowed('Bet365'), false);
  assert.deepStrictEqual(books.usable(QUOTE.over).map((q) => q.bookmaker), ['Betano']);
});

// The feed writes both "Win To Nil" and "Win to Nil - Away"; it cannot be
// trusted to be consistent about a bookmaker's capitals either.
test('matching tolerates case and spacing', () => {
  process.env.MCP_BOOKMAKERS = '  betano , BET365 ';

  assert.strictEqual(books.isAllowed('Betano'), true);
  assert.strictEqual(books.isAllowed('Bet365'), true);
  assert.strictEqual(books.isAllowed('Unibet'), false);
});

test('an empty or whitespace setting is treated as unset, not as no books', () => {
  process.env.MCP_BOOKMAKERS = '   ';
  assert.strictEqual(books.configured(), null, 'a blank must not lock out every bookmaker');
  assert.strictEqual(books.isAllowed('Betano'), true);
});

test('the restriction describes itself for the record', () => {
  assert.strictEqual(books.restriction().restrictedTo, null);
  assert.match(books.restriction().note, /unrestricted/);

  process.env.MCP_BOOKMAKERS = 'Betano';
  assert.deepStrictEqual(books.restriction().restrictedTo, ['Betano']);
  assert.match(books.restriction().note, /consensus still comes from every book/);
});

// --- the split that matters --------------------------------------------------

// The whole point: the consensus is the market's opinion and should use every
// book; the price is what you can take and must use only yours.
test('restricting the price leaves the consensus untouched', () => {
  const open = summariseLine(QUOTE);
  process.env.MCP_BOOKMAKERS = 'Betano';
  const closed = summariseLine(QUOTE);

  assert.deepStrictEqual(closed.consensus, open.consensus,
    'the market has the same opinion whoever you can bet with');
  assert.strictEqual(closed.overround, open.overround);
  assert.strictEqual(open.bestPrice.over.odd, 4.5, 'unrestricted takes the best anywhere');
  assert.strictEqual(closed.bestPrice.over.odd, 3.0, 'restricted takes only yours');
  assert.strictEqual(closed.bestPrice.over.bookmaker, 'Betano');
});

// Measured on one live fixture: over 3.5 goals was 4.50 elsewhere and 3.00 at
// Betano. A probability of 0.30 is a +7.8% edge against the first and -3.3%
// against the second, which is the difference between a strong pick and a bet
// that loses money.
test('the edge a restricted price implies can flip sign', () => {
  const open = summariseLine(QUOTE);
  process.env.MCP_BOOKMAKERS = 'Betano';
  const closed = summariseLine(QUOTE);

  const mine = 0.30;
  const edgeOpen = mine - 1 / open.bestPrice.over.odd;
  const edgeClosed = mine - 1 / closed.bestPrice.over.odd;

  assert.ok(edgeOpen > 0.05, `expected a strong edge against the best price, got ${edgeOpen}`);
  assert.ok(edgeClosed < 0, `expected a negative edge at the usable price, got ${edgeClosed}`);
});

test('how many of YOUR books quote a side is reported, not just how many exist', () => {
  process.env.MCP_BOOKMAKERS = 'Betano';
  const line = summariseLine(QUOTE);

  assert.strictEqual(line.bookmakers.length, 3, 'the market still has three');
  assert.deepStrictEqual(line.quotedByUsable, { over: 1, under: 1 });
});

// A line the whole market prices and yours does not is a line you cannot back.
// That was invisible while the best price could come from anywhere.
test('a side none of your books price has no takeable price at all', () => {
  process.env.MCP_BOOKMAKERS = 'Betano';
  const line = summariseLine({
    line: 9.5,
    over: [{ bookmaker: 'Pinnacle', odd: 1.68 }],
    under: [{ bookmaker: 'Betano', odd: 2.2 }]
  });

  assert.strictEqual(line.bestPrice.over, null, 'no price you can take is null, not the best one');
  assert.strictEqual(line.quotedByUsable.over, 0);
  assert.ok(line.bestPrice.under, 'the side yours does price is unaffected');
});

test('the error says whether the market or only your book is missing it', () => {
  process.env.MCP_BOOKMAKERS = 'Betano';
  const view = {
    shape: 'totals',
    lines: [summariseLine({
      line: 9.5,
      over: [{ bookmaker: 'Pinnacle', odd: 1.68 }],
      under: [{ bookmaker: 'Betano', odd: 2.2 }]
    })]
  };

  assert.throws(() => selectionView(view, 9.5, 'over'),
    /none of yours \(Betano\)/,
    'the message must distinguish "nobody prices this" from "you cannot reach it"');
});

test('what was in force travels with the reading', () => {
  process.env.MCP_BOOKMAKERS = 'Betano';
  const view = { shape: 'totals', lines: [summariseLine(QUOTE)] };

  const chosen = selectionView(view, 3.5, 'over');

  assert.deepStrictEqual(chosen.execution.restrictedTo, ['Betano']);
  assert.strictEqual(chosen.bestPrice, 3.0);
});
