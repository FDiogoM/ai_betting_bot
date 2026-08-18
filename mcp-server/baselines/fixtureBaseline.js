'use strict';

const provider = require('../provider/apiFootball');
const cache = require('../cache');
const cornerAggregate = require('../aggregate/cornerProfile');
const goalsAggregate = require('../aggregate/goalsProfile');
const { cornerBaseline } = require('./corners');
const { goalsBaseline } = require('./goals');
const markets = require('../markets');

// Computing a baseline for a fixture, in one place. This used to live inside
// the get_*_baseline handlers, which meant record_prediction could not do it
// and had to be handed the numbers by whoever called it — a transcription, and
// therefore something nobody could check. The ledger now derives its own copy
// from here, so what is recorded is what the arithmetic produced.

const SPECS = {
  corners: {
    family: 'corners',
    profile: cornerAggregate.cornerProfile,
    compute: cornerBaseline,
    defaultMatchCount: cornerAggregate.DEFAULT_MATCH_COUNT,
    maxMatchCount: cornerAggregate.MAX_MATCH_COUNT
  },
  goals: {
    family: 'goals',
    profile: goalsAggregate.goalsProfile,
    compute: goalsBaseline,
    defaultMatchCount: goalsAggregate.DEFAULT_MATCH_COUNT,
    maxMatchCount: goalsAggregate.MAX_MATCH_COUNT
  }
};

function spec(family) {
  const found = SPECS[family];
  if (!found) throw new Error(`no baseline is built for market family "${family}"`);
  return { ...found, defaultLines: markets.get(family).defaultLines };
}

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
    // flows straight into the baseline's currentSeason, and an unknown season
    // must read as unknown, not as a fabricated "this season".
    season: f.league ? f.league.season : undefined,
    home: f.teams.home.name,
    homeId: f.teams.home.id,
    away: f.teams.away.name,
    awayId: f.teams.away.id
  };
}

/**
 * The full baseline for one fixture and one market family.
 *
 * Warm-cache cheap by construction: every read goes through the provider cache,
 * so a second call for the same fixture — the one record_prediction makes to
 * check what it is being asked to record — costs nothing beyond the arithmetic.
 */
async function baselineFor(family, fixtureId, matchCount, lines, forceRefresh) {
  const s = spec(family);
  const fixture = await resolveFixture(fixtureId, forceRefresh);

  // Sequential, not parallel: a statistics-backed profile already runs its
  // fetches at a concurrency of 3, and each checks the per-call ceiling
  // against a cache the other is still filling.
  const homeProfile = await s.profile(fixture.homeId, matchCount || s.defaultMatchCount, forceRefresh);
  const awayProfile = await s.profile(fixture.awayId, matchCount || s.defaultMatchCount, forceRefresh);

  const baseline = s.compute(homeProfile, awayProfile, lines || s.defaultLines,
    { currentSeason: fixture.season });

  return {
    fixture,
    market: family,
    ...baseline,
    profiles: {
      home: { matchesAnalyzed: homeProfile.matchesAnalyzed, averages: homeProfile.averages },
      away: { matchesAnalyzed: awayProfile.matchesAnalyzed, averages: awayProfile.averages }
    }
  };
}

// The priced line, or a clear error naming what was available. A selection the
// baseline never priced cannot be recorded against it.
function lineOf(baseline, line) {
  const found = baseline.lines.find((l) => l.line === line);
  if (!found) {
    throw new Error(`the ${baseline.market} baseline does not price line ${line}; `
      + `it priced ${baseline.lines.map((l) => l.line).join(', ')}`);
  }
  return found;
}

// The probability of one side of one line.
function probabilityOf(baseline, line, selection) {
  const priced = lineOf(baseline, line);
  return selection === 'over' ? priced.overProbability : priced.underProbability;
}

module.exports = { baselineFor, resolveFixture, lineOf, probabilityOf, spec, SPECS };
