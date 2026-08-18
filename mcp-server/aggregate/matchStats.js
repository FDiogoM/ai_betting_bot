'use strict';

const provider = require('../provider/apiFootball');
const cache = require('../cache');
const quota = require('../quota');

// Per-match statistics, shared by every profile that needs them. This began as
// private machinery inside the corner profile, which was the only caller while
// corners were the only statistic anyone read. Goals now read shots off the
// same response, so the machinery moved here rather than being reached into or
// copied — the same move markets/index.js made when odds parsing went generic.
//
// One /fixtures/statistics response carries eighteen statistics for both teams.
// Reading a second one costs nothing: the request was already made and, for a
// finished match, already cached permanently.

const CONCURRENCY = 3;

function statisticsParams(fixtureId) {
  return { fixture: fixtureId };
}

// Finished-match statistics are immutable, so a caller that has already
// established the match is finished passes TTL.PERMANENT — that is what makes
// repeat analysis nearly free. A caller that has not must not, because an
// unplayed fixture answers with [], and storing that permanently would report
// "empty" forever.
function fetchStatistics(fixtureId, force, ttl) {
  return provider.fetch(provider.ENDPOINTS.FIXTURE_STATISTICS,
    statisticsParams(fixtureId), ttl, force);
}

// Whether a response can be trusted as final, judged from the response itself.
function statisticsTtl(data) {
  return data.length ? cache.TTL.PERMANENT : cache.TTL.LIVE;
}

// One statistic for one team. null means the statistic was not recorded — and
// null is what comes back, never 0. Coercing a missing value to zero would
// corrupt every average computed from it, and for a fill rate below 100% that
// is not a rare path.
function statValue(entries, teamId, type) {
  const forTeam = entries.find((e) => e.team && e.team.id === teamId);
  if (!forTeam || !Array.isArray(forTeam.statistics)) return null;
  const stat = forTeam.statistics.find((s) => s.type === type);
  if (!stat || stat.value === null || stat.value === undefined || stat.value === '') return null;
  const n = Number(stat.value);
  return Number.isFinite(n) ? n : null;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  let doomed = false;
  async function pump() {
    while (cursor < items.length && !doomed) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index], index);
      } catch (err) {
        // Promise.all rejects on the first failure, so the call is already
        // lost. Without this the surviving workers keep draining the cursor
        // and spending quota on a call that has returned an error.
        doomed = true;
        throw err;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, pump));
  return results;
}

// Refuses before spending rather than after. Counts only what would actually
// hit the network: a warm cache is free, which is why a second profile over the
// same matches costs nothing.
function assertWithinCeiling(fixtureIds, forceRefresh) {
  const ceiling = quota.maxRequestsPerCall();
  const needed = forceRefresh
    ? fixtureIds.length
    : provider.countUncached(provider.ENDPOINTS.FIXTURE_STATISTICS,
      fixtureIds.map(statisticsParams));
  if (needed > ceiling) {
    throw new Error(`would need ${needed} requests, above the `
      + `per-call ceiling of ${ceiling}. Lower matchCount, or raise MCP_MAX_REQUESTS_PER_CALL.`);
  }
  return needed;
}

module.exports = {
  statisticsParams,
  fetchStatistics,
  statisticsTtl,
  statValue,
  mapWithConcurrency,
  assertWithinCeiling,
  CONCURRENCY
};
