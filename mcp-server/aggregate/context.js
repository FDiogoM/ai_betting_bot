'use strict';

const provider = require('../provider/apiFootball');
const cache = require('../cache');
const matchStats = require('./matchStats');

// What is true about a fixture beyond the two team profiles: who is refereeing
// it, how rested each side is, and what happened when these two last met.
//
// This exists because of an argument worth recording. The daily procedure said
// "never invent an input the tools did not give you", and used as its examples
// "this is a derby", "the favourite will rest players for Europe" and "this
// referee cards heavily". Two of those three are not inventions at all: the
// referee's name arrives on every fixture response and had simply never been
// read, and the fixture list gives every team's next match and its competition.
// The rule was partly covering for tools that were never built.
//
// So the distinction that matters is not "did a tool give it to you" but CAN
// YOU POINT AT IT. A referee with a measured card average is a fact that can be
// recorded and later shown to be wrong. "They seem motivated" cannot. This
// module turns the first kind into numbers; the second kind stays forbidden,
// and for a better reason than before.
//
// Everything here reports its own thinness. A referee one match into a season
// is not a referee profile, and saying so is the whole point.

const MIN_REFEREE_MATCHES = 5;
const DEFAULT_H2H = 6;

function round(n, places = 2) {
  return typeof n === 'number' ? Math.round(n * 10 ** places) / 10 ** places : n;
}

function daysBetween(a, b) {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Number.isFinite(ms) ? round(ms / 86400000, 1) : null;
}

/**
 * How much rest each side has had, and what is waiting for them.
 *
 * The days SINCE come free: the team profiles already fetched this window, so
 * the last match is in cache. The days UNTIL cost one request per team, and buy
 * the thing the old rule called an invention — "they play in Europe on
 * Wednesday" is a date and a competition name, not a guess about a manager.
 *
 * It stops at the fact. Nothing here claims a tired team scores less; that is a
 * coefficient nobody has estimated, and asserting it would be exactly the sort
 * of unfalsifiable adjustment this module exists to replace.
 */
async function restProfile(teamId, kickoff, forceRefresh) {
  const [previous, upcoming] = [
    await provider.fetch(provider.ENDPOINTS.FIXTURES,
      { team: teamId, last: 1 }, cache.TTL.LIVE, forceRefresh),
    await provider.fetch(provider.ENDPOINTS.FIXTURES,
      { team: teamId, next: 3 }, cache.TTL.LIVE, forceRefresh)
  ];

  const last = previous.length ? previous[0] : null;
  // The fixture being priced is itself in the "next" list; what matters is what
  // comes AFTER it.
  const after = upcoming
    .filter((f) => new Date(f.fixture.date).getTime() > new Date(kickoff).getTime())
    .sort((a, b) => String(a.fixture.date).localeCompare(String(b.fixture.date)));

  return {
    teamId,
    daysSinceLast: last ? daysBetween(last.fixture.date, kickoff) : null,
    lastCompetition: last && last.league ? last.league.name : null,
    daysUntilNext: after.length ? daysBetween(kickoff, after[0].fixture.date) : null,
    nextCompetition: after.length && after[0].league ? after[0].league.name : null,
    upcoming: after.slice(0, 2).map((f) => ({
      date: f.fixture.date,
      competition: f.league ? f.league.name : null,
      opponent: f.teams.home.id === teamId ? f.teams.away.name : f.teams.home.name
    }))
  };
}

/**
 * A referee's recent record in the competition, from the statistics of the
 * matches they took charge of.
 *
 * The provider has no way to query fixtures by referee — `/fixtures?referee=`
 * answers "The Referee field do not exist" — so the league's season is fetched
 * whole, which is one request and cacheable, and filtered by name. Statistics
 * for the matches found are shared with every other profile over the same
 * fixtures, so a referee who has taken charge of teams already analysed costs
 * almost nothing.
 *
 * `sufficient` is false far more often than not, especially early in a season
 * when everyone has one match. That is reported rather than smoothed over: a
 * referee average across two games is a number about two games.
 */
async function refereeProfile(referee, leagueId, season, forceRefresh) {
  if (!referee) {
    return { referee: null, matches: 0, sufficient: false,
      note: 'this fixture has no referee assigned yet' };
  }

  const fixtures = await provider.fetch(provider.ENDPOINTS.FIXTURES,
    { league: leagueId, season }, cache.TTL.TABLE, forceRefresh);

  const theirs = fixtures.filter((f) => f.fixture.referee === referee && provider.isFinished(f));
  if (!theirs.length) {
    return { referee, matches: 0, sufficient: false,
      note: `no finished match in this competition has ${referee} as referee yet` };
  }

  matchStats.assertWithinCeiling(theirs.map((f) => f.fixture.id), forceRefresh);

  const rows = [];
  const failures = [];
  await matchStats.mapWithConcurrency(theirs, matchStats.CONCURRENCY, async (f) => {
    let entries;
    try {
      entries = await matchStats.fetchStatistics(f.fixture.id, forceRefresh, cache.TTL.PERMANENT);
    } catch (err) {
      failures.push({ fixtureId: f.fixture.id, reason: err.message });
      return;
    }
    const read = (type) => {
      const home = matchStats.statValue(entries, f.teams.home.id, type);
      const away = matchStats.statValue(entries, f.teams.away.id, type);
      return home === null || away === null ? null : home + away;
    };
    rows.push({
      fixtureId: f.fixture.id,
      date: f.fixture.date,
      yellows: read('Yellow Cards'),
      fouls: read('Fouls'),
      corners: read('Corner Kicks')
    });
  });

  const mean = (key) => {
    const values = rows.map((r) => r[key]).filter((v) => v !== null);
    return values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null;
  };

  const sufficient = rows.length >= MIN_REFEREE_MATCHES;
  return {
    referee,
    matches: rows.length,
    averages: { yellows: mean('yellows'), fouls: mean('fouls'), corners: mean('corners') },
    sufficient,
    note: sufficient
      ? `${rows.length} finished matches in this competition`
      : `only ${rows.length} finished match(es) under this referee, below the `
        + `${MIN_REFEREE_MATCHES} an average needs: report it, do not price on it`,
    failures
  };
}

/**
 * What actually happened when these two last met.
 *
 * The endpoint has been available since the first commit and the daily
 * procedure never called it. It is where a rivalry shows itself in numbers —
 * more cards, more fouls — without anyone having to assert that a fixture is a
 * derby.
 */
async function headToHead(homeId, awayId, limit, forceRefresh) {
  const meetings = await provider.fetch(provider.ENDPOINTS.HEAD_TO_HEAD,
    { h2h: `${homeId}-${awayId}` }, cache.TTL.TABLE, forceRefresh);

  const finished = meetings.filter(provider.isFinished).slice(0, limit || DEFAULT_H2H);
  if (!finished.length) {
    return { meetings: 0, note: 'these two have no finished meeting on record' };
  }

  matchStats.assertWithinCeiling(finished.map((f) => f.fixture.id), forceRefresh);

  const rows = [];
  await matchStats.mapWithConcurrency(finished, matchStats.CONCURRENCY, async (f) => {
    let entries = null;
    try {
      entries = await matchStats.fetchStatistics(f.fixture.id, forceRefresh, cache.TTL.PERMANENT);
    } catch (err) {
      entries = null;   // the goals below survive without statistics
    }
    const read = (type) => {
      if (!entries) return null;
      const home = matchStats.statValue(entries, f.teams.home.id, type);
      const away = matchStats.statValue(entries, f.teams.away.id, type);
      return home === null || away === null ? null : home + away;
    };
    rows.push({
      fixtureId: f.fixture.id,
      date: f.fixture.date,
      competition: f.league ? f.league.name : null,
      score: `${f.goals.home}-${f.goals.away}`,
      goals: f.goals.home === null || f.goals.away === null ? null : f.goals.home + f.goals.away,
      yellows: read('Yellow Cards'),
      corners: read('Corner Kicks')
    });
  });

  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const mean = (key) => {
    const values = rows.map((r) => r[key]).filter((v) => v !== null);
    return values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null;
  };

  return {
    meetings: rows.length,
    averages: { goals: mean('goals'), yellows: mean('yellows'), corners: mean('corners') },
    matches: rows,
    note: 'a head-to-head is a small sample of matches that may be years apart, under different '
      + 'squads and managers. It describes a rivalry, not a forecast'
  };
}

module.exports = {
  restProfile, refereeProfile, headToHead, daysBetween,
  MIN_REFEREE_MATCHES, DEFAULT_H2H
};
