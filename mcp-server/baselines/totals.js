'use strict';

const poisson = require('./poisson');

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

// The matches one team's rates are averaged over: those at the relevant venue
// when there are enough of them, otherwise all of them, plus the caveat
// explaining the fallback.
//
// Chosen once per team, not once per rate. The fallback is a property of the
// sample, and both of a team's rates — for and against — are read off the same
// matches, so deciding it per accessor pushed the identical sentence into
// `caveats` twice. That duplicate reached the permanent ledger record.
function venueSample(matches, venue, label, caveats) {
  const atVenue = matches.filter((m) => m.venue === venue);
  if (atVenue.length >= MIN_VENUE_SAMPLE) return atVenue;
  caveats.push(`${label}: venue sample at ${venue} is ${atVenue.length}, `
    + `below ${MIN_VENUE_SAMPLE}; used all ${matches.length} matches instead`);
  return matches;
}

// A profile takes the last N matches regardless of which season they belong to.
// In August that means a team described almost entirely by last season: a
// different manager, a sold striker, second-division opposition for a promoted
// side. Pure code cannot know which season is current, so it must be told.
function seasonSplit(matches, currentSeason) {
  const current = matches.filter((m) => m.season === currentSeason).length;
  return { current, previous: matches.length - current };
}

function assertHasMatches(profile, label) {
  if (!profile || !Array.isArray(profile.matches) || profile.matches.length === 0) {
    throw new Error(`${label} has no matches to compute a baseline from`);
  }
}

/**
 * The shared engine behind every over/under-a-count baseline. Corners and goals
 * differ only in which field of a match holds the count, so they pass accessors
 * rather than each carrying a copy of this arithmetic.
 *
 * options:
 *   forOf, againstOf — (match) => number, required
 *   currentSeason    — season the fixture belongs to, or undefined if unknown
 *
 * Returns:
 *   { lambda: { home, away, total },
 *     model: 'poisson',
 *     lines: [{ line, overProbability, underProbability,
 *               empiricalOverRate, empiricalSample }],
 *     dispersion: { mean, variance, ratio },
 *     sample: { home: n, away: n, pooled: n },
 *     sampleSeasons, caveats: string[] }
 */
function totalsBaseline(homeProfile, awayProfile, lines, options = {}) {
  assertHasMatches(homeProfile, 'home team');
  assertHasMatches(awayProfile, 'away team');

  const { forOf, againstOf, currentSeason } = options;
  if (typeof forOf !== 'function' || typeof againstOf !== 'function') {
    throw new Error('totalsBaseline needs forOf and againstOf accessors');
  }

  // What actually happened in each match, which is not always what lambda is
  // estimated from. When the rate comes from a proxy — shots on target scaled
  // by a conversion rate — the empirical check and the dispersion must still
  // read the real counts, or the sanity check stops checking reality and the
  // model is left grading its own homework.
  const empiricalOf = options.empiricalOf || ((m) => forOf(m) + againstOf(m));

  const caveats = [
    'no league normalisation: team rates are used raw, not adjusted to the league average',
    'equal weighting across matches, with no recency decay'
  ];

  let sampleSeasons = null;
  if (currentSeason === undefined || currentSeason === null) {
    // Claiming the sample is current when nobody said what "current" is would
    // be a fabricated reassurance. Unknown is reported as unknown.
    caveats.push('season mix not checked: no current season was supplied, '
      + 'so the sample may be drawn from a previous season');
  } else {
    sampleSeasons = {
      home: seasonSplit(homeProfile.matches, currentSeason),
      away: seasonSplit(awayProfile.matches, currentSeason)
    };
    const stale = sampleSeasons.home.previous + sampleSeasons.away.previous;
    if (stale > 0) {
      // "not from season X" rather than "from season X-1": a match whose season
      // was never recorded is unknown, and naming a year it might not be from
      // would be a fabrication.
      caveats.push(`sample crosses the season boundary: ${stale} of `
        + `${homeProfile.matches.length + awayProfile.matches.length} matches are not from `
        + `season ${currentSeason} — previous seasons or unrecorded — when squads and `
        + 'managers may have differed');
    }
  }

  const homeSample = venueSample(homeProfile.matches, 'home', 'home team', caveats);
  const awaySample = venueSample(awayProfile.matches, 'away', 'away team', caveats);

  const homeForAtHome = mean(homeSample.map(forOf));
  const homeAgainstAtHome = mean(homeSample.map(againstOf));
  const awayForAway = mean(awaySample.map(forOf));
  const awayAgainstAway = mean(awaySample.map(againstOf));

  const lambdaHome = (homeForAtHome + awayAgainstAway) / 2;
  const lambdaAway = (awayForAway + homeAgainstAtHome) / 2;
  const lambdaTotal = lambdaHome + lambdaAway;

  // The empirical check pools both teams' match totals. It double-counts any
  // fixture the two played against each other, which is at most one or two
  // matches and is declared rather than corrected.
  const pooledTotals = [...homeProfile.matches, ...awayProfile.matches].map(empiricalOf);
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
    sampleSeasons,
    caveats
  };
}

module.exports = { totalsBaseline, MIN_VENUE_SAMPLE };
