'use strict';

const { totalsBaseline, MIN_VENUE_SAMPLE } = require('./totals');
const markets = require('../markets');

const DEFAULT_LINES = markets.get('goals').defaultLines;

// Below this fraction of a team's matches carrying shots data, the shots signal
// is built on too little and the raw goal rate is used instead. Shots run at
// about 93% availability, so this is the exception rather than the rule — but
// it must be an exception the code handles, not one it assumes away.
const MIN_SHOTS_COVERAGE = 0.6;

// Below this many shots on target in the pooled sample, the conversion rate is
// too noisy to divide by. Roughly four matches' worth.
const MIN_POOLED_SHOTS = 40;

function matchesWithShots(profile) {
  return profile.matches.filter(
    (m) => m.shotsOnTargetFor !== null && m.shotsOnTargetFor !== undefined
      && m.shotsOnTargetAgainst !== null && m.shotsOnTargetAgainst !== undefined);
}

function coverage(profile) {
  if (!profile.matches.length) return 0;
  return matchesWithShots(profile).length / profile.matches.length;
}

/**
 * How often a shot on target became a goal, pooled across both teams' matches.
 *
 * Pooled deliberately, rather than per team. A team's own conversion over a
 * dozen matches is mostly finishing variance — a striker on a hot streak, a
 * deflection, a goalkeeper error — and carrying it forward is precisely the
 * noise this change exists to remove. Pooling estimates one finishing rate and
 * lets the teams differ in the thing that actually repeats: how many shots on
 * target they create and concede.
 *
 * What this does NOT remove is a finishing level common to both teams: if both
 * are clinical, the pooled rate is high and stays high. That is a real limit,
 * and it is declared in the caveats rather than papered over. Removing it needs
 * a league-wide conversion rate, which no single request provides today.
 */
function pooledConversion(homeProfile, awayProfile) {
  const usable = [...matchesWithShots(homeProfile), ...matchesWithShots(awayProfile)];
  if (!usable.length) return null;

  const goals = usable.reduce((acc, m) => acc + m.goalsFor + m.goalsAgainst, 0);
  const shots = usable.reduce((acc, m) => acc + m.shotsOnTargetFor + m.shotsOnTargetAgainst, 0);
  if (shots < MIN_POOLED_SHOTS) return null;

  return {
    rate: goals / shots,
    goals,
    shotsOnTarget: shots,
    matches: usable.length
  };
}

/**
 * The total-goals baseline.
 *
 * The rate is estimated from SHOTS ON TARGET, not from goals scored. Goals are
 * the outcome and shots are the process: a team that took fifteen shots and
 * scored none will score more next time, and a team that took three and scored
 * two will score fewer. Over a fourteen-match window a goal rate rests on
 * roughly thirty-five events and a shots rate on about a hundred and fifty, so
 * the same sample carries far less noise when read this way.
 *
 * Lambda is therefore `mean shots on target × pooled conversion`, in goals
 * units, so the lines still mean what they say. The empirical over-rate and the
 * dispersion continue to be computed from REAL goals — they are the check on
 * the model, and a check computed from the model's own inputs checks nothing.
 *
 * Falls back to the old goal-rate model, declared in `caveats` and in `signal`,
 * whenever shots coverage is too thin to trust. See totals.js for the shape;
 * this adds `signal`, `conversion` and `comparison`.
 */
function goalsBaseline(homeProfile, awayProfile, lines = DEFAULT_LINES, options = {}) {
  const fromGoals = {
    forOf: (m) => m.goalsFor,
    againstOf: (m) => m.goalsAgainst
  };

  const conversion = pooledConversion(homeProfile, awayProfile);
  const thinCoverage = coverage(homeProfile) < MIN_SHOTS_COVERAGE
    || coverage(awayProfile) < MIN_SHOTS_COVERAGE;

  if (!conversion || thinCoverage) {
    const baseline = totalsBaseline(homeProfile, awayProfile, lines, { ...options, ...fromGoals });
    baseline.signal = 'goals';
    baseline.conversion = null;
    baseline.comparison = null;
    baseline.caveats.push(!conversion
      ? 'shots on target were unavailable or too few to convert, so the rate is estimated from '
        + 'goals scored: a noisier signal than shots, and the one this model prefers to avoid'
      : `shots coverage is below ${MIN_SHOTS_COVERAGE} for at least one team, so the rate is `
        + 'estimated from goals scored rather than shots on target');
    return baseline;
  }

  // Only matches carrying shots can inform a shots-based rate. That changes the
  // venue counts, so the venue-sample fallback is judged against this narrower
  // sample — correctly, since it is the sample actually being averaged.
  const homeShots = { ...homeProfile, matches: matchesWithShots(homeProfile) };
  const awayShots = { ...awayProfile, matches: matchesWithShots(awayProfile) };

  const baseline = totalsBaseline(homeShots, awayShots, lines, {
    ...options,
    forOf: (m) => m.shotsOnTargetFor * conversion.rate,
    againstOf: (m) => m.shotsOnTargetAgainst * conversion.rate,
    // Real goals, always. See totals.js.
    empiricalOf: (m) => m.goalsFor + m.goalsAgainst
  });

  const round = (n, places = 4) => Math.round(n * 10 ** places) / 10 ** places;

  baseline.signal = 'shots';
  baseline.conversion = {
    rate: round(conversion.rate),
    goals: conversion.goals,
    shotsOnTarget: conversion.shotsOnTarget,
    matches: conversion.matches
  };
  baseline.caveats.push(
    `rate estimated from shots on target × a pooled conversion of ${round(conversion.rate, 3)} `
    + `(${conversion.goals} goals from ${conversion.shotsOnTarget} shots on target across `
    + `${conversion.matches} matches), not from goals scored`,
    'the pooled conversion removes each team\'s match-to-match finishing variance, but not a '
    + 'finishing level the two share: no league-wide conversion is available to measure that against');

  // What the previous model would have said, on the same fixture and the same
  // window. Kept beside the answer rather than discarded: this change has to be
  // auditable, and a reader comparing the two is how it gets audited.
  const asGoals = totalsBaseline(homeProfile, awayProfile, lines, { ...options, ...fromGoals });
  baseline.comparison = {
    signal: 'goals',
    lambda: asGoals.lambda,
    lines: asGoals.lines.map((l) => ({ line: l.line, overProbability: l.overProbability }))
  };

  return baseline;
}

module.exports = {
  goalsBaseline,
  pooledConversion,
  DEFAULT_LINES,
  MIN_VENUE_SAMPLE,
  MIN_SHOTS_COVERAGE,
  MIN_POOLED_SHOTS
};
