'use strict';

// Pure: no imports, no clock, no filesystem.
//
// A multiple is priced by multiplication, and so is everything else about it.
// The edges compound, which is the case for them; the bookmaker's margin
// compounds, which is the case against; and any error in the probabilities
// compounds hardest of all, which is why the singles comparison is returned
// beside every answer rather than left for the reader to work out.

const { impliedProbability } = require('./devig');

function round(n, places = 6) {
  return typeof n === 'number' ? Math.round(n * 10 ** places) / 10 ** places : n;
}

function assertLeg(leg, index) {
  if (!leg || typeof leg !== 'object') throw new Error(`leg ${index} is not an object`);
  if (!Number.isFinite(leg.probability) || leg.probability <= 0 || leg.probability >= 1) {
    throw new Error(`leg ${index}: probability must be between 0 and 1 exclusive, `
      + `got ${leg.probability}`);
  }
  if (!Number.isFinite(leg.decimalOdd) || leg.decimalOdd <= 1) {
    throw new Error(`leg ${index}: decimal odd must be above 1, got ${leg.decimalOdd}`);
  }
}

/**
 * Expected value per unit staked, and the chance of losing that unit.
 *
 * For a multiple these come apart in a way they never do for a single: the
 * expected value can be strongly positive while the bet loses four times in
 * five. Both are returned because reporting only the first is how a multiple
 * gets sold.
 */
function outcome(probability, decimalOdd) {
  return {
    expectedValue: round(probability * (decimalOdd - 1) - (1 - probability)),
    probabilityOfLosing: round(1 - probability)
  };
}

/**
 * Evaluates a combination.
 *
 * legs: [{ probability, decimalOdd, overround?, label? }]
 *   `probability` is YOUR probability for that selection, `decimalOdd` the
 *   price available on it alone.
 *
 * options.jointProbability
 *   Supply this for legs on the SAME match, where multiplying is wrong. From
 *   correlation.jointProbability. Omit it only when the legs really are
 *   independent — different fixtures — and the returned `independence` field
 *   will say that is what was assumed.
 *
 * options.stakeUnits — total stake for the comparison. Defaults to 1.
 */
function evaluateMultiple(legs, options = {}) {
  if (!Array.isArray(legs) || legs.length < 2) {
    throw new Error('a multiple needs at least two legs');
  }
  legs.forEach(assertLeg);

  const { jointProbability = null, stakeUnits = 1 } = options;
  if (!Number.isFinite(stakeUnits) || stakeUnits <= 0 || stakeUnits > 1) {
    throw new Error(`stake must be above 0 and at most 1 unit, got ${stakeUnits}`);
  }

  const independentProbability = legs.reduce((acc, l) => acc * l.probability, 1);
  const probability = jointProbability === null ? independentProbability : jointProbability;
  if (probability <= 0 || probability >= 1) {
    throw new Error(`the combined probability must be between 0 and 1 exclusive, got ${probability}`);
  }

  // The one thing about a multiple that genuinely favours the bettor: prices
  // multiply, so a real edge on every leg compounds into a larger one.
  const decimalOdd = round(legs.reduce((acc, l) => acc * l.decimalOdd, 1), 4);
  const implied = impliedProbability(decimalOdd);
  const combined = outcome(probability, decimalOdd);

  // And the thing that does not: so does the margin. Four legs at 6% each are
  // not a 6% market, they are a 26% one.
  const overrounds = legs.map((l) => (Number.isFinite(l.overround) ? l.overround : null));
  const knownOverrounds = overrounds.filter((o) => o !== null);
  const compoundedMargin = knownOverrounds.length === legs.length
    ? round(knownOverrounds.reduce((acc, o) => acc * (1 + o), 1) - 1)
    : null;

  // The alternative that is always available: the same total stake, split
  // evenly across the same selections as singles. Same money, same opinions,
  // different shape — and the shape is the whole decision.
  const each = stakeUnits / legs.length;
  const singlesExpectedValue = round(legs.reduce(
    (acc, l) => acc + each * outcome(l.probability, l.decimalOdd).expectedValue, 0));
  // Independence is the right assumption HERE even for same-match legs: this is
  // the chance that every one of them loses, and correlation moves it, but not
  // in a direction that changes the comparison's point.
  const singlesTotalLoss = round(legs.reduce((acc, l) => acc * (1 - l.probability), 1));

  return {
    legs: legs.map((l, i) => ({
      label: l.label || `leg ${i + 1}`,
      probability: l.probability,
      decimalOdd: l.decimalOdd,
      edge: round(l.probability - impliedProbability(l.decimalOdd))
    })),
    probability: round(probability),
    independence: {
      assumed: jointProbability === null,
      independentProbability: round(independentProbability),
      note: jointProbability === null
        ? 'legs multiplied as independent — correct only if they are on different matches'
        : 'the combined probability was corrected for correlation between legs on the same match'
    },
    decimalOdd,
    impliedProbability: round(implied),
    edge: round(probability - implied),
    expectedValue: combined.expectedValue,
    expectedValueOnStake: round(combined.expectedValue * stakeUnits),
    probabilityOfLosing: combined.probabilityOfLosing,
    margin: {
      perLeg: overrounds,
      compounded: compoundedMargin,
      note: compoundedMargin === null
        ? 'a leg did not carry an overround, so the compounded margin cannot be stated'
        : `the book's margin compounds to ${(compoundedMargin * 100).toFixed(1)}% across `
          + `${legs.length} legs`
    },
    versusSingles: {
      stakeUnits,
      eachSingleStake: round(each),
      multipleExpectedValue: round(combined.expectedValue * stakeUnits),
      singlesExpectedValue,
      multipleLosesEverything: combined.probabilityOfLosing,
      singlesLoseEverything: singlesTotalLoss,
      note: 'the same stake as singles risks the same money on the same opinions. The multiple '
        + `loses the lot ${(combined.probabilityOfLosing * 100).toFixed(0)}% of the time against `
        + `${(singlesTotalLoss * 100).toFixed(1)}% for the singles — that difference is what the `
        + 'larger payout is bought with'
    }
  };
}

module.exports = { evaluateMultiple, outcome };
