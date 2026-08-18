'use strict';

const { z } = require('zod');
const provider = require('../provider/apiFootball');
const cache = require('../cache');
const { run } = require('../result');

const forceRefresh = z.boolean().optional()
  .describe('Bypass the cache and refetch. Costs requests against the daily quota.');

function register(server) {
  server.registerTool(
    'get_odds',
    {
      title: 'Get pre-match odds',
      description: 'Pre-match odds for one fixture, by bookmaker and market. Cached for 15 '
        + 'minutes because prices move continuously before kickoff. Use '
        + 'get_market_probabilities instead when you want implied probabilities rather than '
        + 'raw prices — it removes the bookmaker margin for you.',
      inputSchema: {
        fixtureId: z.number().int().positive().describe('Fixture ID.'),
        bookmakerId: z.number().int().positive().optional()
          .describe('Restrict to one bookmaker. Omit for every bookmaker quoting the fixture.'),
        forceRefresh
      }
    },
    async ({ fixtureId, bookmakerId, forceRefresh }) =>
      run(`get_odds(${fixtureId})`, () => {
        const params = { fixture: fixtureId };
        if (bookmakerId !== undefined) params.bookmaker = bookmakerId;
        return provider.fetch(provider.ENDPOINTS.ODDS, params, cache.TTL.ODDS, forceRefresh);
      })
  );
}

module.exports = { register };
