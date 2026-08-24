'use strict';

const fs = require('fs');
const path = require('path');
const { cacheDir } = require('./cache');

const DEFAULT_MAX_REQUESTS_PER_CALL = 25;

function quotaFile() {
  return path.join(cacheDir(), 'quota.json');
}

function read() {
  try {
    return JSON.parse(fs.readFileSync(quotaFile(), 'utf8'));
  } catch (err) {
    return null;
  }
}

// Not every response carries quota headers; a reading without them must not
// erase what we already knew.
function record(quota) {
  if (!quota || quota.remaining === null || quota.remaining === undefined) return;
  fs.mkdirSync(cacheDir(), { recursive: true });
  fs.writeFileSync(
    quotaFile(),
    JSON.stringify({
      limit: quota.limit,
      remaining: quota.remaining,
      // The per-minute pair, kept beside the daily one because they constrain
      // different things: the day says whether there is budget left, the minute
      // says whether the next request may go now. Only the daily pair was ever
      // recorded, which is how a bulletin could be throttled three times while
      // reporting thousands of requests remaining.
      perMinuteLimit: quota.perMinuteLimit === undefined ? null : quota.perMinuteLimit,
      perMinuteRemaining: quota.perMinuteRemaining === undefined ? null : quota.perMinuteRemaining,
      updatedAt: new Date().toISOString()
    }),
    'utf8'
  );
}

function maxRequestsPerCall() {
  const raw = Number(process.env.MCP_MAX_REQUESTS_PER_CALL);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_REQUESTS_PER_CALL;
}

module.exports = { read, record, maxRequestsPerCall };
