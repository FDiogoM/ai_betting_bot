'use strict';

const { makeStatProfile } = require('./statProfile');

// Yellow cards only, and deliberately.
//
// The feed quotes two card markets. `Cards Over/Under` counts everything, which
// would need yellows AND reds to settle — and reds are recorded on only 25.5%
// of the matches that carry yellows, measured across 1089 cached fixtures. A
// family that cannot be settled reliably is worse than one that does not exist,
// because it settles wrongly rather than not at all.
//
// `Yellow Over/Under` needs one statistic, and that statistic has the best
// coverage of any in the response: 97.1%, ahead of corners at 93.5%. Over the
// same 1089 matches it averages 4.09 a game with a variance of 4.54 — a
// dispersion ratio of 1.11, closer to the Poisson assumption than corners
// manage.
//
// One thing this cannot see: whether a second yellow that became a red is
// counted once or twice by the provider. The statistic is taken as given, which
// is what every other family here does with its own count.

const CARD_TYPE = 'Yellow Cards';

const cards = makeStatProfile({
  statType: CARD_TYPE,
  forKey: 'yellowsFor',
  againstKey: 'yellowsAgainst',
  totalKey: 'totalYellows',
  noun: 'yellow card statistics',
  defaultMatchCount: 10,
  maxMatchCount: 20
});

module.exports = {
  cardProfile: cards.profile,
  cardValue: cards.valueOf,
  CARD_TYPE,
  DEFAULT_MATCH_COUNT: cards.DEFAULT_MATCH_COUNT,
  MAX_MATCH_COUNT: cards.MAX_MATCH_COUNT
};
