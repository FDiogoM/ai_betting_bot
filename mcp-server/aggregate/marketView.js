'use strict';

const provider = require('../provider/apiFootball');
const cache = require('../cache');
const devig = require('../baselines/devig');
const { parseQuotes } = require('./marketOdds');

// The market's own opinion on one fixture, de-vigged. Extracted from the
// get_market_probabilities handler for the same reason the baseline was:
// record_prediction has to derive this itself rather than be handed a copy of
// it, or the price and consensus in the permanent record are whatever the
// caller typed.

const round = (n) => Math.round(n * 1e4) / 1e4;

// Per line: every bookmaker's de-vigged view, the median of those views, and
// the best price on each side. `consensus` is null when the line is quoted on
// one side only — de-vigging needs both, and inventing the other side would
// manufacture a probability nobody quoted.
function summariseLine(quote) {
  const perBook = new Map();
  for (const side of ['over', 'under']) {
    for (const q of quote[side]) {
      if (!perBook.has(q.bookmaker)) perBook.set(q.bookmaker, { bookmaker: q.bookmaker });
      perBook.get(q.bookmaker)[side] = q.odd;
    }
  }

  const bookmakers = [];
  const fairOvers = [];
  const overrounds = [];
  for (const book of perBook.values()) {
    if (book.over === undefined || book.under === undefined) {
      bookmakers.push({ ...book, fairOverProbability: null });
      continue;
    }
    const [fairOver] = devig.fairProbabilities([book.over, book.under]);
    fairOvers.push(fairOver);
    overrounds.push(devig.overround([book.over, book.under]));
    bookmakers.push({ ...book, fairOverProbability: round(fairOver) });
  }

  return {
    line: quote.line,
    bookmakers,
    consensus: fairOvers.length ? {
      overProbability: round(devig.median(fairOvers)),
      underProbability: round(1 - devig.median(fairOvers))
    } : null,
    overround: overrounds.length ? round(devig.median(overrounds)) : null,
    bestPrice: {
      over: quote.over.length ? devig.bestPrice(quote.over) : null,
      under: quote.under.length ? devig.bestPrice(quote.under) : null
    }
  };
}

// Every line this family is quoted on, or null when nobody quotes the family.
async function marketViewFor(family, fixtureId, forceRefresh) {
  const odds = await provider.fetch(provider.ENDPOINTS.ODDS,
    { fixture: fixtureId }, cache.TTL.ODDS, forceRefresh);

  const quotes = parseQuotes(family, odds);
  if (!quotes.length) return null;

  return { fixtureId, market: family, lines: quotes.map(summariseLine) };
}

/**
 * The market's view of one selection, in the shape the ledger records.
 *
 * Throws rather than returning a partial record: a prediction without a price
 * has no edge, and a prediction priced from the wrong side is worse than none.
 */
function selectionView(view, line, selection) {
  if (!view) throw new Error('no bookmaker quotes this market on this fixture');

  const priced = view.lines.find((l) => l.line === line);
  if (!priced) {
    throw new Error(`no bookmaker quotes line ${line} on this market; `
      + `quoted lines are ${view.lines.map((l) => l.line).join(', ') || 'none'}`);
  }

  const best = priced.bestPrice[selection];
  if (!best) throw new Error(`line ${line} is not quoted on the ${selection} side`);

  return {
    consensusProbability: priced.consensus
      ? priced.consensus[selection === 'over' ? 'overProbability' : 'underProbability']
      : null,
    bestPrice: best.odd,
    bookmaker: best.bookmaker,
    overround: priced.overround
  };
}

module.exports = { marketViewFor, selectionView, summariseLine };
