'use strict';

const provider = require('../provider/apiFootball');
const cache = require('../cache');
const devig = require('../baselines/devig');
const { parseQuotes, parseOutcomes } = require('./marketOdds');
const books = require('../bookmakers');

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

  // The consensus above was computed from every book quoting the line, which is
  // right: the market's opinion is best estimated from all of it. The price
  // below comes only from books an account is held with, which is also right,
  // and for the opposite reason — it is the only money actually on the table.
  // These were the same thing until 2026-08-24, and 26 of 34 recorded
  // predictions carry a price the operator could not have taken.
  const usableOver = books.usable(quote.over);
  const usableUnder = books.usable(quote.under);

  return {
    line: quote.line,
    bookmakers,
    consensus: fairOvers.length ? {
      overProbability: round(devig.median(fairOvers)),
      underProbability: round(1 - devig.median(fairOvers))
    } : null,
    overround: overrounds.length ? round(devig.median(overrounds)) : null,
    bestPrice: {
      over: usableOver.length ? devig.bestPrice(usableOver) : null,
      under: usableUnder.length ? devig.bestPrice(usableUnder) : null
    },
    // How many of YOUR books quote each side, as opposed to how many exist. A
    // line the whole market prices and yours does not is a line you cannot back,
    // and that was invisible while the best price came from anywhere.
    quotedByUsable: { over: usableOver.length, under: usableUnder.length }
  };
}

// A market with named selections, de-vigged across all of them at once.
//
// De-vigging a three-way needs all three, not a pair: the margin is spread over
// every outcome, and normalising two of them would hand the third's share to
// whichever two were present. So a selection nobody quoted makes the whole
// consensus null rather than a plausible-looking number computed from a partial
// book — the same rule the two-way path already follows.
function summariseOutcomes(family, bySelection) {
  const spec = require('../markets').get(family);
  const perBook = new Map();
  for (const selection of spec.selections) {
    for (const q of bySelection[selection]) {
      if (!perBook.has(q.bookmaker)) perBook.set(q.bookmaker, { bookmaker: q.bookmaker });
      perBook.get(q.bookmaker)[selection] = q.odd;
    }
  }

  const complete = [...perBook.values()].filter(
    (book) => spec.selections.every((s) => book[s] !== undefined));

  // How much the TRUE probabilities of these selections sum to. One for a
  // partition, two for double chance because every result makes two of the
  // three good, and null where the selections neither exclude nor exhaust each
  // other. A live book read 112% margin on double chance and -56% on win to nil
  // before this existed: normalising to 1 is only correct for a partition, and
  // the two families that are not one were reporting nonsense.
  const { partitionSum } = spec;

  const fairBySelection = {};
  for (const s of spec.selections) fairBySelection[s] = [];
  const overrounds = [];
  if (partitionSum) {
    for (const book of complete) {
      const odds = spec.selections.map((s) => book[s]);
      const raw = odds.map((o) => 1 / o);
      const sum = raw.reduce((a, b) => a + b, 0);
      // Normalised to partitionSum rather than to 1.
      spec.selections.forEach((s, i) => fairBySelection[s].push((raw[i] / sum) * partitionSum));
      overrounds.push(sum / partitionSum - 1);
    }
  }

  const selections = {};
  for (const s of spec.selections) {
    const quotes = bySelection[s];
    const takeable = books.usable(quotes);
    selections[s] = {
      // From everyone: the market's opinion.
      consensusProbability: fairBySelection[s].length
        ? round(devig.median(fairBySelection[s])) : null,
      // From your books only: the price you can take.
      bestPrice: takeable.length ? devig.bestPrice(takeable) : null,
      bookmakers: quotes.length,
      quotedByUsable: takeable.length
    };
  }

  return {
    selections,
    completeBooks: complete.length,
    overround: overrounds.length ? round(devig.median(overrounds)) : null
  };
}

// Everything this family is quoted on, or null when nobody quotes it. The shape
// of the answer follows the shape of the family, because a three-way result has
// no line to key on and an over/under has no named selections.
async function marketViewFor(family, fixtureId, forceRefresh) {
  const odds = await provider.fetch(provider.ENDPOINTS.ODDS,
    { fixture: fixtureId }, cache.TTL.ODDS, forceRefresh);

  const spec = require('../markets').get(family);
  if (spec.shape === 'outcomes') {
    const parsed = parseOutcomes(family, odds);
    const anyQuoted = spec.selections.some((s) => parsed[s].length);
    if (!anyQuoted) return null;
    return { fixtureId, market: family, shape: 'outcomes', ...summariseOutcomes(family, parsed) };
  }

  const quotes = parseQuotes(family, odds);
  if (!quotes.length) return null;

  return { fixtureId, market: family, shape: 'totals', lines: quotes.map(summariseLine) };
}

// A selection nobody you can bet with has priced. Names the restriction,
// because "nobody quotes this" and "your book does not quote this" are very
// different problems and only the second is fixable by opening an account.
function unquoted(what, quotedByAnyone) {
  const allowed = books.configured();
  if (!allowed) return `nobody quotes "${what}" on this fixture`;
  return quotedByAnyone
    ? `"${what}" is quoted by ${quotedByAnyone} bookmaker(s) but none of yours (${allowed.join(', ')}), `
      + 'so there is no price you can take'
    : `nobody quotes "${what}" on this fixture`;
}

/**
 * The market's view of one selection, in the shape the ledger records.
 *
 * Throws rather than returning a partial record: a prediction without a price
 * has no edge, and a prediction priced from the wrong side is worse than none.
 */
function selectionView(view, line, selection) {
  if (!view) throw new Error('no bookmaker quotes this market on this fixture');

  if (view.shape === 'outcomes') {
    const priced = view.selections[selection];
    if (!priced) {
      throw new Error(`"${selection}" is not a selection of ${view.market}; `
        + `it offers ${Object.keys(view.selections).join(', ')}`);
    }
    if (!priced.bestPrice) throw new Error(unquoted(selection, priced.bookmakers));
    return {
      consensusProbability: priced.consensusProbability,
      bestPrice: priced.bestPrice.odd,
      bookmaker: priced.bestPrice.bookmaker,
      overround: view.overround,
      execution: books.restriction()
    };
  }

  const priced = view.lines.find((l) => l.line === line);
  if (!priced) {
    throw new Error(`no bookmaker quotes line ${line} on this market; `
      + `quoted lines are ${view.lines.map((l) => l.line).join(', ') || 'none'}`);
  }

  const best = priced.bestPrice[selection];
  if (!best) throw new Error(unquoted(`${selection} ${line}`, priced.bookmakers.length));

  return {
    consensusProbability: priced.consensus
      ? priced.consensus[selection === 'over' ? 'overProbability' : 'underProbability']
      : null,
    bestPrice: best.odd,
    bookmaker: best.bookmaker,
    overround: priced.overround,
    // What was in force when this was read, carried so a ledger spanning a
    // change of regime can still be told apart.
    execution: books.restriction()
  };
}

module.exports = { marketViewFor, selectionView, summariseLine };
