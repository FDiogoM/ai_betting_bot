'use strict';

const provider = require('../provider/apiFootball');
const cache = require('../cache');
const matchStats = require('./matchStats');

const CORNER_TYPE = 'Corner Kicks';
const DEFAULT_MATCH_COUNT = 10;
const MAX_MATCH_COUNT = 20;

const {
  statisticsParams, fetchStatistics, statisticsTtl, mapWithConcurrency, CONCURRENCY
} = matchStats;

// The corner-shaped door onto the generic reader. Kept because it is the name
// the rest of the corner slice already calls, and because the statistic's exact
// name is corner knowledge, not general knowledge.
function cornerValue(entries, teamId) {
  return matchStats.statValue(entries, teamId, CORNER_TYPE);
}

async function cornerProfile(teamId, matchCount, forceRefresh) {
  // Same key and TTL as get_team_fixtures({team, last}): a sliding window.
  const fixtures = await provider.fetch(provider.ENDPOINTS.FIXTURES,
    { team: teamId, last: matchCount }, cache.TTL.LIVE, forceRefresh);

  const finished = fixtures.filter(provider.isFinished);
  if (!finished.length) {
    return { teamId, matchesAnalyzed: 0, matches: [], failures: [],
      note: 'No finished matches found for this team.' };
  }

  matchStats.assertWithinCeiling(finished.map((f) => f.fixture.id), forceRefresh);

  const matches = [];
  const failures = [];

  // isFinished only validates fixture.status.short, so a fixture can pass
  // it and still be missing `teams`. Everything that reads the fixture is
  // inside the try: one unexpected shape costs one match, not the call.
  await mapWithConcurrency(finished, CONCURRENCY, async (fixture, index) => {
    let id = null;
    try {
      id = fixture.fixture.id;
      const isHome = fixture.teams.home.id === teamId;
      const opponent = isHome ? fixture.teams.away : fixture.teams.home;

      let entries;
      try {
        // Already filtered to finished matches, so these are immutable.
        entries = await fetchStatistics(id, forceRefresh, cache.TTL.PERMANENT);
      } catch (err) {
        failures.push({ fixtureId: id, reason: err.message });
        return;
      }

      const cornersFor = cornerValue(entries, teamId);
      const cornersAgainst = cornerValue(entries, opponent.id);
      if (cornersFor === null || cornersAgainst === null) {
        failures.push({ fixtureId: id, reason: 'no corner statistics recorded for this match' });
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
        venue: isHome ? 'home' : 'away',
        cornersFor,
        cornersAgainst
      });
    } catch (err) {
      failures.push({
        fixtureId: id,
        reason: `fixture at index ${index} has an unexpected shape: `
          + `${err && err.message ? err.message : String(err)}`
      });
    }
  });

  matches.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const totals = matches.reduce((acc, m) => ({
    cornersFor: acc.cornersFor + m.cornersFor,
    cornersAgainst: acc.cornersAgainst + m.cornersAgainst
  }), { cornersFor: 0, cornersAgainst: 0 });

  const round = (n) => Math.round(n * 100) / 100;

  return {
    teamId,
    matchesAnalyzed: matches.length,
    matches,
    totals,
    averages: matches.length ? {
      cornersFor: round(totals.cornersFor / matches.length),
      cornersAgainst: round(totals.cornersAgainst / matches.length),
      totalCorners: round((totals.cornersFor + totals.cornersAgainst) / matches.length)
    } : null,
    failures
  };
}

module.exports = {
  cornerProfile,
  cornerValue,
  fetchStatistics,
  statisticsTtl,
  statisticsParams,
  CORNER_TYPE,
  DEFAULT_MATCH_COUNT,
  MAX_MATCH_COUNT
};
