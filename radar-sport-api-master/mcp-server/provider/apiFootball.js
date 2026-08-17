'use strict';

const http = require('../http');
const cache = require('../cache');
const quota = require('../quota');

// The only place endpoint paths live. Swapping providers touches this file.
const ENDPOINTS = {
  STATUS: '/status',
  LEAGUES: '/leagues',
  TEAMS: '/teams',
  FIXTURES: '/fixtures',
  HEAD_TO_HEAD: '/fixtures/headtohead',
  FIXTURE_STATISTICS: '/fixtures/statistics',
  STANDINGS: '/standings',
  TEAM_STATISTICS: '/teams/statistics',
  ODDS: '/odds'
};

const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN']);

function isFinished(fixture) {
  const short = fixture && fixture.fixture && fixture.fixture.status
    ? fixture.fixture.status.short
    : null;
  return FINISHED_STATUSES.has(short);
}

// Cache-first, network-second. Every read goes through here.
// `ttl` is either a value (number | null) or a function (data) => number | null,
// so a caller can pick the lifetime from the response — a finished fixture is
// immutable and cached permanently, a scheduled one must expire quickly.
async function fetch(endpoint, params = {}, ttl = cache.TTL.LIVE, forceRefresh = false) {
  if (!forceRefresh) {
    const hit = cache.read(endpoint, params);
    if (hit !== null) return hit;
  }

  const { data, quota: seen } = await http.request(endpoint, params);
  quota.record(seen);
  cache.write(endpoint, params, data, typeof ttl === 'function' ? ttl(data) : ttl);
  return data;
}

// How many of these requests would actually hit the network. A caller that
// budgets requests before spending them needs this, and it must not have to
// know how a cache key is derived — that contract lives here, with fetch.
function countUncached(endpoint, paramsList) {
  return paramsList.filter((params) => cache.read(endpoint, params) === null).length;
}

module.exports = { fetch, isFinished, countUncached, ENDPOINTS };
