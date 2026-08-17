'use strict';

const { z } = require('zod');
const provider = require('../provider/apiFootball');
const cache = require('../cache');
const { run, fail } = require('../result');

const forceRefresh = z.boolean().optional()
  .describe('Bypass the cache and refetch. Costs a request against the daily quota.');
const teamId = z.number().int().positive().describe('Team ID from search_teams.');
const leagueId = z.number().int().positive().describe('League ID from search_leagues.');
const season = z.number().int().min(2000).max(2100).describe('Season start year, e.g. 2026.');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Date as YYYY-MM-DD.');

// A response of all-finished fixtures never changes; anything else might.
// Only safe for queries that name a fixed set of fixtures — an id, or a league
// plus a closed date range. A sliding window (last/next N, head-to-head) must
// NOT use this: its members are immutable but its membership is not, so the
// all-finished branch would pin the first answer forever.
function ttlFromFixtures(data) {
  return data.length && data.every(provider.isFinished) ? cache.TTL.PERMANENT : cache.TTL.LIVE;
}

function register(server) {
  server.registerTool(
    'get_fixtures',
    {
      title: 'Get fixtures in a date range',
      description: 'Lists a league\'s fixtures between two dates. Use this to find what is on '
        + 'this weekend and to obtain fixture and team IDs for deeper analysis.',
      inputSchema: { leagueId, season, from: isoDate, to: isoDate, forceRefresh }
    },
    async ({ leagueId, season, from, to, forceRefresh }) =>
      run(`get_fixtures(${leagueId}/${season})`, () =>
        provider.fetch(provider.ENDPOINTS.FIXTURES,
          { league: leagueId, season, from, to }, ttlFromFixtures, forceRefresh))
  );

  server.registerTool(
    'get_team_fixtures',
    {
      title: 'Get a team\'s recent or upcoming fixtures',
      description: 'Returns a team\'s last N results or next N scheduled matches. '
        + 'Supply exactly one of last or next. This is the entry point for form analysis.',
      inputSchema: {
        teamId,
        last: z.number().int().min(1).max(50).optional().describe('How many recent finished matches.'),
        next: z.number().int().min(1).max(50).optional().describe('How many upcoming matches.'),
        forceRefresh
      }
    },
    async ({ teamId, last, next, forceRefresh }) => {
      if ((last && next) || (!last && !next)) {
        return fail('Supply either last or next, not both and not neither.');
      }
      const params = last ? { team: teamId, last } : { team: teamId, next };
      // A sliding window, so a short lifetime regardless of what came back.
      // get_team_corner_profile seeds itself from this same key and TTL.
      return run(`get_team_fixtures(${teamId})`, () =>
        provider.fetch(provider.ENDPOINTS.FIXTURES, params, cache.TTL.LIVE, forceRefresh));
    }
  );

  server.registerTool(
    'get_fixture',
    {
      title: 'Get one fixture',
      description: 'Full detail for a single fixture ID, including status, teams, and score.',
      inputSchema: { fixtureId: z.number().int().positive().describe('Fixture ID.'), forceRefresh }
    },
    async ({ fixtureId, forceRefresh }) =>
      run(`get_fixture(${fixtureId})`, () =>
        provider.fetch(provider.ENDPOINTS.FIXTURES, { id: fixtureId }, ttlFromFixtures, forceRefresh))
  );

  server.registerTool(
    'get_head_to_head',
    {
      title: 'Get head-to-head history',
      description: 'Historical meetings between two teams, most recent first.',
      inputSchema: { teamId, opponentId: z.number().int().positive().describe('The other team\'s ID.'), forceRefresh }
    },
    // Also a sliding window: the history is immutable but gains new meetings,
    // so it expires on the slower TABLE cadence rather than never.
    async ({ teamId, opponentId, forceRefresh }) =>
      run(`get_head_to_head(${teamId}-${opponentId})`, () =>
        provider.fetch(provider.ENDPOINTS.HEAD_TO_HEAD,
          { h2h: `${teamId}-${opponentId}` }, cache.TTL.TABLE, forceRefresh))
  );

  server.registerTool(
    'get_standings',
    {
      title: 'Get the league table',
      description: 'Current standings for a league and season.',
      inputSchema: { leagueId, season, forceRefresh }
    },
    async ({ leagueId, season, forceRefresh }) =>
      run(`get_standings(${leagueId}/${season})`, () =>
        provider.fetch(provider.ENDPOINTS.STANDINGS,
          { league: leagueId, season }, cache.TTL.TABLE, forceRefresh))
  );
}

module.exports = { register };
