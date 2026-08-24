'use strict';

const { z } = require('zod');
const markets = require('../markets');

// Beyond this distance from the baseline, the agent must say why. Inside it,
// the difference is not a disagreement worth explaining.
const DIVERGENCE_THRESHOLD = 0.03;

const halfLine = z.number().refine((n) => (n * 2) % 2 === 1,
  { message: 'line must be a half-integer such as 9.5; a whole line can push' });

// One variant per market family, discriminated on the family name. Every
// family today is a totals market — an over/under on a count — so they share
// this shape. The union is the point: a family with a different shape (1X2 has
// three selections and no line) arrives as a second builder and a second
// entry, and every already-recorded prediction still validates unchanged.
const totalsMarket = (family) => z.object({
  family: z.literal(family),
  selection: z.enum(['over', 'under']),
  line: halfLine
});

// The second variant, and the reason the union was built rather than a flat
// object. A market with named selections has no line at all — writing one would
// be recording a number the bet does not have — and its selections are declared
// by the family rather than shared, so a `home` on a 1X2 and a `yes` on both
// teams to score are validated against different enums.
//
// Every prediction recorded before this variant existed still validates
// unchanged, which is the whole point of discriminating on the family name.
const outcomeMarket = (family) => z.object({
  family: z.literal(family),
  selection: z.enum(markets.get(family).selections)
}).strict();

const marketSchema = z.discriminatedUnion('family', markets.FAMILY_NAMES.map(
  (name) => (markets.get(name).shape === 'totals' ? totalsMarket(name) : outcomeMarket(name))));

const predictionSchema = z.object({
  fixture: z.object({
    id: z.number().int().positive(),
    league: z.string().nullable().optional(),
    home: z.string(),
    away: z.string(),
    kickoff: z.string()
  }),
  market: marketSchema,
  baseline: z.object({
    probability: z.number().gt(0).lt(1),
    empiricalRate: z.number().min(0).max(1),
    empiricalSample: z.number().int().nonnegative(),
    lambda: z.number().positive(),
    dispersionRatio: z.number().nullable(),
    // Which underlying quantity the rate was estimated from — "shots" or
    // "goals" today. Optional so every prediction recorded before the signal
    // existed still validates; the ledger is append-only and a schema that
    // rejected its own history would be unreadable. Without it, a later
    // comparison of the two models has to recover the answer by grepping the
    // caveats, which is exactly the kind of guessing this system avoids.
    signal: z.string().optional(),
    caveats: z.array(z.string())
  }),
  marketView: z.object({
    consensusProbability: z.number().gt(0).lt(1).nullable(),
    bestPrice: z.number().gt(1),
    bookmaker: z.string(),
    overround: z.number().nullable()
  }),
  agent: z.object({
    // Required, always. A pick without a number cannot be scored, and an
    // unscorable pick is what this whole design exists to prevent.
    probability: z.number().gt(0).lt(1),
    confidence: z.enum(['low', 'medium', 'high']),
    divergenceReason: z.string().min(1).optional(),
    stake: z.number().gt(0).max(1)
  })
}).superRefine((value, ctx) => {
  const gap = Math.abs(value.agent.probability - value.baseline.probability);
  if (gap > DIVERGENCE_THRESHOLD && !value.agent.divergenceReason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['agent', 'divergenceReason'],
      message: `agent.probability differs from the baseline by ${gap.toFixed(3)}, above the `
        + `${DIVERGENCE_THRESHOLD} threshold: divergenceReason is required to record it`
    });
  }
});

// Stable and derived from the selection, so recording the same bet twice is
// detectable without a separate index.
function predictionId(value) {
  const day = value.fixture.kickoff.slice(0, 10);
  // The line is part of the identity only where the bet has one. Appending an
  // absent line gave ids like "...-matchResult-homeundefined", which would have
  // been stable and unique and completely unreadable.
  const line = value.market.line === undefined ? '' : value.market.line;
  return `${day}-${value.fixture.id}-${value.market.family}-`
    + `${value.market.selection}${line}`;
}

module.exports = { predictionSchema, predictionId, marketSchema, DIVERGENCE_THRESHOLD };
