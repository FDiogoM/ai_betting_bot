'use strict';

const { z } = require('zod');
const fixtureBaseline = require('../baselines/fixtureBaseline');
const { marketViewFor, selectionView } = require('../aggregate/marketView');
const markets = require('../markets');
const { run } = require('../result');

// Every market for one fixture, in one call.
//
// The families were built and the daily procedure went on asking for two of
// them, because asking for ten meant ten baseline calls and ten market calls per
// fixture — over a thousand across a night's card, which no run can make.
//
// The cost was never in the data. Measured on a live fixture: the first family
// takes 213ms and every one after it takes about 20, because the odds are one
// request per fixture and the statistics behind every totals profile are the
// same cached response. Ten families cost what two do. Only the CALLS were
// expensive, and that is what this collapses.
//
// It prices, it does not choose. Nothing here decides what is worth backing —
// the edge filter and the judgment do that, on the numbers this returns.

function edgeOf(probability, price) {
  return Math.round((probability - 1 / price) * 1e6) / 1e6;
}

// One totals family: every line it prices, beside every line the market quotes.
function totalsRows(baseline, view, family) {
  const rows = [];
  for (const priced of baseline.lines) {
    const quoted = view ? view.lines.find((l) => l.line === priced.line) : null;
    for (const selection of ['over', 'under']) {
      const best = quoted ? quoted.bestPrice[selection] : null;
      const probability = selection === 'over'
        ? priced.overProbability : priced.underProbability;
      rows.push({
        family,
        selection,
        line: priced.line,
        probability,
        empiricalRate: selection === 'over'
          ? priced.empiricalOverRate : 1 - priced.empiricalOverRate,
        empiricalSample: priced.empiricalSample,
        marketConsensus: quoted && quoted.consensus
          ? quoted.consensus[selection === 'over' ? 'overProbability' : 'underProbability']
          : null,
        bestPrice: best ? best.odd : null,
        bookmaker: best ? best.bookmaker : null,
        edge: best ? edgeOf(probability, best.odd) : null
      });
    }
  }
  return rows;
}

// One outcomes family: every named selection.
function outcomeRows(baseline, view, family) {
  return Object.entries(baseline.probabilities).map(([selection, probability]) => {
    let quoted = null;
    try {
      quoted = view ? selectionView(view, undefined, selection) : null;
    } catch (err) {
      quoted = null;   // your books do not price it; that is an answer
    }
    return {
      family,
      selection,
      line: null,
      probability,
      // An outcomes family has no line to have been cleared, so there is no
      // sample rate to report. Fabricating one would be worse than its absence.
      empiricalRate: null,
      empiricalSample: baseline.sample ? baseline.sample.pooled : null,
      marketConsensus: quoted ? quoted.consensusProbability : null,
      bestPrice: quoted ? quoted.bestPrice : null,
      bookmaker: quoted ? quoted.bookmaker : null,
      edge: quoted ? edgeOf(probability, quoted.bestPrice) : null
    };
  });
}

function register(server) {
  server.registerTool(
    'get_fixture_board',
    {
      title: 'Price every market for one fixture, in one call',
      description: 'Every market family this server builds — the totals (corners, cards, goals) '
        + 'and everything derived from the goal rates (match result, double chance, both teams '
        + 'to score, clean sheets, odd/even, win to nil) — priced against the market, for one '
        + 'fixture. Returns one row per selection with the model probability, the market '
        + 'consensus, the best price YOU can take and the edge between them. '
        + 'It costs barely more than a single family: the odds are one request per fixture and '
        + 'every totals profile reads the same cached statistics, so on a live fixture the first '
        + 'family took 213ms and each of the nine after it about 20. '
        + 'Use it instead of calling each family separately — that was ten baseline calls and ten '
        + 'market calls per fixture, which is why the procedure went on asking for two. '
        + 'It prices and does not choose: the edge filter and your own judgment decide what is '
        + 'worth backing, on these numbers.',
      inputSchema: {
        fixtureId: z.number().int().positive().describe('Fixture ID of the upcoming match.'),
        families: z.array(z.enum(markets.FAMILY_NAMES)).optional()
          .describe(`Restrict to some families. Defaults to all: ${markets.FAMILY_NAMES.join(', ')}.`),
        matchCount: z.number().int().min(1).max(20).optional()
          .describe('Recent matches per team behind each baseline.'),
        minEdge: z.number().optional()
          .describe('Return only selections at or above this edge. Omit for everything, which '
            + 'is what you want when deciding rather than filtering.'),
        forceRefresh: z.boolean().optional()
      }
    },
    async ({ fixtureId, families, matchCount, minEdge, forceRefresh }) =>
      run(`get_fixture_board(${fixtureId})`, async () => {
        const wanted = families && families.length ? families : markets.FAMILY_NAMES;
        let fixture = null;
        const rows = [];
        const skipped = [];

        for (const family of wanted) {
          const spec = markets.get(family);
          let baseline;
          try {
            baseline = await fixtureBaseline.baselineFor(family, fixtureId, matchCount,
              undefined, forceRefresh);
          } catch (err) {
            // One family that cannot be priced costs that family, never the
            // board: a promoted side with no history kills corners and leaves
            // goals perfectly usable.
            skipped.push({ family, reason: err && err.message ? err.message : String(err) });
            continue;
          }
          fixture = fixture || baseline.fixture;

          let view = null;
          try {
            view = await marketViewFor(family, fixtureId, forceRefresh);
          } catch (err) {
            view = null;
          }
          if (!view) skipped.push({ family, reason: 'no bookmaker you can use quotes this family' });

          rows.push(...(spec.shape === 'totals'
            ? totalsRows(baseline, view, family)
            : outcomeRows(baseline, view, family)));
        }

        if (!fixture) throw new Error('no family could be priced for this fixture');

        const priced = rows.filter((r) => r.bestPrice !== null);
        const kept = typeof minEdge === 'number'
          ? priced.filter((r) => r.edge >= minEdge) : priced;

        return {
          fixture,
          families: wanted.length,
          selections: rows.length,
          quoted: priced.length,
          skipped,
          // Sorted by edge so the interesting end is first, however many rows
          // there are. Unpriced selections are dropped rather than sorted to the
          // bottom: a selection with no price is not a bet.
          rows: kept.sort((a, b) => b.edge - a.edge)
        };
      })
  );
}

module.exports = { register };
