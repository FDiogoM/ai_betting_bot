'use strict';

const { z } = require('zod');
const provider = require('../provider/apiFootball');
const http = require('../http');
const cache = require('../cache');
const quota = require('../quota');
const version = require('../version');
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
        + 'to confirm there is budget for it. Also reports `server`, including whether this '
        + 'process is running code older than the repository — check `server.stale` before '
        + 'trusting any tool output whose shape you did not expect.',
      inputSchema: {}
    },
    // Deliberately bypasses provider.fetch: status must never be cached, and
    // provider.fetch always writes a cache entry.
    async () => run('get_api_status', async () => {
      // Read first, and never inside the try. This is the one call every
      // procedure makes before doing anything expensive, which makes it the
      // right place to catch a stale process — but only if it survives a
      // provider outage. A staleness report that disappears exactly when the
      // network does would be missing on the days it is most needed.
      const server = version.status();

      let account = null;
      let accountError = null;
      try {
        const { data, quota: seen } = await http.request(provider.ENDPOINTS.STATUS);
        quota.record(seen);
        // /status is the one endpoint documented to answer with an object
        // rather than an array, so data[0] would report no account at all.
        // Tolerate both shapes.
        account = Array.isArray(data) ? data[0] || null : data || null;
      } catch (err) {
        // Reported in-band rather than thrown: the caller still needs the last
        // known quota and the server status, and losing both to tell them the
        // network is down trades useful diagnosis for a bare failure.
        accountError = err && err.message ? err.message : String(err);
      }

      return { account, accountError, lastSeenQuota: quota.read(), server };
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
