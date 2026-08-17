'use strict';

// Pure: no imports, no clock, no filesystem.

// Below this many settled predictions, a difference in Brier score is noise.
// The numbers are still reported; the verdict is withheld.
const INSUFFICIENT_N = 30;

const DEFAULT_BANDS = [[0, 0.3], [0.3, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 1]];

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
    scored.push({ agent: p.agent.probability, baseline: p.baseline.probability, outcome });
  }

  const agentRows = scored.map((r) => ({ probability: r.agent, outcome: r.outcome }));
  const baselineRows = scored.map((r) => ({ probability: r.baseline, outcome: r.outcome }));

  const agent = { brier: brier(agentRows), logLoss: logLoss(agentRows), calibration: calibration(agentRows) };
  const baseline = { brier: brier(baselineRows), logLoss: logLoss(baselineRows) };

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
    pnl: pnl(settled.filter((s) => typeof s.returnUnits === 'number')),
    verdict,
    verdictNote
  };
}

module.exports = { brier, logLoss, calibration, pnl, summarise, INSUFFICIENT_N, DEFAULT_BANDS };
