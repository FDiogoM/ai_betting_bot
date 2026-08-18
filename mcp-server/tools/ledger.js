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
const markets = require('../markets');
const scoring = require('../ledger/scoring');
const fixtureBaseline = require('../baselines/fixtureBaseline');
const marketView = require('../aggregate/marketView');

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
  goals: async (fixture) => {
    const home = goalsAggregate.goalsOf(fixture.goals ? fixture.goals.home : null);
    const away = goalsAggregate.goalsOf(fixture.goals ? fixture.goals.away : null);
    return home === null || away === null ? null : home + away;
  }
};

// Settles one prediction, or returns null to leave it pending. Never infers a
// result: a finished match whose count is missing is void, not guessed.
async function settle(prediction) {
  const found = await provider.fetch(provider.ENDPOINTS.FIXTURES,
    { id: prediction.fixture.id }, cache.TTL.LIVE);
  if (!found.length) throw new Error(`fixture ${prediction.fixture.id} was not found`);

  const fixture = found[0];
  const status = fixture.fixture.status.short;
  const spec = markets.get(prediction.market.family);
  const observe = OBSERVERS[spec.family];
  if (!observe) throw new Error(`no settlement rule for market family "${spec.family}"`);

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

  const total = await observe(fixture);
  if (total === null) return voided;

  const cleared = total > prediction.market.line;
  const won = prediction.market.selection === 'over' ? cleared : !cleared;
  const stake = prediction.agent.stake;

  return {
    ...settlement,
    observed: { [spec.observedKey]: total },
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
            .describe(`Market family: ${markets.FAMILY_NAMES.join(' or ')}.`),
          selection: z.enum(['over', 'under']),
          line: z.number().describe('Half-integer market line, e.g. 9.5 for corners, 2.5 for goals.')
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
        const baseline = await fixtureBaseline.baselineFor(
          market.family, fixtureId, matchCount, [market.line], false);

        const priced = fixtureBaseline.lineOf(baseline, market.line);
        const view = await marketView.marketViewFor(market.family, fixtureId, false);
        const selection = marketView.selectionView(view, market.line, market.selection);

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
            probability: market.selection === 'over'
              ? priced.overProbability : priced.underProbability,
            // Side-specific, like the probability beside it: the empirical rate
            // for an under is how often the total came in UNDER the line.
            empiricalRate: market.selection === 'over'
              ? priced.empiricalOverRate : 1 - priced.empiricalOverRate,
            empiricalSample: priced.empiricalSample,
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
