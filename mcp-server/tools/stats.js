'use strict';

const { z } = require('zod');
const provider = require('../provider/apiFootball');
const cache = require('../cache');
const aggregate = require('../aggregate/cornerProfile');
const { run } = require('../result');

const { DEFAULT_MATCH_COUNT, MAX_MATCH_COUNT } = aggregate;

const forceRefresh = z.boolean().optional()
  .describe('Bypass the cache and refetch. Costs requests against the daily quota.');

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
        aggregate.fetchStatistics(fixtureId, forceRefresh, aggregate.statisticsTtl))
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
      run(`get_team_corner_profile(${teamId})`, () =>
        aggregate.cornerProfile(teamId, matchCount, forceRefresh))
  );
}

module.exports = { register };
