'use strict';

const { z } = require('zod');
const provider = require('../provider/apiFootball');
const cache = require('../cache');
const aggregate = require('../aggregate/cornerProfile');
const { cornerBaseline, DEFAULT_LINES } = require('../baselines/corners');
const { run } = require('../result');

const forceRefresh = z.boolean().optional()
  .describe('Bypass the cache and refetch. Costs requests against the daily quota.');

async function resolveFixture(fixtureId, force) {
  const found = await provider.fetch(provider.ENDPOINTS.FIXTURES,
    { id: fixtureId }, cache.TTL.LIVE, force);
  if (!found.length) throw new Error(`fixture ${fixtureId} was not found`);
  const f = found[0];
  return {
    id: f.fixture.id,
    kickoff: f.fixture.date,
    league: f.league ? f.league.name : null,
    leagueId: f.league ? f.league.id : null,
    // Undefined, not a guessed year, when the response carries none — this
    // flows straight into cornerBaseline's currentSeason, and an unknown
    // season must read as unknown, not as a fabricated "this season".
    season: f.league ? f.league.season : undefined,
    home: f.teams.home.name,
    homeId: f.teams.home.id,
    away: f.teams.away.name,
    awayId: f.teams.away.id
  };
}

function register(server) {
  server.registerTool(
    'get_corner_baseline',
    {
      title: 'Get the corner baseline for a fixture',
      description: 'A deterministic corner baseline for one upcoming fixture. Blends each team\'s '
        + 'corners-for with the opponent\'s corners-against, split by venue, into a Poisson '
        + 'expectation, and prices every standard line. Returns the empirical rate beside each '
        + 'parametric probability and declares its own simplifications in `caveats` — read them, '
        + 'especially `sampleSeasons` early in a season when recent matches may predate it. '
        + 'This is arithmetic, not a recommendation: it has no view on whether the price is worth '
        + 'taking.',
      inputSchema: {
        fixtureId: z.number().int().positive().describe('Fixture ID of the upcoming match.'),
        matchCount: z.number().int().min(1).max(aggregate.MAX_MATCH_COUNT)
          .default(aggregate.DEFAULT_MATCH_COUNT)
          .describe(`Recent finished matches per team (default ${aggregate.DEFAULT_MATCH_COUNT}, `
            + `max ${aggregate.MAX_MATCH_COUNT}).`),
        lines: z.array(z.number()).optional()
          .describe(`Market lines to price. Defaults to ${DEFAULT_LINES.join(', ')}.`),
        forceRefresh
      }
    },
    async ({ fixtureId, matchCount, lines, forceRefresh }) =>
      run(`get_corner_baseline(${fixtureId})`, async () => {
        const fixture = await resolveFixture(fixtureId, forceRefresh);

        // Sequential, not parallel: cornerProfile already runs its statistics
        // fetches at a concurrency of 3, and each checks the per-call ceiling
        // against a cache the other is still filling.
        //
        // Each profile enforces the ceiling for its own team, so a baseline is
        // bounded by twice MCP_MAX_REQUESTS_PER_CALL rather than once. That is
        // still a bound, and a combined pre-count would need an extra fixtures
        // request per team to compute.
        const homeProfile = await aggregate.cornerProfile(fixture.homeId, matchCount, forceRefresh);
        const awayProfile = await aggregate.cornerProfile(fixture.awayId, matchCount, forceRefresh);

        const baseline = cornerBaseline(homeProfile, awayProfile, lines || DEFAULT_LINES,
          { currentSeason: fixture.season });

        return {
          fixture,
          ...baseline,
          profiles: {
            home: { matchesAnalyzed: homeProfile.matchesAnalyzed, averages: homeProfile.averages },
            away: { matchesAnalyzed: awayProfile.matchesAnalyzed, averages: awayProfile.averages }
          }
        };
      })
  );
}

module.exports = { register };
