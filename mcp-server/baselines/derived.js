'use strict';

// Pure: no imports beyond the Poisson, no clock, no filesystem.
//
// The goals baseline already produces the only two numbers most football
// markets need: an expected scoring rate for each side. Everything below is
// derived from that pair by summing the score matrix — no new request, no new
// statistic, no new model. 1X2, double chance, both teams to score, team
// totals, correct score and odd/even are all views of the same distribution the
// totals market was already being priced from.
//
// THE ASSUMPTION, stated once and inherited everywhere below: the two teams'
// scores are treated as independent Poissons. Real football scores are mildly
// dependent — draws happen a little more often than that implies, and low
// scores cluster — which is what the Dixon-Coles correction exists to fix. It
// is not applied here. The effect is small in the middle of the distribution
// and largest exactly where these markets are thinnest: 0-0, 1-1, and the draw.
// Anything priced off `draw` or a low correct score should be read with that in
// mind, and the caveat travels with the result rather than living only here.

const poisson = require('./poisson');

// Beyond this many goals the probability mass left is negligible and the matrix
// stops paying for itself. At a lambda of 4 the tail past 10 is under 0.03%.
const MAX_GOALS = 10;

function round(n, places = 4) {
  return typeof n === 'number' ? Math.round(n * 10 ** places) / 10 ** places : n;
}

function assertLambda(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite number >= 0, got ${value}`);
  }
}

/**
 * The score matrix: probability of every scoreline up to MAX_GOALS each way.
 *
 * Everything else in this module is a sum over a subset of these cells, which
 * is why they are computed once and shared rather than re-derived per market.
 */
function scoreMatrix(lambdaHome, lambdaAway) {
  assertLambda(lambdaHome, 'lambdaHome');
  assertLambda(lambdaAway, 'lambdaAway');

  const home = [];
  const away = [];
  for (let k = 0; k <= MAX_GOALS; k += 1) {
    home.push(poisson.pmf(lambdaHome, k));
    away.push(poisson.pmf(lambdaAway, k));
  }

  const cells = [];
  let total = 0;
  for (let h = 0; h <= MAX_GOALS; h += 1) {
    for (let a = 0; a <= MAX_GOALS; a += 1) {
      const p = home[h] * away[a];
      cells.push({ home: h, away: a, probability: p });
      total += p;
    }
  }
  // The truncated tail is redistributed proportionally so the matrix sums to 1.
  // Without it every market below would be quietly short by the tail mass, and
  // an over/under pair would not add up to one.
  return { cells: cells.map((c) => ({ ...c, probability: c.probability / total })), truncatedMass: 1 - total };
}

function sum(cells, predicate) {
  return cells.reduce((acc, c) => (predicate(c) ? acc + c.probability : acc), 0);
}

const CAVEAT = 'derived from two independent Poissons, so draws and low scores are slightly '
  + 'understated: no Dixon-Coles correction is applied';

/**
 * Every market that falls out of the pair, priced together.
 *
 * Returned as one object rather than a market at a time because they share the
 * matrix, and because a reader comparing 1X2 against over/under against BTTS is
 * checking the same distribution for consistency.
 */
function derivedMarkets(lambdaHome, lambdaAway, options = {}) {
  const { correctScoreLimit = 4 } = options;
  const { cells, truncatedMass } = scoreMatrix(lambdaHome, lambdaAway);

  const homeWin = sum(cells, (c) => c.home > c.away);
  const draw = sum(cells, (c) => c.home === c.away);
  const awayWin = sum(cells, (c) => c.away > c.home);

  const bttsYes = sum(cells, (c) => c.home > 0 && c.away > 0);

  const correctScore = cells
    .filter((c) => c.home <= correctScoreLimit && c.away <= correctScoreLimit)
    .map((c) => ({ score: `${c.home}-${c.away}`, probability: round(c.probability) }))
    .sort((a, b) => b.probability - a.probability);

  const teamTotal = (side, line) => ({
    line,
    over: round(sum(cells, (c) => c[side] > line)),
    under: round(sum(cells, (c) => c[side] < line))
  });

  return {
    lambda: { home: round(lambdaHome, 3), away: round(lambdaAway, 3),
      total: round(lambdaHome + lambdaAway, 3) },
    matchResult: {
      home: round(homeWin),
      draw: round(draw),
      away: round(awayWin)
    },
    doubleChance: {
      homeOrDraw: round(homeWin + draw),
      awayOrDraw: round(awayWin + draw),
      homeOrAway: round(homeWin + awayWin)
    },
    bothTeamsToScore: { yes: round(bttsYes), no: round(1 - bttsYes) },
    cleanSheet: {
      home: round(sum(cells, (c) => c.away === 0)),
      away: round(sum(cells, (c) => c.home === 0))
    },
    winToNil: {
      home: round(sum(cells, (c) => c.home > c.away && c.away === 0)),
      away: round(sum(cells, (c) => c.away > c.home && c.home === 0))
    },
    oddEven: {
      odd: round(sum(cells, (c) => (c.home + c.away) % 2 === 1)),
      even: round(sum(cells, (c) => (c.home + c.away) % 2 === 0))
    },
    teamTotals: {
      home: [0.5, 1.5, 2.5].map((l) => teamTotal('home', l)),
      away: [0.5, 1.5, 2.5].map((l) => teamTotal('away', l))
    },
    correctScore,
    truncatedMass: round(truncatedMass, 8),
    caveats: [CAVEAT,
      `the score matrix is truncated at ${MAX_GOALS} goals a side and renormalised; `
      + `${round(truncatedMass * 100, 4)}% of the mass was redistributed`]
  };
}

module.exports = { derivedMarkets, scoreMatrix, MAX_GOALS, CAVEAT };
