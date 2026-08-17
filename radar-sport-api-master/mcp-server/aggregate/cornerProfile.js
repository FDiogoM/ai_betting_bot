'use strict';

const provider = require('../provider/apiFootball');
const cache = require('../cache');
const quota = require('../quota');

const CORNER_TYPE = 'Corner Kicks';
const CONCURRENCY = 3;
const DEFAULT_MATCH_COUNT = 10;
const MAX_MATCH_COUNT = 20;

function statisticsParams(fixtureId) {
  return { fixture: fixtureId };
}

// Finished-match statistics are immutable, so a caller that has already
// established the match is finished passes TTL.PERMANENT — that is what makes
// repeat corner analysis nearly free. A caller that has not must not, because
// an unplayed fixture answers with [], and storing that permanently would
// report "empty" forever.
function fetchStatistics(fixtureId, force, ttl) {
  return provider.fetch(provider.ENDPOINTS.FIXTURE_STATISTICS,
    statisticsParams(fixtureId), ttl, force);
}

// Whether a response can be trusted as final, judged from the response itself.
function statisticsTtl(data) {
  return data.length ? cache.TTL.PERMANENT : cache.TTL.LIVE;
}

function cornerValue(entries, teamId) {
  const forTeam = entries.find((e) => e.team && e.team.id === teamId);
  if (!forTeam || !Array.isArray(forTeam.statistics)) return null;
  const stat = forTeam.statistics.find((s) => s.type === CORNER_TYPE);
  // null means the statistic was not recorded. Coercing it to 0 would corrupt
  // every average computed from it.
  if (!stat || stat.value === null || stat.value === undefined || stat.value === '') return null;
  const n = Number(stat.value);
  return Number.isFinite(n) ? n : null;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  let doomed = false;
  async function pump() {
    while (cursor < items.length && !doomed) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index], index);
      } catch (err) {
        // Promise.all rejects on the first failure, so the call is already
        // lost. Without this the surviving workers keep draining the cursor
        // and spending quota on a call that has returned an error.
        doomed = true;
        throw err;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, pump));
  return results;
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

  // Count only what would actually hit the network; a warm cache is free.
  const ceiling = quota.maxRequestsPerCall();
  const needed = forceRefresh
    ? finished.length
    : provider.countUncached(provider.ENDPOINTS.FIXTURE_STATISTICS,
        finished.map((f) => statisticsParams(f.fixture.id)));
  if (needed > ceiling) {
    throw new Error(`would need ${needed} requests, above the `
      + `per-call ceiling of ${ceiling}. Lower matchCount, or raise MCP_MAX_REQUESTS_PER_CALL.`);
  }

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
