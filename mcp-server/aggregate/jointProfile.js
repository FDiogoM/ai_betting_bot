'use strict';

const cornerAggregate = require('./cornerProfile');
const goalsAggregate = require('./goalsProfile');

// One row per match carrying BOTH totals, for the two teams in a fixture.
//
// This is what makes a same-game multiple pricable from evidence rather than
// from an assumption. Both profiles are drawn from the same `/fixtures?team=X`
// window and the same cached statistics responses, so the join is by fixture id
// and costs nothing beyond arithmetic once either profile has been built.
//
// Matches missing either count are dropped rather than filled: a row with a
// goal total and no corner total says nothing about how the two move together.

function totalsByFixture(cornerMatches, goalsMatches) {
  const corners = new Map(cornerMatches.map((m) => [m.fixtureId, m]));
  const rows = [];
  for (const g of goalsMatches) {
    const c = corners.get(g.fixtureId);
    if (!c) continue;
    rows.push({
      fixtureId: g.fixtureId,
      date: g.date,
      season: g.season,
      totalGoals: g.goalsFor + g.goalsAgainst,
      totalCorners: c.cornersFor + c.cornersAgainst
    });
  }
  return rows;
}

/**
 * The pooled sample behind one fixture: both teams' recent matches, each with a
 * goal total and a corner total.
 *
 * Pools the two teams the way the baselines already do, and double-counts a
 * head-to-head meeting for the same declared reason.
 */
async function jointSample(homeId, awayId, matchCount, forceRefresh) {
  const [homeCorners, awayCorners, homeGoals, awayGoals] = [
    await cornerAggregate.cornerProfile(homeId, matchCount, forceRefresh),
    await cornerAggregate.cornerProfile(awayId, matchCount, forceRefresh),
    await goalsAggregate.goalsProfile(homeId, matchCount, forceRefresh),
    await goalsAggregate.goalsProfile(awayId, matchCount, forceRefresh)
  ];

  const rows = [
    ...totalsByFixture(homeCorners.matches, homeGoals.matches),
    ...totalsByFixture(awayCorners.matches, awayGoals.matches)
  ];

  return {
    matches: rows,
    n: rows.length,
    caveats: [
      'the joint sample pools both teams\' matches, so a head-to-head meeting counts twice',
      'correlation is measured across these teams\' recent matches, not across the league'
    ]
  };
}

module.exports = { jointSample, totalsByFixture };
