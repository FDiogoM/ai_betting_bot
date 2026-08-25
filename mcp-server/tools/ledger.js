'use strict';

const { z } = require('zod');
const store = require('../ledger/store');
const { predictionSchema, predictionId, DIVERGENCE_THRESHOLD } = require('../ledger/schema');
const { evaluate } = require('../baselines/value');
const { run } = require('../result');
const provider = require('../provider/apiFootball');
const cache = require('../cache');
const aggregate = require('../aggregate/cornerProfile');
const goalsAggregate = require('../aggregate/goalsProfile');
const cardAggregate = require('../aggregate/cardProfile');
const matchStats = require('../aggregate/matchStats');
const markets = require('../markets');
const scoring = require('../ledger/scoring');
const fixtureBaseline = require('../baselines/fixtureBaseline');
const marketView = require('../aggregate/marketView');
const clv = require('../baselines/clv');

const VOID_STATUSES = new Set(['ABD', 'CANC', 'PST', 'AWD', 'WO']);

// How each family reads its observed total off a finished fixture. Returns
// null when the number is not recorded — never a zero, because a missing count
// coerced to zero grades every under as a win.
//
// The two differ in cost as well as in source: corners need the per-match
// statistics endpoint, goals are already on the fixture that was fetched to
// check the status.
const OBSERVERS = {
  corners: async (fixture) => {
    const entries = await aggregate.fetchStatistics(fixture.fixture.id, false, cache.TTL.PERMANENT);
    const home = aggregate.cornerValue(entries, fixture.teams.home.id);
    const away = aggregate.cornerValue(entries, fixture.teams.away.id);
    return home === null || away === null ? null : home + away;
  },
  // Yellows arrive in the same statistics response corners already fetched, so
  // settling a card bet on a fixture that also carried a corner bet costs
  // nothing beyond arithmetic. A missing count is null and stays null: coerced
  // to zero it would settle every under as a winner.
  cards: async (fixture) => {
    const entries = await matchStats.fetchStatistics(
      fixture.fixture.id, false, cache.TTL.PERMANENT);
    const home = cardAggregate.cardValue(entries, fixture.teams.home.id);
    const away = cardAggregate.cardValue(entries, fixture.teams.away.id);
    return home === null || away === null ? null : home + away;
  },
  goals: async (fixture) => {
    const home = goalsAggregate.goalsOf(fixture.goals ? fixture.goals.home : null);
    const away = goalsAggregate.goalsOf(fixture.goals ? fixture.goals.away : null);
    return home === null || away === null ? null : home + away;
  }
};

/**
 * What the price taken was worth against the closing line.
 *
 * Never throws and never blocks a settlement. A missing snapshot, a market that
 * stopped being quoted, a provider hiccup — all of them make the value
 * unmeasurable, and an unmeasurable CLV must not cost the ledger a settled
 * result. The bet is still graded; only this reading is lost.
 */
async function measureClv(prediction) {
  try {
    const view = await marketView.marketViewFor(prediction.market.family,
      prediction.fixture.id, false);
    if (!view) return { measurable: false, note: 'nobody quoted this market at the close' };

    const closing = marketView.selectionView(view, prediction.market.line,
      prediction.market.selection);

    return clv.closingLineValue({
      takenPrice: prediction.marketView.bestPrice,
      closingPrice: closing.bestPrice,
      closingFairProbability: closing.consensusProbability,
      minutesBeforeKickoff: view.snapshotAt
        ? Math.round((new Date(prediction.fixture.kickoff) - new Date(view.snapshotAt)) / 60000)
        : null
    });
  } catch (err) {
    return { measurable: false,
      note: `no closing reading: ${err && err.message ? err.message : String(err)}` };
  }
}

// Settles one prediction, or returns null to leave it pending. Never infers a
// result: a finished match whose count is missing is void, not guessed.
async function settle(prediction) {
  const found = await provider.fetch(provider.ENDPOINTS.FIXTURES,
    { id: prediction.fixture.id }, cache.TTL.LIVE);
  if (!found.length) throw new Error(`fixture ${prediction.fixture.id} was not found`);

  const fixture = found[0];
  const status = fixture.fixture.status.short;
  const spec = markets.get(prediction.market.family);
  // A totals family needs an observer to read its count off the fixture. An
  // outcomes family does not: it settles from the score with the predicate the
  // registry declares, checked below.
  const observe = OBSERVERS[spec.family];
  if (spec.shape === 'totals' && !observe) {
    throw new Error(`no settlement rule for market family "${spec.family}"`);
  }

  const settlement = {
    type: 'settlement',
    predictionId: prediction.id,
    settledAt: new Date().toISOString(),
    fixtureStatus: status
  };
  const voided = { ...settlement, observed: { [spec.observedKey]: null },
    outcome: 'void', returnUnits: 0 };

  if (VOID_STATUSES.has(status)) return voided;
  if (!provider.isFinished(fixture)) return null;

  let won;
  let observed;

  if (spec.shape === 'outcomes') {
    // Every outcomes family settles from the final score, so there is one
    // observation and the family's own predicate decides. Nothing here knows
    // what "win to nil" means; markets/index.js does, which is where the
    // knowledge belongs and where a new family adds itself.
    const home = goalsAggregate.goalsOf(fixture.goals ? fixture.goals.home : null);
    const away = goalsAggregate.goalsOf(fixture.goals ? fixture.goals.away : null);
    // A finished match with no score recorded is void, never resolved by
    // treating a missing goal as zero — that would settle every "no" and every
    // clean sheet as a winner.
    if (home === null || away === null) return voided;
    observed = { score: `${home}-${away}`, home, away };
    won = markets.settles(spec.family, prediction.market.selection, { home, away });
  } else {
    const total = await observe(fixture);
    if (total === null) return voided;
    observed = { [spec.observedKey]: total };
    const cleared = total > prediction.market.line;
    won = prediction.market.selection === 'over' ? cleared : !cleared;
  }

  const stake = prediction.agent.stake;

  return {
    ...settlement,
    observed,
    // Measured here rather than by a job near kickoff, because the provider
    // keeps its last pre-match snapshot after the match — which the plan had
    // assumed it did not. See baselines/clv.js.
    closingLineValue: await measureClv(prediction),
    outcome: won ? 'win' : 'loss',
    returnUnits: won
      ? Math.round(stake * (prediction.marketView.bestPrice - 1) * 1e6) / 1e6
      : -stake
  };
}

function register(server) {
  server.registerTool(
    'record_prediction',
    {
      title: 'Record a prediction before kickoff',
      description: 'Writes one prediction to the append-only ledger. You supply the fixture, the '
        + 'selection, and your own judgment; the baseline, the market view, the edge and the '
        + 'expected value are DERIVED here from the same tools you just called — not copied from '
        + 'what you read. That is deliberate: a transcribed baseline is a number nobody can '
        + 'check, and the whole record rests on it. The result echoes back what was actually '
        + 'written, so compare it against what you had in front of you. Your probability is '
        + `required, and if it differs from the derived baseline by more than ${DIVERGENCE_THRESHOLD} `
        + 'you must supply divergenceReason — the write is refused otherwise.',
      // You supply what only you can supply — the fixture, the selection, and
      // your own judgment. Everything else is derived here. Cross-field rules
      // (the divergence requirement) cannot live in this per-key map, so the
      // assembled object is validated in the handler and a failure becomes an
      // error result via run().
      inputSchema: {
        fixtureId: z.number().int().positive().describe('Fixture ID of the upcoming match.'),
        market: z.object({
          family: z.enum(markets.FAMILY_NAMES)
            .describe(`Market family. Totals (a line and over/under): `
              + `${markets.TOTALS_FAMILIES.join(', ')}. Named selections and no line: `
              + `${markets.OUTCOME_FAMILY_NAMES.join(', ')}.`),
          selection: z.string()
            .describe('"over" or "under" for a totals family; otherwise the family\'s own '
              + 'selection, such as home/draw/away or yes/no. The exact set is validated '
              + 'against the family, so a wrong one is refused rather than recorded.'),
          line: z.number().optional()
            .describe('Half-integer line, for a totals family only. A market with named '
              + 'selections has no line and must not be given one.')
        }),
        matchCount: z.number().int().min(1).max(20).optional()
          .describe('Recent matches per team behind the baseline. Pass the SAME value you used '
            + 'when you called the baseline tool, or the derived baseline will not be the one '
            + 'you reasoned about.'),
        agent: z.object({
          probability: z.number().describe('Your probability for this selection.'),
          confidence: z.enum(['low', 'medium', 'high'])
            .describe('Confidence in the INPUTS — sample size, bookmaker coverage — not in the outcome.'),
          divergenceReason: z.string().optional()
            .describe('Why you differ from the baseline. Required beyond the threshold.'),
          stake: z.number().describe('Stake in units of the configured bankroll fraction, at most 1.')
        })
      }
    },
    async ({ fixtureId, market, matchCount, agent }) =>
      run('record_prediction', async () => {
        // Derived, never transcribed. Handing these in as text made the record
        // whatever the caller typed: a run on 2026-08-18 silently tidied the
        // duplicated venue caveats out of what it wrote, which was harmless and
        // proved the record was editable in transit. Everything below reads
        // from the same cache the baseline tools just filled, so this costs
        // arithmetic rather than requests.
        const isTotals = markets.get(market.family).shape === 'totals';
        const baseline = await fixtureBaseline.baselineFor(
          market.family, fixtureId, matchCount,
          isTotals ? [market.line] : undefined, false);

        const view = await marketView.marketViewFor(market.family, fixtureId, false);
        const selection = marketView.selectionView(view, market.line, market.selection);

        // A totals bet is scored against the line it was priced at; an outcomes
        // bet against the score matrix. The empirical rate exists only for the
        // first — there is no "how often did this sample clear the line" for a
        // 1X2 — and a fabricated one would be worse than its absence, so it is
        // reported as the baseline's own probability, which is what it is.
        const priced = isTotals ? fixtureBaseline.lineOf(baseline, market.line) : null;
        const baselineProbability = isTotals
          ? (market.selection === 'over' ? priced.overProbability : priced.underProbability)
          : baseline.probabilities[market.selection];

        if (typeof baselineProbability !== 'number') {
          throw new Error(`the ${market.family} baseline does not price "${market.selection}"`);
        }

        const value = predictionSchema.parse({
          fixture: {
            id: baseline.fixture.id,
            league: baseline.fixture.league,
            home: baseline.fixture.home,
            away: baseline.fixture.away,
            kickoff: baseline.fixture.kickoff
          },
          market,
          baseline: {
            probability: baselineProbability,
            // Side-specific, like the probability beside it: the empirical rate
            // for an under is how often the total came in UNDER the line. An
            // outcomes family has no line to have cleared, so it records the
            // parametric probability rather than inventing a sample rate.
            empiricalRate: isTotals
              ? (market.selection === 'over'
                ? priced.empiricalOverRate : 1 - priced.empiricalOverRate)
              : baselineProbability,
            empiricalSample: isTotals ? priced.empiricalSample : baseline.sample.pooled,
            lambda: baseline.lambda.total,
            dispersionRatio: baseline.dispersion.ratio,
            signal: baseline.signal,
            caveats: baseline.caveats
          },
          marketView: selection,
          agent
        });

        const id = predictionId(value);

        // Append-only means a duplicate cannot be corrected later, so it is
        // refused now.
        if (store.readAll().some((r) => r.type === 'prediction' && r.id === id)) {
          throw new Error(`${id} was already recorded; the ledger is append-only`);
        }

        const evaluated = evaluate(value.agent.probability, value.marketView.bestPrice, value.agent.stake);
        const record = {
          type: 'prediction',
          id,
          recordedAt: new Date().toISOString(),
          ...value,
          edge: evaluated.edge,
          expectedValue: evaluated.expectedValue
        };

        store.append(record);
        return {
          id,
          edge: record.edge,
          expectedValue: record.expectedValue,
          // Echoed back so the caller can see what was actually recorded rather
          // than assume it matches what they had in front of them.
          baseline: record.baseline,
          marketView: record.marketView
        };
      })
  );

  server.registerTool(
    'grade_pending_predictions',
    {
      title: 'Grade every prediction whose match has finished',
      description: 'Settles all outstanding predictions, not just yesterday\'s, so a missed run '
        + 'costs a day of picks rather than the record. Idempotent: a prediction that already '
        + 'carries a settlement is skipped. Handles every market family. A finished match whose '
        + 'count was never recorded is voided, never guessed.',
      inputSchema: {}
    },
    async () =>
      run('grade_pending_predictions', async () => {
        const records = store.readAll();
        const settledIds = new Set(records.filter((r) => r.type === 'settlement')
          .map((r) => r.predictionId));
        const pending = records.filter((r) => r.type === 'prediction' && !settledIds.has(r.id));

        let settled = 0;
        let stillPending = 0;
        const failures = [];

        // Sequential: the ledger is a single append-only file, and a settlement
        // count that races its own writes is worse than a slow run.
        for (const prediction of pending) {
          try {
            const settlement = await settle(prediction);
            if (!settlement) {
              stillPending += 1;
              continue;
            }
            store.append(settlement);
            settled += 1;
          } catch (err) {
            failures.push({ predictionId: prediction.id, reason: err && err.message ? err.message : String(err) });
          }
        }

        return { considered: pending.length, settled, stillPending, failures };
      })
  );

  server.registerTool(
    'get_ledger_summary',
    {
      title: 'Score the ledger',
      description: 'Scores the agent\'s probabilities against the baseline\'s over the same '
        + 'settled predictions: Brier, log loss, calibration by band, and realised P&L in units. '
        + 'There is no win rate — with varying prices it means nothing. Below '
        + `${scoring.INSUFFICIENT_N} settled predictions the verdict is "insufficient" rather `
        + 'than a number that looks meaningful.',
      inputSchema: {
        market: z.enum(markets.FAMILY_NAMES).optional()
          .describe('Restrict to one market family. Scores are only comparable within a family, '
            + `and each needs its own ${scoring.INSUFFICIENT_N} settled predictions.`),
        from: z.string().optional().describe('ISO date; include predictions recorded on or after it.'),
        to: z.string().optional().describe('ISO date; include predictions recorded before it.')
      }
    },
    async ({ market, from, to }) =>
      run('get_ledger_summary', async () => {
        const records = store.readAll();
        const inWindow = (r) => (!from || r.recordedAt >= from) && (!to || r.recordedAt < to);
        return scoring.summarise(
          records.filter((r) => r.type === 'prediction' && inWindow(r)),
          records.filter((r) => r.type === 'settlement'),
          market || null
        );
      })
  );
}

module.exports = { register };
