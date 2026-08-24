'use strict';

// Pure: no imports, no clock, no filesystem.
//
// Two selections on the SAME match need not be independent, so multiplying
// their probabilities is a modelling choice rather than arithmetic. Whether it
// is a good one is a question about data.
//
// The received wisdom is that goals and corners move together — both follow
// from a team attacking — which would make the product understate how often the
// pair lands, in the direction that flatters the bet. A first pass over 237
// cached matches did not show that: Pearson between the two totals came out at
// -0.077, and over 2.5 goals with over 9.5 corners landed together 0.266 of the
// time against 0.287 under independence. Near zero, faintly the other way.
//
// That pass joined matches by team pair rather than fixture id and so is
// indicative only — the join below is exact — but it is reason enough to
// measure the correction on every combination instead of assuming its sign.
// Which is the point: this module returns what the sample shows, including when
// what it shows is that independence was close enough.

// Below this many matches carrying both counts, a joint rate is a coin flip
// with extra steps. Roughly a season's worth between two teams.
const MIN_JOINT_SAMPLE = 16;

// How far the correction is allowed to move the independent product. Football
// totals are correlated, not glued together; a sample that says otherwise is
// telling us about itself, not about football. Beyond these the lift is clamped
// and the clamping is declared.
const MIN_LIFT = 0.6;
const MAX_LIFT = 1.6;

// Whether a historical match would have won this condition.
//
// Two forms, because two shapes. A totals condition names a column and a line;
// an outcomes condition carries its own predicate, supplied by the family that
// knows what "win to nil" means. Neither this module nor the caller has to
// learn the other's rules.
function cleared(sample, condition) {
  if (typeof condition.test === 'function') return condition.test(sample);
  const total = sample[condition.key];
  return condition.selection === 'over' ? total > condition.line : total < condition.line;
}

// Whether a sample row carries everything a condition needs to be evaluated. A
// row missing the count is not a row where the condition failed.
function usableFor(sample, condition) {
  const keys = condition.test ? (condition.needs || ['home', 'away']) : [condition.key];
  return keys.every((k) => Number.isFinite(sample[k]));
}

function rate(samples, condition) {
  return samples.filter((s) => cleared(s, condition)).length / samples.length;
}

function round(n, places = 4) {
  return n === null ? null : Math.round(n * 10 ** places) / 10 ** places;
}

/**
 * How often both conditions held in the same match, against how often they
 * would have if they were independent.
 *
 * `lift` is the ratio between the two. Above 1 the pair arrives together more
 * often than chance — the usual case for goals and corners. It is returned as a
 * multiplier rather than applied here, because the marginals worth correcting
 * are the model's, not the sample's: the sample supplies the correlation
 * structure and the Poisson supplies the better rates.
 *
 * Returns null when the sample cannot support the estimate. A null lift means
 * "assume independence and say so", never "assume 1 and move on".
 */
function empiricalJoint(samples, conditions) {
  const usable = (samples || []).filter((s) => conditions.every((c) => usableFor(s, c)));

  if (usable.length < MIN_JOINT_SAMPLE) {
    return {
      n: usable.length,
      jointRate: null,
      marginalRates: null,
      independentProduct: null,
      lift: null,
      clamped: false,
      note: `only ${usable.length} matches carry every count needed, below the `
        + `${MIN_JOINT_SAMPLE} a joint rate needs: correlation cannot be estimated from this`
    };
  }

  const jointHits = usable.filter((s) => conditions.every((c) => cleared(s, c)));
  const jointRate = jointHits.length / usable.length;
  const marginalRates = conditions.map((c) => rate(usable, c));
  const independentProduct = marginalRates.reduce((a, b) => a * b, 1);

  // A marginal of zero makes the ratio undefined, and a joint rate of zero over
  // a small sample is far more likely to be a thin sample than a real
  // impossibility.
  if (independentProduct === 0 || jointRate === 0) {
    return {
      n: usable.length,
      jointRate: round(jointRate),
      marginalRates: marginalRates.map((r) => round(r)),
      independentProduct: round(independentProduct),
      lift: null,
      clamped: false,
      note: 'one of these selections never landed in the sample, so no ratio can be formed: '
        + 'independence is assumed and this combination rests on the model alone'
    };
  }

  const raw = jointRate / independentProduct;
  const lift = Math.min(MAX_LIFT, Math.max(MIN_LIFT, raw));
  const clamped = lift !== raw;

  return {
    n: usable.length,
    jointRate: round(jointRate),
    marginalRates: marginalRates.map((r) => round(r)),
    independentProduct: round(independentProduct),
    lift: round(lift),
    rawLift: round(raw),
    clamped,
    note: clamped
      ? `the sample implies a lift of ${round(raw, 2)}, clamped to ${round(lift, 2)}: a `
        + `correlation that extreme over ${usable.length} matches describes the sample, not football`
      : `over ${usable.length} matches these landed together ${round(jointRate, 3)} of the time `
        + `against ${round(independentProduct, 3)} if independent`
  };
}

/**
 * The joint probability of a set of same-match selections: the model's
 * marginals, multiplied, then moved by the measured lift.
 *
 * Clamped into (0, 1) exclusive, because a lift applied to already-high
 * marginals can push the product past 1, and a probability of 1 is a claim no
 * sample of this size can support.
 */
function jointProbability(marginals, lift) {
  const product = marginals.reduce((a, b) => a * b, 1);
  if (lift === null || lift === undefined) {
    return { probability: round(product, 6), lift: null, independent: true };
  }
  const adjusted = Math.min(0.999999, Math.max(0.000001, product * lift));
  return { probability: round(adjusted, 6), lift, independent: false };
}

// Pearson correlation of two totals across the sample. Not used in the pricing
// — the lift is what the pricing needs — but it is the number a reader
// recognises, and it says in one figure how tied together these two counts are.
function pearson(samples, keyA, keyB) {
  const usable = (samples || []).filter(
    (s) => Number.isFinite(s[keyA]) && Number.isFinite(s[keyB]));
  if (usable.length < 3) return null;

  const mean = (pick) => usable.reduce((acc, s) => acc + pick(s), 0) / usable.length;
  const mA = mean((s) => s[keyA]);
  const mB = mean((s) => s[keyB]);

  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (const s of usable) {
    const dA = s[keyA] - mA;
    const dB = s[keyB] - mB;
    cov += dA * dB;
    varA += dA * dA;
    varB += dB * dB;
  }
  if (varA === 0 || varB === 0) return null;
  return round(cov / Math.sqrt(varA * varB));
}

module.exports = {
  empiricalJoint, jointProbability, pearson, MIN_JOINT_SAMPLE, MIN_LIFT, MAX_LIFT
};
