'use strict';

const { impliedProbability } = require('./devig');

// Pure. Exists because this is exactly where mental arithmetic slips, and a
// sign error here corrupts every row of the ledger downstream.
function evaluate(probability, decimalOdd, stakeUnits = 1) {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) {
    throw new Error(`probability must be between 0 and 1 exclusive, got ${probability}`);
  }
  if (!Number.isFinite(stakeUnits) || stakeUnits <= 0 || stakeUnits > 1) {
    throw new Error(`stake must be above 0 and at most 1 unit, got ${stakeUnits}`);
  }

  const implied = impliedProbability(decimalOdd);
  const edge = probability - implied;
  const expectedValue = probability * (decimalOdd - 1) - (1 - probability);

  const round = (n) => Math.round(n * 1e6) / 1e6;

  return {
    probability,
    decimalOdd,
    impliedProbability: round(implied),
    edge: round(edge),
    expectedValue: round(expectedValue),
    expectedValueOnStake: round(expectedValue * stakeUnits),
    stakeUnits
  };
}

module.exports = { evaluate };
