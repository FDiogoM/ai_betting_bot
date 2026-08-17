'use strict';

// Pure: no imports, no clock, no randomness.

function assertOdd(odd) {
  // A decimal odd of 1 pays nothing back beyond the stake, and below 1 is not a
  // price at all. Either means the input is corrupt, not that the bet is bad.
  if (!Number.isFinite(odd) || odd <= 1) {
    throw new Error(`decimal odd must be a finite number above 1, got ${odd}`);
  }
}

function impliedProbability(odd) {
  assertOdd(odd);
  return 1 / odd;
}

function overround(odds) {
  return odds.reduce((acc, o) => acc + impliedProbability(o), 0) - 1;
}

// Proportional de-vig: divide each raw implied probability by their sum. For a
// two-outcome market this is adequate. Methods that weight the favourite and
// the longshot differently (Shin) assume a bias that cannot be verified without
// a settled history; revisit once the ledger provides one.
function fairProbabilities(odds) {
  const raw = odds.map(impliedProbability);
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((p) => p / sum);
}

function median(values) {
  if (!values.length) throw new Error('median of an empty sample is undefined');
  // Copy before sorting: callers pass arrays they still need in their original
  // order, and Array.prototype.sort mutates in place.
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function bestPrice(quotes) {
  if (!quotes || !quotes.length) throw new Error('no quotes to pick a best price from');
  return quotes.reduce((best, q) => (q.odd > best.odd ? q : best));
}

module.exports = { impliedProbability, overround, fairProbabilities, median, bestPrice };
