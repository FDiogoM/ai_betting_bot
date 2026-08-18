'use strict';

const { z } = require('zod');
const provider = require('../provider/apiFootball');
const cache = require('../cache');
const aggregate = require('../aggregate/cornerProfile');
const goalsAggregate = require('../aggregate/goalsProfile');
const { cornerBaseline, DEFAULT_LINES } = require('../baselines/corners');
const { goalsBaseline } = require('../baselines/goals');
const devig = require('../baselines/devig');
const { parseQuotes } = require('../aggregate/marketOdds');
const markets = require('../markets');
const { evaluate } = require('../baselines/value');
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

// Per line: every bookmaker's de-vigged view, the median of those views, and
// the best price on each side. `consensus` is null when the line is quoted on
// one side only — de-vigging needs both, and inventing the other side would
// manufacture a probability nobody quoted.
function summariseLine(quote) {
  const perBook = new Map();
  for (const side of ['over', 'under']) {
    for (const q of quote[side]) {
      if (!perBook.has(q.bookmaker)) perBook.set(q.bookmaker, { bookmaker: q.bookmaker });
      perBook.get(q.bookmaker)[side] = q.odd;
    }
  }

  const bookmakers = [];
  const fairOvers = [];
  const overrounds = [];
  for (const book of perBook.values()) {
    if (book.over === undefined || book.under === undefined) {
      bookmakers.push({ ...book, fairOverProbability: null });
      continue;
    }
    const [fairOver] = devig.fairProbabilities([book.over, book.under]);
    fairOvers.push(fairOver);
    overrounds.push(devig.overround([book.over, book.under]));
    bookmakers.push({ ...book, fairOverProbability: Math.round(fairOver * 1e4) / 1e4 });
  }

  const round = (n) => Math.round(n * 1e4) / 1e4;

  return {
    line: quote.line,
    bookmakers,
    consensus: fairOvers.length ? {
      overProbability: round(devig.median(fairOvers)),
      underProbability: round(1 - devig.median(fairOvers))
    } : null,
    overround: overrounds.length ? round(devig.median(overrounds)) : null,
    bestPrice: {
      over: quote.over.length ? devig.bestPrice(quote.over) : null,
      under: quote.under.length ? devig.bestPrice(quote.under) : null
    }
  };
}

// Both baselines are the same tool with a different count behind them: resolve
// the fixture, profile each team, run the Poisson, report the profiles beside
// it. Writing it once means a family cannot drift into a subtly different
// contract, and the differences that are real — where the count comes from,
// what it costs, which lines are standard — stay declared rather than implied.
function registerBaselineTool(server, spec) {
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: {
        fixtureId: z.number().int().positive().describe('Fixture ID of the upcoming match.'),
        matchCount: z.number().int().min(1).max(spec.maxMatchCount)
          .default(spec.defaultMatchCount)
          .describe(`Recent finished matches per team (default ${spec.defaultMatchCount}, `
            + `max ${spec.maxMatchCount}).`),
        lines: z.array(z.number()).optional()
          .describe(`Market lines to price. Defaults to ${spec.defaultLines.join(', ')}.`),
        forceRefresh
      }
    },
    async ({ fixtureId, matchCount, lines, forceRefresh }) =>
      run(`${spec.name}(${fixtureId})`, async () => {
        const fixture = await resolveFixture(fixtureId, forceRefresh);

        // Sequential, not parallel: a statistics-backed profile already runs
        // its fetches at a concurrency of 3, and each checks the per-call
        // ceiling against a cache the other is still filling.
        //
        // Each profile enforces the ceiling for its own team, so a baseline is
        // bounded by twice MCP_MAX_REQUESTS_PER_CALL rather than once. That is
        // still a bound, and a combined pre-count would need an extra fixtures
        // request per team to compute.
        const homeProfile = await spec.profile(fixture.homeId, matchCount, forceRefresh);
        const awayProfile = await spec.profile(fixture.awayId, matchCount, forceRefresh);

        const baseline = spec.compute(homeProfile, awayProfile, lines || spec.defaultLines,
          { currentSeason: fixture.season });

        return {
          fixture,
          market: spec.family,
          ...baseline,
          profiles: {
            home: { matchesAnalyzed: homeProfile.matchesAnalyzed, averages: homeProfile.averages },
            away: { matchesAnalyzed: awayProfile.matchesAnalyzed, averages: awayProfile.averages }
          }
        };
      })
  );
}

function register(server) {
  registerBaselineTool(server, {
    name: 'get_corner_baseline',
    family: 'corners',
    title: 'Get the corner baseline for a fixture',
    description: 'A deterministic corner baseline for one upcoming fixture. Blends each team\'s '
      + 'corners-for with the opponent\'s corners-against, split by venue, into a Poisson '
      + 'expectation, and prices every standard line. Returns the empirical rate beside each '
      + 'parametric probability and declares its own simplifications in `caveats` — read them, '
      + 'especially `sampleSeasons` early in a season when recent matches may predate it. '
      + 'This is arithmetic, not a recommendation: it has no view on whether the price is worth '
      + 'taking.',
    profile: aggregate.cornerProfile,
    compute: cornerBaseline,
    defaultLines: DEFAULT_LINES,
    defaultMatchCount: aggregate.DEFAULT_MATCH_COUNT,
    maxMatchCount: aggregate.MAX_MATCH_COUNT
  });

  registerBaselineTool(server, {
    name: 'get_goals_baseline',
    family: 'goals',
    title: 'Get the total-goals baseline for a fixture',
    description: 'A deterministic total-goals baseline for one upcoming fixture. The rate is '
      + 'estimated from SHOTS ON TARGET × a pooled conversion, not from goals scored: goals are '
      + 'the noisy outcome, shots the repeatable process, and over a short window a shots-based '
      + 'rate rests on several times as many events. Check `signal` — it reads "shots", or '
      + '"goals" when coverage was too thin and the older, noisier model was used instead. '
      + '`comparison` carries what the goals-based model would have said, so you can see what '
      + 'changed. The empirical rate and dispersion are always computed from real goals, so they '
      + 'remain an independent check on the model. Costs one request per match per team like the '
      + 'corner baseline, but usually spends nothing extra: the corner profile has already '
      + 'fetched those same statistics and finished matches are cached permanently. '
      + 'Arithmetic, not a recommendation.',
    profile: goalsAggregate.goalsProfile,
    compute: goalsBaseline,
    defaultLines: markets.get('goals').defaultLines,
    defaultMatchCount: goalsAggregate.DEFAULT_MATCH_COUNT,
    maxMatchCount: goalsAggregate.MAX_MATCH_COUNT
  });

  server.registerTool(
    'get_market_probabilities',
    {
      title: 'Get the market\'s implied probabilities for a total',
      description: 'Converts a fixture\'s odds on one market family into probabilities with the '
        + 'bookmaker margin removed, per bookmaker and as a consensus median, plus the best '
        + 'available price on each side. The consensus is the market\'s opinion — compare your own '
        + 'probability against it. The best price is what determines whether value exists. Only '
        + 'the full-match total is read: per-team, first-half and handicap variants of the same '
        + 'family are deliberately excluded, because they are different bets.',
      inputSchema: {
        fixtureId: z.number().int().positive().describe('Fixture ID of the upcoming match.'),
        market: z.enum(markets.FAMILY_NAMES).default('corners')
          .describe(`Market family: ${markets.FAMILY_NAMES.join(' or ')}.`),
        forceRefresh
      }
    },
    async ({ fixtureId, market, forceRefresh }) => {
      // The schema's default only applies to calls that go through it. A direct
      // caller — a test, or another tool — gets the same corner default here
      // rather than an "unknown market family undefined".
      const family = market || 'corners';
      return run(`get_market_probabilities(${fixtureId}, ${family})`, async () => {
        const odds = await provider.fetch(provider.ENDPOINTS.ODDS,
          { fixture: fixtureId }, cache.TTL.ODDS, forceRefresh);

        const quotes = parseQuotes(family, odds);
        if (!quotes.length) return null; // run() reports this as an explicit empty result

        return { fixtureId, market: family, lines: quotes.map(summariseLine) };
      });
    }
  );

  server.registerTool(
    'evaluate_bet',
    {
      title: 'Evaluate a bet\'s edge and expected value',
      description: 'Pure arithmetic on a probability and a price: implied probability, edge over '
        + 'it, and expected value per unit staked. Use this rather than computing it yourself — '
        + 'a sign error here corrupts the prediction record. It does not decide stake size.',
      inputSchema: {
        probability: z.number().gt(0).lt(1).describe('Your probability for the selection.'),
        decimalOdd: z.number().gt(1).describe('The decimal price available.'),
        stakeUnits: z.number().gt(0).max(1).default(1)
          .describe('Stake in units of the configured bankroll fraction. Never above 1.')
      }
    },
    async ({ probability, decimalOdd, stakeUnits }) =>
      run('evaluate_bet', async () => evaluate(probability, decimalOdd, stakeUnits))
  );
}

module.exports = { register };
