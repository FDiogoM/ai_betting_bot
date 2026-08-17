'use strict';

const { z } = require('zod');
const store = require('../ledger/store');
const { predictionSchema, predictionId, DIVERGENCE_THRESHOLD } = require('../ledger/schema');
const { evaluate } = require('../baselines/value');
const { run } = require('../result');

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
}

module.exports = { register };
