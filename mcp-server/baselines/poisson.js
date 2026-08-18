'use strict';

// Pure: no imports, no clock, no randomness. Same inputs, same outputs.

function assertLambda(lambda) {
  if (!Number.isFinite(lambda) || lambda < 0) {
    throw new Error(`lambda must be a finite number >= 0, got ${lambda}`);
  }
}

function pmf(lambda, k) {
  assertLambda(lambda);
  if (!Number.isInteger(k) || k < 0) throw new Error(`k must be an integer >= 0, got ${k}`);
  // Iterative term: term_k = term_{k-1} * lambda / k. Computing lambda^k / k!
  // directly overflows for large k long before the ratio does.
  let term = Math.exp(-lambda);
  for (let i = 1; i <= k; i += 1) term = (term * lambda) / i;
  return term;
}

function cdf(lambda, k) {
  assertLambda(lambda);
  if (!Number.isInteger(k) || k < 0) throw new Error(`k must be an integer >= 0, got ${k}`);
  let term = Math.exp(-lambda);
  let total = term;
  for (let i = 1; i <= k; i += 1) {
    term = (term * lambda) / i;
    total += term;
  }
  return total;
}

// A market line must be a half-integer: "over 9.5" means X >= 10, with no
// ambiguity. A whole line pushes when the total lands on it, and nothing
// downstream can represent a push.
function assertHalfLine(line) {
  if (!Number.isFinite(line) || line <= 0 || (line * 2) % 2 !== 1) {
    throw new Error(`line must be a positive half-integer such as 9.5, got ${line}`);
  }
}

function probOver(lambda, line) {
  assertHalfLine(line);
  return 1 - cdf(lambda, Math.floor(line));
}

function probUnder(lambda, line) {
  return 1 - probOver(lambda, line);
}

module.exports = { pmf, cdf, probOver, probUnder };
