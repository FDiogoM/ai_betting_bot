'use strict';

const { z } = require('zod');
const fixtureBaseline = require('../baselines/fixtureBaseline');
const { marketViewFor, selectionView } = require('../aggregate/marketView');
const { jointSample } = require('../aggregate/jointProfile');
const correlation = require('../baselines/correlation');
const { evaluateMultiple } = require('../baselines/multiple');
const markets = require('../markets');
const { run } = require('../result');

// Which sample column a family's total lives in, for the correlation estimate.
const TOTAL_KEY = { corners: 'totalCorners', goals: 'totalGoals' };

// Everything a leg needs, derived rather than transcribed — the same rule
// record_prediction follows, for the same reason: a price or a baseline typed
// by hand is one nobody can check, and a multiple multiplies whatever error is
// in it.
async function resolveLeg(leg, matchCount) {
  const baseline = await fixtureBaseline.baselineFor(
    leg.market.family, leg.fixtureId, matchCount, [leg.market.line], false);
  const priced = fixtureBaseline.lineOf(baseline, leg.market.line);
  const view = await marketViewFor(leg.market.family, leg.fixtureId, false);
  const selection = selectionView(view, leg.market.line, leg.market.selection);

  return {
    fixtureId: leg.fixtureId,
    fixture: baseline.fixture,
    market: leg.market,
    label: `${baseline.fixture.home}–${baseline.fixture.away} ${leg.market.family} `
      + `${leg.market.selection} ${leg.market.line}`,
    probability: leg.probability,
    baselineProbability: leg.market.selection === 'over'
      ? priced.overProbability : priced.underProbability,
    decimalOdd: selection.bestPrice,
    bookmaker: selection.bookmaker,
    overround: selection.overround,
    consensusProbability: selection.consensusProbability
  };
}

// Legs on one fixture may be correlated; legs on different fixtures are treated as
// independent. That second half is an assumption too — five overs on one
// evening of the same competition share conditions no fixture id can see — but
// it is a far smaller one than multiplying two selections on the same match.
function groupByFixture(legs) {
  const groups = new Map();
  for (const leg of legs) {
    if (!groups.has(leg.fixtureId)) groups.set(leg.fixtureId, []);
    groups.get(leg.fixtureId).push(leg);
  }
  return [...groups.values()];
}

async function correlationFor(group, matchCount) {
  const conditions = group.map((leg) => ({
    key: TOTAL_KEY[leg.market.family],
    selection: leg.market.selection,
    line: leg.market.line
  }));
  if (conditions.some((c) => !c.key)) {
    return { measured: null, note: 'a family in this group has no total to correlate on' };
  }

  const sample = await jointSample(
    group[0].fixture.homeId, group[0].fixture.awayId, matchCount, false);
  const measured = correlation.empiricalJoint(sample.matches, conditions);

  return {
    measured,
    pearson: correlation.pearson(sample.matches, 'totalGoals', 'totalCorners'),
    sampleSize: sample.n,
    caveats: sample.caveats
  };
}

function register(server) {
  server.registerTool(
    'evaluate_multiple',
    {
      title: 'Price a combination of selections',
      description: 'Prices two or more selections as one bet. Legs on DIFFERENT fixtures are '
        + 'multiplied as independent; legs on the SAME fixture are not, because two selections on '
        + 'one match need not be — and the correction is MEASURED from how often the pair actually '
        + 'cleared both lines across the same teams\' recent matches, never assumed in either '
        + 'direction. Read `correlation`: a lift near 1 means independence was close enough on '
        + 'this pair, which is a finding rather than a default. Derives every baseline and price '
        + 'itself. Returns the compounded bookmaker margin, how often the bet loses everything, '
        + 'and the same stake spread across singles for comparison, because those are the three '
        + 'numbers that decide whether a combination is worth its payout. It does not decide '
        + 'whether to place it.',
      inputSchema: {
        legs: z.array(z.object({
          fixtureId: z.number().int().positive(),
          market: z.object({
            family: z.enum(markets.FAMILY_NAMES),
            selection: z.enum(['over', 'under']),
            line: z.number().describe('Half-integer market line.')
          }),
          probability: z.number().gt(0).lt(1).describe('YOUR probability for this leg alone.')
        })).min(2).describe('Two or more selections. Each should be one you would back on its '
          + 'own: a combination is a staking decision, not a way to rescue a leg that failed '
          + 'the edge filter.'),
        matchCount: z.number().int().min(1).max(20).optional()
          .describe('Pass the same value you used for the baselines.'),
        stakeUnits: z.number().gt(0).max(1).optional()
          .describe('Total stake for the singles comparison. Defaults to 1.')
      }
    },
    async ({ legs, matchCount, stakeUnits }) =>
      run('evaluate_multiple', async () => {
        const resolved = [];
        for (const leg of legs) resolved.push(await resolveLeg(leg, matchCount));

        const groups = groupByFixture(resolved);
        const correlations = [];
        let jointProbability = 1;
        let anyCorrelated = false;

        for (const group of groups) {
          const marginals = group.map((l) => l.probability);
          if (group.length === 1) {
            jointProbability *= marginals[0];
            continue;
          }

          anyCorrelated = true;
          const c = await correlationFor(group, matchCount);
          const lift = c.measured ? c.measured.lift : null;
          const joint = correlation.jointProbability(marginals, lift);
          jointProbability *= joint.probability;

          correlations.push({
            fixtureId: group[0].fixtureId,
            fixture: `${group[0].fixture.home}–${group[0].fixture.away}`,
            legs: group.map((l) => l.label),
            independentProduct: Math.round(marginals.reduce((a, b) => a * b, 1) * 1e6) / 1e6,
            correctedProbability: joint.probability,
            ...c
          });
        }

        const evaluation = evaluateMultiple(
          resolved.map((l) => ({
            label: l.label,
            probability: l.probability,
            decimalOdd: l.decimalOdd,
            overround: l.overround
          })),
          { jointProbability: anyCorrelated ? jointProbability : null, stakeUnits: stakeUnits || 1 }
        );

        return {
          ...evaluation,
          fixtures: groups.length,
          sameFixtureGroups: correlations.length,
          correlation: correlations.length ? correlations : null,
          legDetail: resolved.map((l) => ({
            label: l.label,
            fixtureId: l.fixtureId,
            yourProbability: l.probability,
            baselineProbability: l.baselineProbability,
            marketConsensus: l.consensusProbability,
            bestPrice: l.decimalOdd,
            bookmaker: l.bookmaker
          }))
        };
      })
  );
}

module.exports = { register };
