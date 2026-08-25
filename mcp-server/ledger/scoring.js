'use strict';

// Pure in the way that matters: no clock, no filesystem, no network. The one
// import is the divergence threshold, which judgmentSize measures against and
// which must be the same number the schema enforces — two copies of it would
// drift, and the whole point of that measurement is to watch the threshold's
// effect on behaviour.
const { DIVERGENCE_THRESHOLD } = require('./schema');
const clvScoring = require('../baselines/clv');

// Below this many settled predictions, a difference in Brier score is noise.
// The numbers are still reported; the verdict is withheld.
const INSUFFICIENT_N = 30;

// Finer where the decisions are made. A single [0.7, 1] band pooled a 72%
// forecast with a 97% one, which is exactly the range a high-hit-rate strategy
// lives in: at 0.95 the break-even price is 1.053, so being 3 points
// over-confident there is the difference between winning and losing, and a
// pooled band cannot show it. Below 0.3 the bands stay coarse — nothing that
// clears the edge filter is forecast that low, so splitting it would only
// produce empty rows.
const DEFAULT_BANDS = [
  [0, 0.3], [0.3, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7],
  [0.7, 0.8], [0.8, 0.9], [0.9, 0.95], [0.95, 1]
];

function round(n, places = 4) {
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
}

function brier(rows) {
  if (!rows.length) return null;
  return rows.reduce((acc, r) => acc + (r.probability - r.outcome) ** 2, 0) / rows.length;
}

function logLoss(rows) {
  if (!rows.length) return null;
  // Clamp: a stated certainty that failed would otherwise score infinity and
  // destroy every aggregate it touches.
  const EPS = 1e-15;
  const total = rows.reduce((acc, r) => {
    const p = Math.min(1 - EPS, Math.max(EPS, r.probability));
    return acc - (r.outcome * Math.log(p) + (1 - r.outcome) * Math.log(1 - p));
  }, 0);
  return total / rows.length;
}

function calibration(rows, bands = DEFAULT_BANDS) {
  return bands.map(([from, to]) => {
    // Half-open bands, with the last one closed so a probability of exactly 1
    // is not dropped.
    const inBand = rows.filter((r) => r.probability >= from
      && (to === 1 ? r.probability <= to : r.probability < to));
    return {
      from,
      to,
      n: inBand.length,
      meanProbability: inBand.length
        ? inBand.reduce((a, r) => a + r.probability, 0) / inBand.length : null,
      hitRate: inBand.length
        ? inBand.filter((r) => r.outcome === 1).length / inBand.length : null
    };
  });
}

/**
 * The weight on the MODEL in `w × baseline + (1 − w) × market` that would have
 * scored best over the settled history, found by grid search.
 *
 * This exists because the shrinkage was already happening — by hand, at an
 * invented weight. On 2026-08-18 seven predictions were recorded at an average
 * of 0.011 below their baseline, every one inside the divergence threshold that
 * would have required an explanation. That is not judgment, it is a rule; and a
 * rule belongs in code with a number that came from somewhere.
 *
 * Fitted IN SAMPLE: the weight is chosen on the same rows it is then scored on,
 * so its Brier flatters it and the figure is a description of the past, not a
 * prediction. It is reported so the size and direction can be read — a weight
 * near 0 says the market knows better, near 1 says the model does — and it is
 * deliberately NOT applied anywhere. Applying it would need out-of-sample
 * validation this ledger cannot yet support.
 */
function fitBlendWeight(rows) {
  if (rows.length < 2) {
    return { weight: null, brier: null, n: rows.length, fitted: false,
      note: 'not enough settled predictions carrying a market consensus to fit a weight' };
  }

  let best = { weight: 0, brier: Infinity };
  for (let step = 0; step <= 100; step += 1) {
    const w = step / 100;
    const scored = rows.map((r) => ({
      probability: w * r.baseline + (1 - w) * r.market,
      outcome: r.outcome
    }));
    const score = brier(scored);
    if (score < best.brier) best = { weight: w, brier: score };
  }

  const enough = rows.length >= INSUFFICIENT_N;
  return {
    weight: best.weight,
    brier: round(best.brier),
    n: rows.length,
    fitted: true,
    note: enough
      ? 'fitted in sample on these rows, so the Brier is optimistic; the weight itself is the '
        + 'reading — near 0 the market knows better, near 1 the model does'
      : `fitted on ${rows.length} rows, far below ${INSUFFICIENT_N}: the weight is arithmetic on `
        + 'too little data and should not be acted on'
  };
}

/**
 * How much judgment is actually being exercised — measured over every
 * prediction, settled or not, because it is a property of the behaviour rather
 * than of the outcomes.
 *
 * This is the diagnostic that was missing. Agent and baseline are scored
 * against each other, but if the agent never moves far from the baseline the
 * two Brier scores converge and the comparison can never answer its own
 * question, however long it runs. Worse, the failure is silent: everything
 * looks healthy while measuring nothing.
 *
 * `insideThreshold` is the tell. Divergences clustering just under the line
 * that would demand a written reason is a sign the threshold is shaping the
 * answer rather than the data is.
 */
function judgmentSize(predictions, threshold = DIVERGENCE_THRESHOLD) {
  const gaps = predictions
    .filter((p) => p.agent && p.baseline && typeof p.agent.probability === 'number')
    .map((p) => p.agent.probability - p.baseline.probability);

  if (!gaps.length) {
    return { n: 0, meanDivergence: null, meanAbsDivergence: null, maxAbsDivergence: null,
      insideThreshold: 0, withReason: 0, note: 'no predictions to measure' };
  }

  const abs = gaps.map(Math.abs);
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const inside = abs.filter((g) => g <= threshold).length;
  const maxAbs = Math.max(...abs);

  // The median, not the mean, decides what the TYPICAL prediction looks like.
  // Two considered disagreements among seven rubber stamps pull the mean above
  // the threshold and make a collapsed run read as healthy — which is exactly
  // what the first nine predictions did.
  const sorted = [...abs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianAbs = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  let note = 'the agent is taking positions the baseline does not';
  if (maxAbs <= threshold) {
    note = `every divergence sits inside the ${threshold} threshold, so no prediction has yet `
      + 'required an explanation. Agent and baseline are forecasting nearly the same thing, and '
      + 'no amount of further data will separate them while that holds';
  } else if (medianAbs <= threshold) {
    note = `the median divergence is ${round(medianAbs)}, inside the ${threshold} threshold: the `
      + `typical prediction restates the baseline (${inside} of ${gaps.length} do), and the few `
      + 'that do not are carrying the whole comparison. A constant shrinkage belongs in the '
      + 'model as a weight rather than in a per-prediction decision';
  }

  return {
    n: gaps.length,
    meanDivergence: round(mean(gaps)),
    meanAbsDivergence: round(mean(abs)),
    medianAbsDivergence: round(medianAbs),
    maxAbsDivergence: round(maxAbs),
    insideThreshold: inside,
    withReason: predictions.filter((p) => p.agent && p.agent.divergenceReason).length,
    note
  };
}

function pnl(rows) {
  return {
    units: rows.reduce((acc, r) => acc + r.returnUnits, 0),
    n: rows.length
  };
}

function summarise(predictions, settlements, market = null) {
  const byId = new Map(settlements.map((s) => [s.predictionId, s]));
  const considered = market
    ? predictions.filter((p) => p.market && p.market.family === market)
    : predictions;

  const scored = [];
  const settled = [];
  let voided = 0;
  let pending = 0;

  for (const p of considered) {
    const s = byId.get(p.id);
    if (!s) {
      pending += 1;
      continue;
    }
    settled.push(s);
    // A void carries no information about who forecast better.
    if (s.outcome === 'void') {
      voided += 1;
      continue;
    }
    const outcome = s.outcome === 'win' ? 1 : 0;
    scored.push({
      agent: p.agent.probability,
      baseline: p.baseline.probability,
      // The market's own de-vigged forecast for this exact selection, which the
      // ledger has recorded from the first prediction and never scored. It is
      // the sharpest competitor there is: scoring against the baseline alone
      // flatters everyone, because beating a venue-split Poisson is easy and
      // beating the market is the thing that pays.
      market: p.marketView && typeof p.marketView.consensusProbability === 'number'
        ? p.marketView.consensusProbability
        : null,
      outcome
    });
  }

  const rowsOf = (pick) => scored.map((r) => ({ probability: pick(r), outcome: r.outcome }));
  const agentRows = rowsOf((r) => r.agent);
  const baselineRows = rowsOf((r) => r.baseline);

  const agent = { brier: brier(agentRows), logLoss: logLoss(agentRows), calibration: calibration(agentRows) };
  const baseline = { brier: brier(baselineRows), logLoss: logLoss(baselineRows) };

  // Only the rows where a consensus existed. A line quoted on one side has no
  // de-vigged probability, so market and blend are scored over a subset and
  // report their own n rather than borrowing the headline one.
  const withMarket = scored.filter((r) => r.market !== null);
  const marketRows = withMarket.map((r) => ({ probability: r.market, outcome: r.outcome }));
  const marketConsensus = {
    brier: brier(marketRows),
    logLoss: logLoss(marketRows),
    n: withMarket.length
  };

  const blend = fitBlendWeight(withMarket);

  let verdict = 'insufficient';
  let verdictNote = `fewer than ${INSUFFICIENT_N} settled predictions: the numbers are reported, `
    + 'but a difference this small is noise, not skill';
  if (scored.length >= INSUFFICIENT_N) {
    if (agent.brier < baseline.brier) {
      verdict = 'agent-better';
      verdictNote = 'the agent\'s judgment scored better than the baseline over this sample';
    } else if (agent.brier > baseline.brier) {
      verdict = 'baseline-better';
      verdictNote = 'the baseline scored better than the agent: the judgment is costing accuracy';
    } else {
      verdict = 'tied';
      verdictNote = 'agent and baseline scored identically';
    }
  }

  return {
    market,
    n: scored.length,
    pending,
    voided,
    agent,
    baseline,
    marketConsensus,
    blend,
    // Closing line value, over the same settled bets. It is reported without an
    // `insufficient` floor, unlike the Brier verdict, and deliberately: a
    // settled bet yields one bit and needs hundreds to separate skill from
    // luck, while CLV yields a continuous measurement and says something real
    // after a few dozen. It is the fastest honest signal this ledger has.
    clv: clvScoring.summariseClv(settled.map((s) => s.closingLineValue)),
    judgment: judgmentSize(considered),
    pnl: pnl(settled.filter((s) => typeof s.returnUnits === 'number')),
    verdict,
    verdictNote
  };
}

module.exports = {
  brier, logLoss, calibration, pnl, summarise, fitBlendWeight, judgmentSize,
  INSUFFICIENT_N, DEFAULT_BANDS
};
