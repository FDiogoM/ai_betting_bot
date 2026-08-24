'use strict';

// Pure: no imports, no clock, no filesystem, no network.
//
// The ledger is already a simulation. No money has moved, the prices are the
// ones that were really quoted, and the settlements are real results — so the
// recorded P&L is what one particular strategy would have returned. What it
// cannot tell you is whether a different strategy would have done better, and
// that is the only question worth asking of a record this small.
//
// Replay answers it by holding everything fixed except the rule: same
// selections, same prices, same outcomes, different staking or different
// grouping. Any difference in the result is then attributable to the rule and
// to nothing else.
//
// What it CANNOT do is invent bets that were never recorded. A rule that would
// have backed unders says nothing here if no under was ever written down. The
// replay is of your own notebook, not of the market.

const VOID = 'void';

function round(n, places = 4) {
  return typeof n === 'number' ? Math.round(n * 10 ** places) / 10 ** places : n;
}

/**
 * Pairs each prediction with its settlement, in the order they were recorded.
 * Predictions with no settlement, and voids, are carried through marked rather
 * than dropped: a strategy that would have staked on them still spent the
 * opportunity, and a void returns the stake rather than winning it.
 */
function timeline(predictions, settlements) {
  const byId = new Map(settlements.map((s) => [s.predictionId, s]));
  return predictions
    .slice()
    .sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)))
    .map((p) => {
      const s = byId.get(p.id);
      return {
        prediction: p,
        settled: Boolean(s),
        voided: Boolean(s) && s.outcome === VOID,
        won: Boolean(s) && s.outcome === 'win'
      };
    });
}

// The strategies. Each takes the recorded prediction and returns a stake in
// units, or 0 to pass. They see only what was known BEFORE the match — the
// baseline, the market, the agent's own number, the price. Nothing may read the
// settlement, or the replay becomes a fortune teller.
const STRATEGIES = {
  recorded: {
    label: 'as recorded',
    note: 'exactly what was staked at the time — the control',
    stake: (p) => p.agent.stake
  },
  flat: {
    label: 'flat 1 unit',
    note: 'every selection the same size, the simplest possible discipline',
    stake: () => 1
  },
  flatHalf: {
    label: 'flat 0.5 units',
    note: 'the same, at half size',
    stake: () => 0.5
  },
  quarterKelly: {
    label: 'quarter Kelly',
    note: 'sized on the agent\'s own probability against the price taken, capped at 1 unit',
    stake: (p) => {
      const net = p.marketView.bestPrice - 1;
      const kelly = (p.agent.probability * net - (1 - p.agent.probability)) / net;
      if (kelly <= 0) return 0;
      // One unit is 1% of bankroll, matching config.stakeFraction.
      return Math.min(1, kelly / 4 / 0.01);
    }
  },
  edgeFilter5: {
    label: 'flat 1u, edge >= 5%',
    note: 'the same flat stake, but only on selections whose recorded edge cleared 0.05',
    stake: (p) => (p.edge >= 0.05 ? 1 : 0)
  },
  followBaseline: {
    label: 'flat 1u on the baseline\'s number',
    note: 'stakes when the BASELINE, not the agent, showed an edge — what deferring would have paid',
    stake: (p) => (p.baseline.probability - 1 / p.marketView.bestPrice >= 0.03 ? 1 : 0)
  },
  goalsOnly: {
    label: 'flat 1u, goals only',
    note: 'one family at a time, because the two are not comparable',
    stake: (p) => (p.market.family === 'goals' ? 1 : 0)
  },
  cornersOnly: {
    label: 'flat 1u, corners only',
    note: 'the other half of the same question',
    stake: (p) => (p.market.family === 'corners' ? 1 : 0)
  }
};

/**
 * Runs one strategy across the recorded history.
 *
 * Returns the bankroll curve as well as the totals: the endpoint alone hides
 * whether the money arrived steadily or survived a drawdown that would have
 * ended the experiment in practice.
 */
function runStrategy(rows, strategy, options = {}) {
  const { startingBankroll = 100 } = options;
  const curve = [];
  let bankroll = startingBankroll;
  let staked = 0;
  let returned = 0;
  let bets = 0;
  let wins = 0;
  let voids = 0;
  let peak = startingBankroll;
  let maxDrawdown = 0;

  for (const row of rows) {
    if (!row.settled) continue;                 // nothing to resolve yet
    const stake = strategy.stake(row.prediction);
    if (!stake || stake <= 0) continue;

    bets += 1;
    staked += stake;

    let result = 0;
    if (row.voided) {
      voids += 1;                               // stake back, no information
    } else if (row.won) {
      wins += 1;
      result = stake * (row.prediction.marketView.bestPrice - 1);
    } else {
      result = -stake;
    }

    returned += result;
    bankroll += result;
    peak = Math.max(peak, bankroll);
    maxDrawdown = Math.max(maxDrawdown, peak - bankroll);

    curve.push({
      at: row.prediction.recordedAt,
      id: row.prediction.id,
      family: row.prediction.market.family,
      stake: round(stake, 3),
      price: row.prediction.marketView.bestPrice,
      outcome: row.voided ? 'void' : (row.won ? 'win' : 'loss'),
      result: round(result, 3),
      bankroll: round(bankroll, 3)
    });
  }

  const scored = bets - voids;
  return {
    strategy: strategy.label,
    note: strategy.note,
    bets,
    voids,
    wins,
    // Reported because it is asked for, immediately beside the thing that makes
    // it meaningless on its own: with varying prices, a hit rate is not a score.
    hitRate: scored ? round(wins / scored) : null,
    staked: round(staked, 3),
    profitUnits: round(returned, 3),
    roi: staked ? round(returned / staked) : null,
    finalBankroll: round(bankroll, 3),
    maxDrawdown: round(maxDrawdown, 3),
    curve
  };
}

/**
 * Every strategy over the same history, so the comparison is like for like.
 * `names` restricts the set; omitted, all of them run.
 */
function compare(predictions, settlements, options = {}) {
  const rows = timeline(predictions, settlements);
  const names = options.strategies || Object.keys(STRATEGIES);
  return {
    settled: rows.filter((r) => r.settled).length,
    pending: rows.filter((r) => !r.settled).length,
    startingBankroll: options.startingBankroll || 100,
    results: names
      .filter((n) => STRATEGIES[n])
      .map((n) => ({ key: n, ...runStrategy(rows, STRATEGIES[n], options) }))
  };
}

module.exports = { timeline, runStrategy, compare, STRATEGIES };
