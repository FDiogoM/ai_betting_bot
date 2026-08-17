'use strict';

const { z } = require('zod');
const provider = require('../provider/apiFootball');
const cache = require('../cache');
const quota = require('../quota');
const { run } = require('../result');

const CORNER_TYPE = 'Corner Kicks';
const CONCURRENCY = 3;
const DEFAULT_MATCH_COUNT = 10;
const MAX_MATCH_COUNT = 20;

const forceRefresh = z.boolean().optional()
  .describe('Bypass the cache and refetch. Costs requests against the daily quota.');

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

function register(server) {
  server.registerTool(
    'get_fixture_statistics',
    {
      title: 'Get match statistics',
      description: 'Per-team statistics for one fixture: corner kicks, cards, shots on and off '
        + 'target, possession, offsides and fouls. Finished matches are cached permanently.',
      inputSchema: { fixtureId: z.number().int().positive().describe('Fixture ID.'), forceRefresh }
    },
    // No isFinished guard here — that would cost an extra /fixtures request —
    // so the TTL is decided from the response instead.
    async ({ fixtureId, forceRefresh }) =>
      run(`get_fixture_statistics(${fixtureId})`, () =>
        fetchStatistics(fixtureId, forceRefresh, statisticsTtl))
  );

  server.registerTool(
    'get_team_season_statistics',
    {
      title: 'Get a team\'s season statistics',
      description: 'Aggregate season form for one team in one league — played, wins, goals for '
        + 'and against, streaks. One request, so prefer this over per-match analysis when '
        + 'season-level form is enough.',
      inputSchema: {
        leagueId: z.number().int().positive().describe('League ID from search_leagues.'),
        season: z.number().int().min(2000).max(2100).describe('Season start year, e.g. 2026.'),
        teamId: z.number().int().positive().describe('Team ID from search_teams.'),
        forceRefresh
      }
    },
    async ({ leagueId, season, teamId, forceRefresh }) =>
      run(`get_team_season_statistics(${teamId})`, () =>
        provider.fetch(provider.ENDPOINTS.TEAM_STATISTICS,
          { league: leagueId, season, team: teamId }, cache.TTL.TABLE, forceRefresh))
  );

  server.registerTool(
    'get_team_corner_profile',
    {
      title: 'Get a team\'s corner profile',
      description: 'Corner analysis across a team\'s recent finished matches. Fetches the '
        + 'fixtures and each one\'s statistics, returning corners for and against per match '
        + 'plus totals and averages. This is the tool for corner analysis. It costs roughly one '
        + 'request per uncached match, so check get_api_status first when the quota is tight.',
      inputSchema: {
        teamId: z.number().int().positive().describe('Team ID from search_teams.'),
        // The default lives in the schema so an MCP client can discover it.
        matchCount: z.number().int().min(1).max(MAX_MATCH_COUNT).default(DEFAULT_MATCH_COUNT)
          .describe(`How many recent finished matches to analyze (default ${DEFAULT_MATCH_COUNT}, max ${MAX_MATCH_COUNT}).`),
        forceRefresh
      }
    },
    async ({ teamId, matchCount, forceRefresh }) =>
      run(`get_team_corner_profile(${teamId})`, async () => {
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
      })
  );
}

module.exports = { register };
