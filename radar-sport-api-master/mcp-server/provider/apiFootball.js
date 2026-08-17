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
  TEAM_STATISTICS: '/teams/statistics'
};

const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN']);

function isFinished(fixture) {
  const short = fixture && fixture.fixture && fixture.fixture.status
    ? fixture.fixture.status.short
    : null;
  return FINISHED_STATUSES.has(short);
}

// Cache-first, network-second. Every read goes through here.
async function fetch(endpoint, params = {}, ttl = cache.TTL.LIVE, forceRefresh = false) {
  if (!forceRefresh) {
    const hit = cache.read(endpoint, params);
    if (hit !== null) return hit;
  }

  const { data, quota: seen } = await http.request(endpoint, params);
  quota.record(seen);
  cache.write(endpoint, params, data, ttl);
  return data;
}

module.exports = { fetch, isFinished, ENDPOINTS };
