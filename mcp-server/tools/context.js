'use strict';

const { z } = require('zod');
const fixtureBaseline = require('../baselines/fixtureBaseline');
const context = require('../aggregate/context');
const { run } = require('../result');

function register(server) {
  server.registerTool(
    'get_fixture_context',
    {
      title: 'Get the facts about a fixture beyond the two team profiles',
      description: 'The referee and their recent card and foul averages, how many days of rest '
        + 'each side has had and what competition they play next, and what happened when these '
        + 'two last met. Every figure is a fact you can point at and that can be shown to be '
        + 'wrong later — which is what separates it from a hunch. Use it to justify a divergence '
        + 'concretely: "this referee averages 6.1 yellows across 11 matches" is auditable, '
        + '"this feels like a card game" is not. Read `sufficient` on the referee before using '
        + 'the average — early in a season everyone has taken charge of one match, and an '
        + 'average over one match is a number about one match. Nothing here adjusts a '
        + 'probability: no coefficient has been estimated for rest or for a referee, so it '
        + 'reports the facts and leaves the judgment where it belongs.',
      inputSchema: {
        fixtureId: z.number().int().positive().describe('Fixture ID of the upcoming match.'),
        headToHead: z.number().int().min(1).max(20).optional()
          .describe(`Recent meetings to summarise. Defaults to ${context.DEFAULT_H2H}.`),
        forceRefresh: z.boolean().optional()
          .describe('Bypass the cache and refetch. Costs requests against the daily quota.')
      }
    },
    async ({ fixtureId, headToHead, forceRefresh }) =>
      run(`get_fixture_context(${fixtureId})`, async () => {
        const fixture = await fixtureBaseline.resolveFixture(fixtureId, forceRefresh);

        // Sequential for the same reason the baselines are: each of these
        // checks the per-call request ceiling against a cache the others are
        // still filling.
        const referee = await context.refereeProfile(
          fixture.referee, fixture.leagueId, fixture.season, forceRefresh);
        const home = await context.restProfile(fixture.homeId, fixture.kickoff, forceRefresh);
        const away = await context.restProfile(fixture.awayId, fixture.kickoff, forceRefresh);
        const h2h = await context.headToHead(
          fixture.homeId, fixture.awayId, headToHead, forceRefresh);

        return {
          fixture,
          referee,
          rest: { home, away },
          headToHead: h2h,
          caveats: [
            'these are facts, not adjustments: no coefficient has been estimated for what a '
              + 'referee or a short rest does to a scoring rate, so nothing here moves a '
              + 'probability on its own',
            'a referee average describes that referee in this competition, and referees are '
              + 'assigned rather than drawn at random — a card-heavy average may be a card-heavy '
              + 'set of fixtures'
          ]
        };
      })
  );
}

module.exports = { register };
