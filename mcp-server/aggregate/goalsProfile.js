'use strict';

const provider = require('../provider/apiFootball');
const cache = require('../cache');
const matchStats = require('./matchStats');

const DEFAULT_MATCH_COUNT = 10;
const MAX_MATCH_COUNT = 20;

// The statistic the goal rate is actually estimated from. Measured at 93.2%
// availability across the cached sample — the same as corners, and far better
// than expected_goals at 55.9%, which is why xG is not the primary signal.
const SHOTS_TYPE = 'Shots on Goal';

// Goals arrive on the fixture itself, so the goals half of this profile costs
// one request per team and never fails. Shots do not: they live in per-match
// statistics, one request per match, exactly like corners.
//
// That cost is usually already paid. The bulletin computes both families for
// every fixture, the corner profile fetches those same statistics first, and a
// finished match is cached permanently — so the shots pass on a fixture that
// already has a corner profile spends nothing. When the budget will not stretch
// to it, the shots pass is skipped rather than failing the call: a goals-only
// profile is the old behaviour, which is worse but still useful.

// null means the score was not recorded. Coercing it to 0 would invent a
// goalless draw and corrupt every average computed from it.
function goalsOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Reads shots on target for both sides of each match and attaches them in
// place. Never throws and never drops a match: a match whose shots are missing
// keeps its goals and carries nulls, and the baseline decides whether coverage
// is good enough to use the shots signal at all.
//
// Its problems are reported separately from the profile's `failures`, which
// mean a match could not be used at all. A match whose shots did not arrive is
// still a perfectly good goals observation — conflating the two would report a
// degraded signal as lost data, and would make a goals-only profile look broken
// when it is merely the older, noisier model.
async function attachShots(matches, teamId, forceRefresh) {
  for (const m of matches) {
    m.shotsOnTargetFor = null;
    m.shotsOnTargetAgainst = null;
  }

  const failures = [];

  try {
    matchStats.assertWithinCeiling(matches.map((m) => m.fixtureId), forceRefresh);
  } catch (err) {
    // Budget, not breakage. The goals half is complete and usable.
    return { attempted: false, reason: err.message, failures };
  }

  await matchStats.mapWithConcurrency(matches, matchStats.CONCURRENCY, async (m) => {
    let entries;
    try {
      // Already filtered to finished matches, so these are immutable.
      entries = await matchStats.fetchStatistics(m.fixtureId, forceRefresh, cache.TTL.PERMANENT);
    } catch (err) {
      failures.push({ fixtureId: m.fixtureId, reason: err.message });
      return;
    }
    m.shotsOnTargetFor = matchStats.statValue(entries, teamId, SHOTS_TYPE);
    m.shotsOnTargetAgainst = matchStats.statValue(entries, m.opponentId, SHOTS_TYPE);
  });

  return { attempted: true, reason: null, failures };
}

async function goalsProfile(teamId, matchCount, forceRefresh) {
  // Same key and TTL as get_team_fixtures({team, last}): a sliding window.
  const fixtures = await provider.fetch(provider.ENDPOINTS.FIXTURES,
    { team: teamId, last: matchCount }, cache.TTL.LIVE, forceRefresh);

  const finished = fixtures.filter(provider.isFinished);
  if (!finished.length) {
    return { teamId, matchesAnalyzed: 0, matches: [], failures: [],
      note: 'No finished matches found for this team.' };
  }

  const matches = [];
  const failures = [];

  // isFinished only validates fixture.status.short, so a fixture can pass it
  // and still be missing `teams` or `goals`. One unexpected shape costs one
  // match, never the call.
  finished.forEach((fixture, index) => {
    let id = null;
    try {
      id = fixture.fixture.id;
      const isHome = fixture.teams.home.id === teamId;
      const opponent = isHome ? fixture.teams.away : fixture.teams.home;

      const home = goalsOf(fixture.goals ? fixture.goals.home : null);
      const away = goalsOf(fixture.goals ? fixture.goals.away : null);
      if (home === null || away === null) {
        failures.push({ fixtureId: id, reason: 'no score recorded for this match' });
        return;
      }

      matches.push({
        fixtureId: id,
        date: fixture.fixture.date,
        // The window is the last N matches, not the last N of this season, so
        // the baseline needs each match's season to report how much of the
        // sample predates the fixture being priced.
        season: fixture.league ? fixture.league.season : null,
        opponent: opponent.name,
        opponentId: opponent.id,
        venue: isHome ? 'home' : 'away',
        goalsFor: isHome ? home : away,
        goalsAgainst: isHome ? away : home
      });
    } catch (err) {
      failures.push({
        fixtureId: id,
        reason: `fixture at index ${index} has an unexpected shape: `
          + `${err && err.message ? err.message : String(err)}`
      });
    }
  });

  const shots = matches.length
    ? await attachShots(matches, teamId, forceRefresh)
    : { attempted: false, reason: 'no matches to read shots for', failures: [] };

  matches.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const withShots = matches.filter(
    (m) => m.shotsOnTargetFor !== null && m.shotsOnTargetAgainst !== null);

  const totals = matches.reduce((acc, m) => ({
    goalsFor: acc.goalsFor + m.goalsFor,
    goalsAgainst: acc.goalsAgainst + m.goalsAgainst
  }), { goalsFor: 0, goalsAgainst: 0 });

  const shotTotals = withShots.reduce((acc, m) => ({
    shotsOnTargetFor: acc.shotsOnTargetFor + m.shotsOnTargetFor,
    shotsOnTargetAgainst: acc.shotsOnTargetAgainst + m.shotsOnTargetAgainst
  }), { shotsOnTargetFor: 0, shotsOnTargetAgainst: 0 });

  const round = (n) => Math.round(n * 100) / 100;

  return {
    teamId,
    matchesAnalyzed: matches.length,
    matches,
    totals,
    averages: matches.length ? {
      goalsFor: round(totals.goalsFor / matches.length),
      goalsAgainst: round(totals.goalsAgainst / matches.length),
      totalGoals: round((totals.goalsFor + totals.goalsAgainst) / matches.length),
      shotsOnTargetFor: withShots.length
        ? round(shotTotals.shotsOnTargetFor / withShots.length) : null,
      shotsOnTargetAgainst: withShots.length
        ? round(shotTotals.shotsOnTargetAgainst / withShots.length) : null
    } : null,
    // What the baseline needs to decide whether the shots signal is usable.
    shots: {
      attempted: shots.attempted,
      skippedReason: shots.reason,
      matchesWithShots: withShots.length,
      coverage: matches.length ? round(withShots.length / matches.length) : 0,
      failures: shots.failures
    },
    failures
  };
}

module.exports = { goalsProfile, goalsOf, SHOTS_TYPE, DEFAULT_MATCH_COUNT, MAX_MATCH_COUNT };
