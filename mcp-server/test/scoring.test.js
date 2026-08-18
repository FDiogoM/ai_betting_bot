'use strict';

const test = require('node:test');
const assert = require('node:assert');

const scoring = require('../ledger/scoring');

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
}

test('brier is the mean squared error of the probabilities', () => {
  // (0.6-1)^2 = 0.16 and (0.3-0)^2 = 0.09, mean 0.125
  close(scoring.brier([{ probability: 0.6, outcome: 1 }, { probability: 0.3, outcome: 0 }]),
    0.125, 'brier');
});

test('a perfect forecast scores zero and a reversed one scores one', () => {
  close(scoring.brier([{ probability: 1, outcome: 1 }]), 0, 'perfect');
  close(scoring.brier([{ probability: 0, outcome: 1 }]), 1, 'reversed');
});

test('log loss punishes a confident miss harder than brier does', () => {
  close(scoring.logLoss([{ probability: 0.5, outcome: 1 }]), Math.LN2, 'coin flip');

  const confidentMiss = scoring.logLoss([{ probability: 0.01, outcome: 1 }]);
  const unsureMiss = scoring.logLoss([{ probability: 0.4, outcome: 1 }]);
  assert.ok(confidentMiss > unsureMiss * 3, 'confidence must cost more when wrong');
});

test('log loss does not return infinity on a certainty that failed', () => {
  const loss = scoring.logLoss([{ probability: 0, outcome: 1 }]);
  assert.ok(Number.isFinite(loss), 'clamping must keep the score finite');
  assert.ok(loss > 30, 'but it must still be a very large number');
});

test('an empty sample has no score rather than a misleading zero', () => {
  assert.strictEqual(scoring.brier([]), null);
  assert.strictEqual(scoring.logLoss([]), null);
});

test('pnl sums the returned units', () => {
  const result = scoring.pnl([{ returnUnits: 0.95 }, { returnUnits: -1 }, { returnUnits: 0 }]);

  close(result.units, -0.05, 'units');
  assert.strictEqual(result.n, 3);
});

test('the default bands resolve the high range, where short prices live', () => {
  const bands = scoring.DEFAULT_BANDS;

  // Contiguous and covering [0, 1]: a probability must land in exactly one band.
  assert.strictEqual(bands[0][0], 0);
  assert.strictEqual(bands[bands.length - 1][1], 1);
  for (let i = 1; i < bands.length; i += 1) {
    assert.strictEqual(bands[i][0], bands[i - 1][1], `band ${i} must start where ${i - 1} ends`);
  }

  // 0.72 and 0.97 must not share a band: their break-even prices are 1.39 and
  // 1.03, so pooling them hides the error that matters at short odds.
  const bandOf = (p) => bands.findIndex(([from, to]) => p >= from && (to === 1 ? p <= to : p < to));
  assert.notStrictEqual(bandOf(0.72), bandOf(0.97), '0.72 and 0.97 must fall in different bands');
  assert.notStrictEqual(bandOf(0.85), bandOf(0.92), '0.85 and 0.92 must fall in different bands');

  // A stated certainty still lands somewhere rather than being dropped.
  assert.ok(bandOf(1) >= 0, 'a probability of exactly 1 must fall in a band');
});

test('calibration buckets by probability band', () => {
  const rows = [
    { probability: 0.52, outcome: 1 }, { probability: 0.55, outcome: 0 },
    { probability: 0.58, outcome: 1 }, { probability: 0.71, outcome: 1 }
  ];

  const bands = scoring.calibration(rows, [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8]]);

  const first = bands.find((b) => b.from === 0.5);
  assert.strictEqual(first.n, 3);
  close(first.hitRate, 2 / 3, 'hit rate in the 50-60 band');
  const empty = bands.find((b) => b.from === 0.6);
  assert.strictEqual(empty.n, 0);
  assert.strictEqual(empty.hitRate, null, 'an empty band has no hit rate');
});

// The agent and the baseline are scored over exactly the same settled
// predictions. Scoring them over different sets would make the comparison
// meaningless, which is the one comparison this system exists to make.
test('summarise scores agent and baseline over the same predictions', () => {
  const predictions = [
    { type: 'prediction', id: 'p1', market: { family: 'corners' },
      agent: { probability: 0.6 }, baseline: { probability: 0.55 } },
    { type: 'prediction', id: 'p2', market: { family: 'corners' },
      agent: { probability: 0.3 }, baseline: { probability: 0.4 } },
    { type: 'prediction', id: 'p3', market: { family: 'corners' },
      agent: { probability: 0.8 }, baseline: { probability: 0.7 } }
  ];
  const settlements = [
    { type: 'settlement', predictionId: 'p1', outcome: 'win', returnUnits: 0.9 },
    { type: 'settlement', predictionId: 'p2', outcome: 'loss', returnUnits: -1 },
    { type: 'settlement', predictionId: 'p3', outcome: 'void', returnUnits: 0 }
  ];

  const s = scoring.summarise(predictions, settlements);

  assert.strictEqual(s.n, 2, 'a void carries no information and cannot be scored');
  assert.strictEqual(s.voided, 1);
  close(s.agent.brier, ((0.6 - 1) ** 2 + (0.3 - 0) ** 2) / 2, 'agent brier');
  close(s.baseline.brier, ((0.55 - 1) ** 2 + (0.4 - 0) ** 2) / 2, 'baseline brier');
  close(s.pnl.units, -0.1, 'pnl');
});

test('pending predictions are counted, not scored', () => {
  const s = scoring.summarise(
    [{ type: 'prediction', id: 'p1', market: { family: 'corners' },
      agent: { probability: 0.6 }, baseline: { probability: 0.55 } }],
    []
  );

  assert.strictEqual(s.pending, 1);
  assert.strictEqual(s.n, 0);
  assert.strictEqual(s.agent.brier, null);
});

// Below this many settled predictions, a Brier difference is noise. Reporting
// it as a number invites reading noise as skill.
test('a sample below the floor is reported as insufficient', () => {
  const predictions = [];
  const settlements = [];
  for (let i = 0; i < 5; i += 1) {
    predictions.push({ type: 'prediction', id: `p${i}`, market: { family: 'corners' },
      agent: { probability: 0.6 }, baseline: { probability: 0.55 } });
    settlements.push({ type: 'settlement', predictionId: `p${i}`, outcome: 'win', returnUnits: 0.9 });
  }

  const s = scoring.summarise(predictions, settlements);

  assert.strictEqual(s.verdict, 'insufficient');
  assert.ok(s.agent.brier !== null, 'the numbers are still reported');
  assert.match(s.verdictNote, new RegExp(String(scoring.INSUFFICIENT_N)));
});

test('a sufficient sample gets a verdict on who scored better', () => {
  const predictions = [];
  const settlements = [];
  for (let i = 0; i < 40; i += 1) {
    // The agent is right every time, the baseline is closer to a coin flip.
    predictions.push({ type: 'prediction', id: `p${i}`, market: { family: 'corners' },
      agent: { probability: 0.9 }, baseline: { probability: 0.55 } });
    settlements.push({ type: 'settlement', predictionId: `p${i}`, outcome: 'win', returnUnits: 0.9 });
  }

  const s = scoring.summarise(predictions, settlements);

  assert.strictEqual(s.verdict, 'agent-better');
  assert.ok(s.agent.brier < s.baseline.brier);
});
