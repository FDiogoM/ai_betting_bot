'use strict';

const { z } = require('zod');
const provider = require('../provider/apiFootball');
const http = require('../http');
const cache = require('../cache');
const quota = require('../quota');
const { run } = require('../result');

const forceRefresh = z.boolean().optional()
  .describe('Bypass the cache and refetch. Costs a request against the daily quota.');

function register(server) {
  server.registerTool(
    'get_api_status',
    {
      title: 'Get API account status',
      description: 'Reports the plan, requests used today, and requests remaining. '
        + 'Call this before an expensive aggregation such as get_team_corner_profile '
        + 'to confirm there is budget for it.',
      inputSchema: {}
    },
    // Deliberately bypasses provider.fetch: status must never be cached, and
    // provider.fetch always writes a cache entry.
    async () => run('get_api_status', async () => {
      const { data, quota: seen } = await http.request(provider.ENDPOINTS.STATUS);
      quota.record(seen);
      return { account: data[0] || null, lastSeenQuota: quota.read() };
    })
  );

  server.registerTool(
    'search_leagues',
    {
      title: 'Search leagues',
      description: 'Finds leagues by name and returns their IDs and available seasons. '
        + 'Use this to turn a league name such as "Premier League" into the numeric '
        + 'league ID and season year that fixture and standings tools require.',
      inputSchema: {
        query: z.string().min(3).describe('League name or fragment, e.g. "Premier" or "Primeira".'),
        forceRefresh
      }
    },
    async ({ query, forceRefresh }) =>
      run(`search_leagues(${query})`, () =>
        provider.fetch(provider.ENDPOINTS.LEAGUES, { search: query }, cache.TTL.REFERENCE, forceRefresh))
  );

  server.registerTool(
    'search_teams',
    {
      title: 'Search teams',
      description: 'Finds teams by name and returns their IDs. Team IDs are required by '
        + 'get_team_fixtures, get_team_corner_profile and get_head_to_head.',
      inputSchema: {
        query: z.string().min(3).describe('Team name or fragment, e.g. "Benfica".'),
        forceRefresh
      }
    },
    async ({ query, forceRefresh }) =>
      run(`search_teams(${query})`, () =>
        provider.fetch(provider.ENDPOINTS.TEAMS, { search: query }, cache.TTL.REFERENCE, forceRefresh))
  );
}

module.exports = { register };
