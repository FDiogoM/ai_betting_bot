'use strict';

const { z } = require('zod');
const store = require('../ledger/store');
const { predictionSchema, predictionId, DIVERGENCE_THRESHOLD } = require('../ledger/schema');
const { evaluate } = require('../baselines/value');
const { run } = require('../result');
const provider = require('../provider/apiFootball');
const cache = require('../cache');
const aggregate = require('../aggregate/cornerProfile');
const scoring = require('../ledger/scoring');

const VOID_STATUSES = new Set(['ABD', 'CANC', 'PST', 'AWD', 'WO']);

// Settles one prediction, or returns null to leave it pending. Never infers a
// result: a finished match whose corner statistic is missing is void, because
// treating a missing number as zero would grade an under as a win.
async function settle(prediction) {
  const found = await provider.fetch(provider.ENDPOINTS.FIXTURES,
    { id: prediction.fixture.id }, cache.TTL.LIVE);
  if (!found.length) throw new Error(`fixture ${prediction.fixture.id} was not found`);

  const fixture = found[0];
  const status = fixture.fixture.status.short;

  const settlement = {
    type: 'settlement',
    predictionId: prediction.id,
    settledAt: new Date().toISOString(),
    fixtureStatus: status
  };

  if (VOID_STATUSES.has(status)) {
    return { ...settlement, observed: { totalCorners: null }, outcome: 'void', returnUnits: 0 };
  }
  if (!provider.isFinished(fixture)) return null;

  const entries = await aggregate.fetchStatistics(fixture.fixture.id, false, cache.TTL.PERMANENT);
  const home = aggregate.cornerValue(entries, fixture.teams.home.id);
  const away = aggregate.cornerValue(entries, fixture.teams.away.id);
  if (home === null || away === null) {
    return { ...settlement, observed: { totalCorners: null }, outcome: 'void', returnUnits: 0 };
  }

  const total = home + away;
  const cleared = total > prediction.market.line;
  const won = prediction.market.selection === 'over' ? cleared : !cleared;
  const stake = prediction.agent.stake;

  return {
    ...settlement,
    observed: { totalCorners: total },
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
      description: 'Writes one prediction to the append-only ledger. Your own probability is '
        + 'required, and if it differs from the baseline by more than '
        + `${DIVERGENCE_THRESHOLD} you must supply divergenceReason — the write is refused `
        + 'otherwise. Edge and expected value are computed here, not by you.',
      // Cross-field rules (the divergence requirement) cannot live in this
      // per-key map, so the full object is validated inside the handler and a
      // failure becomes an error result via run().
      inputSchema: {
        fixture: z.object({
          id: z.number().int().positive(),
          league: z.string().nullable().optional(),
          home: z.string(),
          away: z.string(),
          kickoff: z.string().describe('ISO kickoff time.')
        }),
        market: z.object({
          family: z.literal('corners'),
          selection: z.enum(['over', 'under']),
          line: z.number().describe('Half-integer market line, e.g. 9.5.')
        }),
        baseline: z.object({
          probability: z.number(),
          empiricalRate: z.number(),
          empiricalSample: z.number().int(),
          lambda: z.number(),
          dispersionRatio: z.number().nullable(),
          caveats: z.array(z.string())
        }).describe('Copy this from get_corner_baseline, for the line you are backing.'),
        marketView: z.object({
          consensusProbability: z.number().nullable(),
          bestPrice: z.number(),
          bookmaker: z.string(),
          overround: z.number().nullable()
        }).describe('Copy this from get_market_probabilities.'),
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
    async (input) =>
      run('record_prediction', async () => {
        const value = predictionSchema.parse(input);
        const id = predictionId(value);

        // Append-only means a duplicate cannot be corrected later, so it is
        // refused now.
        if (store.readAll().some((r) => r.type === 'prediction' && r.id === id)) {
          throw new Error(`${id} was already recorded; the ledger is append-only`);
        }

        const priced = evaluate(value.agent.probability, value.marketView.bestPrice, value.agent.stake);
        const record = {
          type: 'prediction',
          id,
          recordedAt: new Date().toISOString(),
          ...value,
          edge: priced.edge,
          expectedValue: priced.expectedValue
        };

        store.append(record);
        return { id, edge: record.edge, expectedValue: record.expectedValue };
      })
  );

  server.registerTool(
    'grade_pending_predictions',
    {
      title: 'Grade every prediction whose match has finished',
      description: 'Settles all outstanding predictions, not just yesterday\'s, so a missed run '
        + 'costs a day of picks rather than the record. Idempotent: a prediction that already '
        + 'carries a settlement is skipped. A finished match with no corner statistic is voided, '
        + 'never guessed.',
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
        market: z.string().optional().describe('Restrict to one market family, e.g. "corners".'),
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
