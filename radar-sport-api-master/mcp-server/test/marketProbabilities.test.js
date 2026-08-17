'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nock = require('nock');

const { parseCornerQuotes } = require('../aggregate/cornerOdds');
const baselines = require('../tools/baselines');

const BASE = 'https://v3.football.api-sports.io';

function fakeServer() {
  const tools = new Map();
  return { tools, registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
}

function handlers() {
  const server = fakeServer();
  baselines.register(server);
  return server.tools;
}

// 'Corners Over Under' is the exact full-match total name the Task 1 probe
// found. Do not loosen it in these fixtures — the anchoring is the point.
function book(name, overOdd, underOdd, marketName = 'Corners Over Under') {
  return {
    id: 1,
    name,
    bets: [{
      name: marketName,
      values: [{ value: 'Over 9.5', odd: String(overOdd) }, { value: 'Under 9.5', odd: String(underOdd) }]
    }]
  };
}

function oddsBody(bookmakers) {
  return { errors: [], response: [{ fixture: { id: 500 }, bookmakers }] };
}

test.beforeEach(() => {
  nock.cleanAll();
  process.env.API_FOOTBALL_KEY = 'test-key-123';
  process.env.MCP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-market-'));
});

test.afterEach(() => {
  fs.rmSync(process.env.MCP_CACHE_DIR, { recursive: true, force: true });
});

test('parseCornerQuotes groups both sides by line', () => {
  const quotes = parseCornerQuotes(oddsBody([book('A', 1.95, 1.85)]).response);

  assert.strictEqual(quotes.length, 1);
  assert.strictEqual(quotes[0].line, 9.5);
  assert.deepStrictEqual(quotes[0].over, [{ bookmaker: 'A', odd: 1.95 }]);
  assert.deepStrictEqual(quotes[0].under, [{ bookmaker: 'A', odd: 1.85 }]);
});

test('parseCornerQuotes ignores markets that are not about corners', () => {
  const body = oddsBody([{
    id: 1,
    name: 'A',
    bets: [{ name: 'Match Winner', values: [{ value: 'Home', odd: '2.10' }] }]
  }]);

  assert.deepStrictEqual(parseCornerQuotes(body.response), []);
});

// The live probe found ten adjacent markets whose names contain "corners" but
// which are different bets. Pooling any of them into the full-match buckets
// would back the wrong selection — silently, with a plausible-looking line.
test('parseCornerQuotes rejects every adjacent corner market', () => {
  const adjacent = [
    'Home Corners Over/Under', 'Away Corners Over/Under', 'Total Corners (3 way)',
    'Total Corners (1st Half)', 'Corners 1x2', 'Corners Asian Handicap',
    'Corners. Odd/Even', 'Corners. Total (Range)', 'Corners Race To', 'Multicorners',
    'Corners. European Handicap'
  ];

  for (const marketName of adjacent) {
    const quotes = parseCornerQuotes(oddsBody([book('A', 1.95, 1.85, marketName)]).response);
    assert.deepStrictEqual(quotes, [], `${marketName} must not be read as the full-match total`);
  }
});

test('parseCornerQuotes accepts the exact full-match total name', () => {
  const quotes = parseCornerQuotes(oddsBody([book('A', 1.95, 1.85, 'Corners Over Under')]).response);

  assert.strictEqual(quotes.length, 1);
  assert.strictEqual(quotes[0].line, 9.5);
});

// Pinnacle quotes whole lines alongside half lines. A whole line pushes when the
// total lands on it, and nothing downstream can represent a push.
test('parseCornerQuotes drops whole lines and keeps half lines', () => {
  const body = oddsBody([{
    id: 1,
    name: 'Pinnacle',
    bets: [{
      name: 'Corners Over Under',
      values: [
        { value: 'Over 9', odd: '1.49' }, { value: 'Under 9', odd: '2.47' },
        { value: 'Over 9.5', odd: '1.67' }, { value: 'Under 9.5', odd: '2.15' }
      ]
    }]
  }]);

  const quotes = parseCornerQuotes(body.response);

  assert.deepStrictEqual(quotes.map((q) => q.line), [9.5]);
});

test('parseCornerQuotes skips an unparseable value rather than guessing it', () => {
  const body = oddsBody([{
    id: 1,
    name: 'A',
    bets: [{
      name: 'Corners Over Under',
      values: [{ value: 'Yes', odd: '1.90' }, { value: 'Over 9.5', odd: '1.95' }]
    }]
  }]);

  const quotes = parseCornerQuotes(body.response);
  assert.strictEqual(quotes.length, 1);
  assert.strictEqual(quotes[0].over.length, 1);
  assert.strictEqual(quotes[0].under.length, 0);
});

test('get_market_probabilities de-vigs each book and takes a consensus', async () => {
  nock(BASE).get('/odds').query({ fixture: '500' })
    .reply(200, oddsBody([book('A', 1.95, 1.85), book('B', 2.05, 1.78), book('C', 1.90, 1.90)]));

  const result = await handlers().get('get_market_probabilities').handler({ fixtureId: 500 });

  assert.ok(!result.isError, result.content[0].text);
  const body = JSON.parse(result.content[0].text);
  const line = body.lines.find((l) => l.line === 9.5);

  assert.strictEqual(line.bookmakers.length, 3);
  assert.strictEqual(line.bestPrice.over.bookmaker, 'B');
  assert.strictEqual(line.bestPrice.over.odd, 2.05);
  // Fair over probabilities: A (1.95/1.85) = 0.4868, B (2.05/1.78) = 0.4648,
  // C (1.90/1.90) = 0.5000. Sorted, A is the middle one, so A is the median —
  // C sits at the top of the range, not in the middle of it.
  assert.strictEqual(line.consensus.overProbability, 0.4868);
  assert.strictEqual(line.consensus.underProbability, 0.5132);
  assert.ok(line.overround > 0, 'the raw book must carry a margin');
});

test('a line quoted by only one side is reported without a de-vigged consensus', async () => {
  // Named to match the anchored full-match-total pattern (Task 1 finding),
  // unlike the plan's original fixture, which used the non-matching 'Total
  // Corners' and so tested a market the parser was never meant to accept.
  nock(BASE).get('/odds').query({ fixture: '500' }).reply(200, oddsBody([{
    id: 1,
    name: 'A',
    bets: [{ name: 'Corners Over Under', values: [{ value: 'Over 9.5', odd: '1.95' }] }]
  }]));

  const result = await handlers().get('get_market_probabilities').handler({ fixtureId: 500 });

  const body = JSON.parse(result.content[0].text);
  const line = body.lines.find((l) => l.line === 9.5);
  assert.strictEqual(line.consensus, null,
    'a one-sided quote cannot be de-vigged, and a guess would be worse than nothing');
  assert.strictEqual(line.bestPrice.over.odd, 1.95);
});

test('a fixture with no corner market is empty, not an error', async () => {
  nock(BASE).get('/odds').query({ fixture: '500' }).reply(200, oddsBody([{
    id: 1, name: 'A', bets: [{ name: 'Match Winner', values: [{ value: 'Home', odd: '2.10' }] }]
  }]));

  const result = await handlers().get('get_market_probabilities').handler({ fixtureId: 500 });

  assert.ok(!result.isError, 'no corner market is a fact about the market, not a failure');
  assert.match(result.content[0].text, /"empty": true|no corner market/i);
});
