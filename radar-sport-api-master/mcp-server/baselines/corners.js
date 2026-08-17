'use strict';

const poisson = require('./poisson');

const DEFAULT_LINES = [7.5, 8.5, 9.5, 10.5, 11.5, 12.5];

// Below this many matches at a venue, the venue split is noise and all matches
// are used instead. Five home games is already a thin sample; three is a guess.
const MIN_VENUE_SAMPLE = 4;

function round(n, places = 2) {
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
}

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Returns the venue-filtered mean when the sample is large enough, otherwise
// the all-matches mean plus the caveat explaining the fallback.
function venueMean(matches, venue, pick, label, caveats) {
  const atVenue = matches.filter((m) => m.venue === venue);
  if (atVenue.length >= MIN_VENUE_SAMPLE) return mean(atVenue.map(pick));
  caveats.push(`${label}: venue sample at ${venue} is ${atVenue.length}, `
    + `below ${MIN_VENUE_SAMPLE}; used all ${matches.length} matches instead`);
  return mean(matches.map(pick));
}

function assertHasMatches(profile, label) {
  if (!profile || !Array.isArray(profile.matches) || profile.matches.length === 0) {
    throw new Error(`${label} has no matches to compute a baseline from`);
  }
}

/**
 * Returns:
 *   { lambda: { home, away, total },
 *     model: 'poisson',
 *     lines: [{ line, overProbability, underProbability,
 *               empiricalOverRate, empiricalSample }],
 *     dispersion: { mean, variance, ratio },
 *     sample: { home: n, away: n, pooled: n },
 *     caveats: string[] }
 */
function cornerBaseline(homeProfile, awayProfile, lines = DEFAULT_LINES) {
  assertHasMatches(homeProfile, 'home team');
  assertHasMatches(awayProfile, 'away team');

  const caveats = [
    'no league normalisation: team rates are used raw, not adjusted to the league average',
    'equal weighting across matches, with no recency decay'
  ];

  const forCorners = (m) => m.cornersFor;
  const againstCorners = (m) => m.cornersAgainst;

  const homeForAtHome = venueMean(homeProfile.matches, 'home', forCorners, 'home team', caveats);
  const homeAgainstAtHome = venueMean(homeProfile.matches, 'home', againstCorners, 'home team', caveats);
  const awayForAway = venueMean(awayProfile.matches, 'away', forCorners, 'away team', caveats);
  const awayAgainstAway = venueMean(awayProfile.matches, 'away', againstCorners, 'away team', caveats);

  const lambdaHome = (homeForAtHome + awayAgainstAway) / 2;
  const lambdaAway = (awayForAway + homeAgainstAtHome) / 2;
  const lambdaTotal = lambdaHome + lambdaAway;

  // The empirical check pools both teams' match totals. It double-counts any
  // fixture the two played against each other, which is at most one or two
  // matches and is declared rather than corrected.
  const pooledTotals = [...homeProfile.matches, ...awayProfile.matches]
    .map((m) => m.cornersFor + m.cornersAgainst);
  caveats.push('empirical rate pools both teams\' matches, so a head-to-head meeting counts twice');

  const pooledMean = mean(pooledTotals);
  const variance = pooledTotals.length > 1
    ? pooledTotals.reduce((acc, t) => acc + (t - pooledMean) ** 2, 0) / (pooledTotals.length - 1)
    : 0;

  // Published as the pair a reader sees, so dividing the two printed figures
  // reproduces the printed ratio. Rounding the ratio independently made the
  // trio contradict itself: 0.9 over 10.3 is 0.0874, never 0.09.
  const publishedMean = round(pooledMean);
  const publishedVariance = round(variance);

  return {
    lambda: { home: round(lambdaHome), away: round(lambdaAway), total: round(lambdaTotal) },
    model: 'poisson',
    lines: lines.map((line) => {
      const over = poisson.probOver(lambdaTotal, line);
      return {
        line,
        overProbability: round(over, 4),
        underProbability: round(1 - over, 4),
        empiricalOverRate: round(
          pooledTotals.filter((t) => t > line).length / pooledTotals.length, 4),
        empiricalSample: pooledTotals.length
      };
    }),
    dispersion: {
      mean: publishedMean,
      variance: publishedVariance,
      ratio: publishedMean === 0 ? null : publishedVariance / publishedMean
    },
    sample: {
      home: homeProfile.matches.length,
      away: awayProfile.matches.length,
      pooled: pooledTotals.length
    },
    caveats
  };
}

module.exports = { cornerBaseline, DEFAULT_LINES, MIN_VENUE_SAMPLE };
