'use strict';

const provider = require('../provider/apiFootball');
const cache = require('../cache');
const matchStats = require('./matchStats');

// One team's recent record in ONE per-match statistic, for and against.
//
// Corners were the first, and for a while the only, so the machinery lived
// inside cornerProfile.js. Cards are the same shape with a different column —
// same endpoint, same cached response, same failure modes — so the shape moved
// here and both families are now instances of it. A third costs a registry
// entry and nothing else.
//
// The cost is shared as well as the code. `/fixtures/statistics` returns
// eighteen statistics for both teams in one response, and a finished match is
// cached permanently, so profiling cards over the same window a corner profile
// already covered spends no requests at all.

/**
 * Builds a profile function for one statistic.
 *
 * `forKey` and `againstKey` name the fields on each match, so a baseline can
 * keep speaking in its own terms — `cornersFor`, `yellowsAgainst` — rather than
 * in generic ones nobody reading a ledger record would recognise.
 */
function makeStatProfile(spec) {
  const {
    statType, forKey, againstKey, totalKey,
    defaultMatchCount = 10, maxMatchCount = 20, noun = statType
  } = spec;

  function valueOf(entries, teamId) {
    return matchStats.statValue(entries, teamId, statType);
  }

  async function profile(teamId, matchCount, forceRefresh) {
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

    // isFinished only validates fixture.status.short, so a fixture can pass it
    // and still be missing `teams`. Everything that reads the fixture is inside
    // the try: one unexpected shape costs one match, not the call.
    await matchStats.mapWithConcurrency(finished, matchStats.CONCURRENCY,
      async (fixture, index) => {
        let id = null;
        try {
          id = fixture.fixture.id;
          const isHome = fixture.teams.home.id === teamId;
          const opponent = isHome ? fixture.teams.away : fixture.teams.home;

          let entries;
          try {
            // Already filtered to finished matches, so these are immutable.
            entries = await matchStats.fetchStatistics(id, forceRefresh, cache.TTL.PERMANENT);
          } catch (err) {
            failures.push({ fixtureId: id, reason: err.message });
            return;
          }

          const forValue = valueOf(entries, teamId);
          const againstValue = valueOf(entries, opponent.id);
          // null means not recorded. Coercing either to 0 would corrupt every
          // average computed from it, and for cards it would invent a clean
          // game out of a missing one.
          if (forValue === null || againstValue === null) {
            failures.push({ fixtureId: id, reason: `no ${noun} recorded for this match` });
            return;
          }

          matches.push({
            fixtureId: id,
            date: fixture.fixture.date,
            // The window is the last N matches, not the last N of this season,
            // so the baseline can report how much of the sample predates the
            // fixture being priced.
            season: fixture.league ? fixture.league.season : null,
            opponent: opponent.name,
            venue: isHome ? 'home' : 'away',
            [forKey]: forValue,
            [againstKey]: againstValue
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
      [forKey]: acc[forKey] + m[forKey],
      [againstKey]: acc[againstKey] + m[againstKey]
    }), { [forKey]: 0, [againstKey]: 0 });

    const round = (n) => Math.round(n * 100) / 100;

    return {
      teamId,
      matchesAnalyzed: matches.length,
      matches,
      totals,
      averages: matches.length ? {
        [forKey]: round(totals[forKey] / matches.length),
        [againstKey]: round(totals[againstKey] / matches.length),
        [totalKey]: round((totals[forKey] + totals[againstKey]) / matches.length)
      } : null,
      failures
    };
  }

  return {
    profile,
    valueOf,
    statType,
    forKey,
    againstKey,
    totalKey,
    DEFAULT_MATCH_COUNT: defaultMatchCount,
    MAX_MATCH_COUNT: maxMatchCount
  };
}

module.exports = { makeStatProfile };
