'use strict';

const { z } = require('zod');
const fixtureBaseline = require('../baselines/fixtureBaseline');
const { marketViewFor, selectionView } = require('../aggregate/marketView');
const markets = require('../markets');
const { evaluate } = require('../baselines/value');
const { suggestStake } = require('../baselines/staking');
const { run } = require('../result');

const forceRefresh = z.boolean().optional()
  .describe('Bypass the cache and refetch. Costs requests against the daily quota.');

// Both baselines are the same tool with a different count behind them. The work
// itself lives in baselines/fixtureBaseline.js, so record_prediction can derive
// the same numbers rather than being handed a transcription of them.
function registerBaselineTool(server, spec) {
  const shared = fixtureBaseline.spec(spec.family);
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: {
        fixtureId: z.number().int().positive().describe('Fixture ID of the upcoming match.'),
        matchCount: z.number().int().min(1).max(shared.maxMatchCount)
          .default(shared.defaultMatchCount)
          .describe(`Recent finished matches per team (default ${shared.defaultMatchCount}, `
            + `max ${shared.maxMatchCount}).`),
        lines: z.array(z.number()).optional()
          .describe(`Market lines to price. Defaults to ${shared.defaultLines.join(', ')}.`),
        forceRefresh
      }
    },
    async ({ fixtureId, matchCount, lines, forceRefresh }) =>
      run(`${spec.name}(${fixtureId})`, () =>
        fixtureBaseline.baselineFor(spec.family, fixtureId, matchCount, lines, forceRefresh))
  );
}

function register(server) {
  registerBaselineTool(server, {
    name: 'get_corner_baseline',
    family: 'corners',
    title: 'Get the corner baseline for a fixture',
    description: 'A deterministic corner baseline for one upcoming fixture. Blends each team\'s '
      + 'corners-for with the opponent\'s corners-against, split by venue, into a Poisson '
      + 'expectation, and prices every standard line. Returns the empirical rate beside each '
      + 'parametric probability and declares its own simplifications in `caveats` — read them, '
      + 'especially `sampleSeasons` early in a season when recent matches may predate it. '
      + 'This is arithmetic, not a recommendation: it has no view on whether the price is worth '
      + 'taking.'
  });

  registerBaselineTool(server, {
    name: 'get_goals_baseline',
    family: 'goals',
    title: 'Get the total-goals baseline for a fixture',
    description: 'A deterministic total-goals baseline for one upcoming fixture. The rate is '
      + 'estimated from SHOTS ON TARGET × a pooled conversion, not from goals scored: goals are '
      + 'the noisy outcome, shots the repeatable process, and over a short window a shots-based '
      + 'rate rests on several times as many events. Check `signal` — it reads "shots", or '
      + '"goals" when coverage was too thin and the older, noisier model was used instead. '
      + '`comparison` carries what the goals-based model would have said, so you can see what '
      + 'changed. The empirical rate and dispersion are always computed from real goals, so they '
      + 'remain an independent check on the model. Costs one request per match per team like the '
      + 'corner baseline, but usually spends nothing extra: the corner profile has already '
      + 'fetched those same statistics and finished matches are cached permanently. '
      + 'Arithmetic, not a recommendation.'
  });

  server.registerTool(
    'get_market_probabilities',
    {
      title: 'Get the market\'s implied probabilities for a total',
      description: 'Converts a fixture\'s odds on one market family into probabilities with the '
        + 'bookmaker margin removed, per bookmaker and as a consensus median, plus the best '
        + 'available price on each side. The consensus is the market\'s opinion — compare your own '
        + 'probability against it. The best price is what determines whether value exists. Only '
        + 'the full-match total is read: per-team, first-half and handicap variants of the same '
        + 'family are deliberately excluded, because they are different bets.',
      inputSchema: {
        fixtureId: z.number().int().positive().describe('Fixture ID of the upcoming match.'),
        market: z.enum(markets.FAMILY_NAMES).default('corners')
          .describe(`Market family: ${markets.FAMILY_NAMES.join(' or ')}.`),
        forceRefresh
      }
    },
    async ({ fixtureId, market, forceRefresh }) => {
      // The schema's default only applies to calls that go through it. A direct
      // caller — a test, or another tool — gets the same corner default here
      // rather than an "unknown market family undefined".
      const family = market || 'corners';
      // run() reports a null return as an explicit empty result.
      return run(`get_market_probabilities(${fixtureId}, ${family})`,
        () => marketViewFor(family, fixtureId, forceRefresh));
    }
  );

  server.registerTool(
    'suggest_stake',
    {
      title: 'Size a bet from its price and the quality of its evidence',
      description: 'Fractional Kelly on your probability and the best price, capped at one unit, '
        + 'then scaled down by what the baseline says about its own inputs — sample size, '
        + 'dispersion, whether the model and the sample agree, venue fallbacks, season '
        + 'boundaries, one-sided quotes. It derives the baseline itself rather than trusting a '
        + 'copy. Use it instead of choosing a stake by feel: a stake chosen by feel is the one '
        + 'lever in this system that moves P&L and that nothing measures. It returns every '
        + 'penalty it applied and why, so you can disagree with it in the open — and 0 when the '
        + 'price does not cover the probability, which means do not bet rather than bet small.',
      inputSchema: {
        fixtureId: z.number().int().positive().describe('Fixture ID of the upcoming match.'),
        market: z.object({
          family: z.enum(markets.FAMILY_NAMES),
          selection: z.enum(['over', 'under']),
          line: z.number().describe('Half-integer market line.')
        }),
        probability: z.number().gt(0).lt(1).describe('YOUR probability for this selection.'),
        matchCount: z.number().int().min(1).max(20).optional()
          .describe('Pass the same value you used for the baseline.'),
        bankrollFraction: z.number().gt(0).max(1).optional()
          .describe('What one unit means as a fraction of bankroll. Defaults to 0.01, matching '
            + 'stakeFraction in config/bulletin.json.')
      }
    },
    async ({ fixtureId, market, probability, matchCount, bankrollFraction }) =>
      run(`suggest_stake(${fixtureId})`, async () => {
        const baseline = await fixtureBaseline.baselineFor(
          market.family, fixtureId, matchCount, [market.line], false);
        const priced = fixtureBaseline.lineOf(baseline, market.line);
        const view = await marketViewFor(market.family, fixtureId, false);
        const selection = selectionView(view, market.line, market.selection);

        return suggestStake({
          probability,
          decimalOdd: selection.bestPrice,
          baseline: {
            probability: market.selection === 'over'
              ? priced.overProbability : priced.underProbability,
            empiricalRate: market.selection === 'over'
              ? priced.empiricalOverRate : 1 - priced.empiricalOverRate,
            empiricalSample: priced.empiricalSample,
            dispersionRatio: baseline.dispersion.ratio,
            signal: baseline.signal,
            caveats: baseline.caveats
          },
          marketView: selection,
          bankrollFraction
        });
      })
  );

  server.registerTool(
    'evaluate_bet',
    {
      title: 'Evaluate a bet\'s edge and expected value',
      description: 'Pure arithmetic on a probability and a price: implied probability, edge over '
        + 'it, and expected value per unit staked. Use this rather than computing it yourself — '
        + 'a sign error here corrupts the prediction record. It does not decide stake size.',
      inputSchema: {
        probability: z.number().gt(0).lt(1).describe('Your probability for the selection.'),
        decimalOdd: z.number().gt(1).describe('The decimal price available.'),
        stakeUnits: z.number().gt(0).max(1).default(1)
          .describe('Stake in units of the configured bankroll fraction. Never above 1.')
      }
    },
    async ({ probability, decimalOdd, stakeUnits }) =>
      run('evaluate_bet', async () => evaluate(probability, decimalOdd, stakeUnits))
  );
}

module.exports = { register };
