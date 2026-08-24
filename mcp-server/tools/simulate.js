'use strict';

const { z } = require('zod');
const path = require('path');
const store = require('../ledger/store');
const paths = require('../paths');
const { compare, STRATEGIES } = require('../sim/replay');
const { bootstrapComparison } = require('../sim/bootstrap');
const { writeWorkbook } = require('../sim/workbook');
const { account } = require('../sim/accounting');
const { run } = require('../result');

const STRATEGY_NAMES = Object.keys(STRATEGIES);

// Where the workbook goes when nobody says. Beside the repository rather than
// inside it: it is a report, regenerated whole every run, and the repository
// tracks records.
function defaultWorkbook() {
  return process.env.MCP_SIM_WORKBOOK || path.join(paths.ROOT, '..', 'BOT_AI.xlsx');
}

function register(server) {
  server.registerTool(
    'simulate_strategies',
    {
      title: 'Replay the recorded history under different rules',
      description: 'Takes every settled prediction — the same selections, the same prices that '
        + 'were really quoted, the same results — and replays them under alternative staking and '
        + 'filtering rules. Anything that differs between two runs is attributable to the rule '
        + 'and to nothing else. Then bootstraps each one: resampling the bets thousands of times '
        + 'to show the whole range of outcomes it could plausibly have produced, because '
        + 'comparing several rules over a few dozen results is data mining unless the spread is '
        + 'reported beside the total. Read `straddlesZero` before anything else — where it is '
        + 'true, not even the SIGN of that strategy\'s result is established. Writes a workbook '
        + 'and moves no money: nothing here places or suggests placing a bet.',
      inputSchema: {
        strategies: z.array(z.enum(STRATEGY_NAMES)).optional()
          .describe(`Which rules to replay. Defaults to all: ${STRATEGY_NAMES.join(', ')}.`),
        startingBankroll: z.number().positive().optional()
          .describe('Units in the simulated bankroll at the start. Defaults to 100.'),
        iterations: z.number().int().min(100).max(200000).optional()
          .describe('Bootstrap resamples per strategy. Defaults to 10000.'),
        seed: z.number().int().optional()
          .describe('Seed for the resampling, so a run is reproducible. Defaults to 1.'),
        workbook: z.string().optional()
          .describe('Where to write the .xlsx. Defaults to BOT_AI.xlsx beside the repository.'),
        write: z.boolean().optional()
          .describe('Set false to compute without writing the workbook.')
      }
    },
    async ({ strategies, startingBankroll, iterations, seed, workbook, write }) =>
      run('simulate_strategies', async () => {
        const records = store.readAll();
        const comparison = compare(
          records.filter((r) => r.type === 'prediction'),
          records.filter((r) => r.type === 'settlement'),
          { strategies, startingBankroll }
        );

        if (!comparison.settled) {
          throw new Error('no settled predictions to replay: a simulation needs results, and '
            + 'the ledger has none yet');
        }

        const bootstrap = bootstrapComparison(comparison, {
          iterations: iterations || undefined,
          seed: seed === undefined ? 1 : seed
        });

        // The bankroll, kept beside the strategy comparison: one answers "what
        // would other rules have returned", the other "where does the money
        // actually stand". They are different questions and the workbook
        // carries both.
        const accounting = account(
          records.filter((r) => r.type === 'prediction'),
          records.filter((r) => r.type === 'settlement'),
          { openingBalance: startingBankroll || 100 });

        const written = write === false
          ? null
          : writeWorkbook(workbook || defaultWorkbook(), comparison, bootstrap, { accounting });

        return {
          settled: comparison.settled,
          bankroll: {
            opening: accounting.openingBalance,
            closing: accounting.closingBalance,
            resultUnits: accounting.resultUnits,
            maxDrawdown: accounting.maxDrawdown,
            openBets: accounting.openBets,
            openExposure: accounting.openExposure,
            months: accounting.months
          },
          pending: comparison.pending,
          warning: bootstrap.warning,
          // The curves are megabytes and belong in the workbook, not in a tool
          // result an agent has to read past to reach the finding.
          strategies: comparison.results.map((r) => ({
            key: r.key,
            strategy: r.strategy,
            bets: r.bets,
            hitRate: r.hitRate,
            profitUnits: r.profitUnits,
            roi: r.roi,
            maxDrawdown: r.maxDrawdown
          })),
          bootstrap: bootstrap.results.map((r) => ({
            strategy: r.strategy,
            n: r.n,
            observedProfit: r.observedProfit,
            range90: r.p05 === undefined ? null : [r.p05, r.p95],
            probabilityOfLoss: r.probabilityOfLoss,
            straddlesZero: r.straddlesZero,
            note: r.note
          })),
          workbook: written
        };
      })
  );
}

module.exports = { register };
