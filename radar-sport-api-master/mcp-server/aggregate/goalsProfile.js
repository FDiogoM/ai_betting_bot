'use strict';

const provider = require('../provider/apiFootball');
const cache = require('../cache');

const DEFAULT_MATCH_COUNT = 10;
const MAX_MATCH_COUNT = 20;

// Goals arrive on the fixture itself, so unlike the corner profile this needs
// no per-match statistics call and no quota ceiling check: the whole profile is
// one request per team. That is why a goals baseline costs roughly a twentieth
// of a corner one.

// null means the score was not recorded. Coercing it to 0 would invent a
// goalless draw and corrupt every average computed from it.
function goalsOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function goalsProfile(teamId, matchCount, forceRefresh) {
  // Same key and TTL as get_team_fixtures({team, last}): a sliding window.
  const fixtures = await provider.fetch(provider.ENDPOINTS.FIXTURES,
    { team: teamId, last: matchCount }, cache.TTL.LIVE, forceRefresh);

  const finished = fixtures.filter(provider.isFinished);
  if (!finished.length) {
    return { teamId, matchesAnalyzed: 0, matches: [], failures: [],
      note: 'No finished matches found for this team.' };
  }

  const matches = [];
  const failures = [];

  // isFinished only validates fixture.status.short, so a fixture can pass it
  // and still be missing `teams` or `goals`. One unexpected shape costs one
  // match, never the call.
  finished.forEach((fixture, index) => {
    let id = null;
    try {
      id = fixture.fixture.id;
      const isHome = fixture.teams.home.id === teamId;
      const opponent = isHome ? fixture.teams.away : fixture.teams.home;

      const home = goalsOf(fixture.goals ? fixture.goals.home : null);
      const away = goalsOf(fixture.goals ? fixture.goals.away : null);
      if (home === null || away === null) {
        failures.push({ fixtureId: id, reason: 'no score recorded for this match' });
        return;
      }

      matches.push({
        fixtureId: id,
        date: fixture.fixture.date,
        // The window is the last N matches, not the last N of this season, so
        // the baseline needs each match's season to report how much of the
        // sample predates the fixture being priced.
        season: fixture.league ? fixture.league.season : null,
        opponent: opponent.name,
        venue: isHome ? 'home' : 'away',
        goalsFor: isHome ? home : away,
        goalsAgainst: isHome ? away : home
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
    goalsFor: acc.goalsFor + m.goalsFor,
    goalsAgainst: acc.goalsAgainst + m.goalsAgainst
  }), { goalsFor: 0, goalsAgainst: 0 });

  const round = (n) => Math.round(n * 100) / 100;

  return {
    teamId,
    matchesAnalyzed: matches.length,
    matches,
    totals,
    averages: matches.length ? {
      goalsFor: round(totals.goalsFor / matches.length),
      goalsAgainst: round(totals.goalsAgainst / matches.length),
      totalGoals: round((totals.goalsFor + totals.goalsAgainst) / matches.length)
    } : null,
    failures
  };
}

module.exports = { goalsProfile, goalsOf, DEFAULT_MATCH_COUNT, MAX_MATCH_COUNT };
