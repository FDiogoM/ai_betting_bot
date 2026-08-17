'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TTL = {
  PERMANENT: null,          // finished matches: immutable, never expire
  LIVE: 5 * 60 * 1000,      // scheduled/live fixtures
  ODDS: 15 * 60 * 1000,     // odds move continuously pre-match
  TABLE: 6 * 60 * 60 * 1000,        // standings, team season stats
  REFERENCE: 7 * 24 * 60 * 60 * 1000 // leagues, teams, squads
};

function cacheDir() {
  return process.env.MCP_CACHE_DIR || path.join(__dirname, '.cache');
}

function keyFor(endpoint, params) {
  // Sort so param order cannot produce two entries for one logical request.
  // JSON-encode rather than joining `k=v` pairs: joining made {a: "1&b=2"} and
  // {a: 1, b: 2} hash identically, so one request could be served the other's
  // cached data with no way to notice.
  const sorted = Object.keys(params || {}).sort().map((k) => [k, params[k]]);
  return crypto.createHash('sha256')
    .update(JSON.stringify([endpoint, sorted])).digest('hex');
}

function entryPath(endpoint, params) {
  return path.join(cacheDir(), `${keyFor(endpoint, params)}.json`);
}

function read(endpoint, params) {
  const file = entryPath(endpoint, params);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return null; // miss
  }

  let entry;
  try {
    entry = JSON.parse(raw);
  } catch (err) {
    // A corrupt entry is a miss, not a crash.
    try { fs.unlinkSync(file); } catch (ignored) { /* best effort */ }
    return null;
  }

  if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) return null;
  return entry.value;
}

function write(endpoint, params, value, ttlMs) {
  fs.mkdirSync(cacheDir(), { recursive: true });
  const entry = {
    storedAt: Date.now(),
    expiresAt: ttlMs === null || ttlMs === undefined ? null : Date.now() + ttlMs,
    value
  };
  fs.writeFileSync(entryPath(endpoint, params), JSON.stringify(entry), 'utf8');
}

function clear() {
  fs.rmSync(cacheDir(), { recursive: true, force: true });
}

module.exports = { read, write, clear, cacheDir, TTL };
