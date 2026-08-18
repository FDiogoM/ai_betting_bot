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
  // One clock reading for both fields: two calls can straddle a millisecond,
  // which makes the stored window ttlMs + drift rather than exactly ttlMs.
  const now = Date.now();
  const entry = {
    storedAt: now,
    expiresAt: ttlMs === null || ttlMs === undefined ? null : now + ttlMs,
    value
  };
  fs.writeFileSync(entryPath(endpoint, params), JSON.stringify(entry), 'utf8');
}

function clear() {
  fs.rmSync(cacheDir(), { recursive: true, force: true });
}

// Deletes entries that have expired. `read` treats an expired entry as a miss
// but leaves the file behind, so without this the directory only ever grows:
// every odds response is a 15-minute entry, and a daily bulletin sweeping
// dozens of fixtures writes hundreds of them that are dead by lunchtime.
//
// Permanent entries — finished-match statistics — are deliberately kept. They
// are immutable and they are what makes repeat analysis nearly free; they are
// the cache's value, not its bloat. Corrupt entries go, for the same reason
// `read` drops them: they can never be served.
//
// Never throws. A cache that cannot be tidied is not a reason to fail a run.
function prune() {
  const dir = cacheDir();
  const result = { scanned: 0, removed: 0, kept: 0, bytesFreed: 0 };

  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'quota.json');
  } catch (err) {
    return result; // no cache directory yet
  }

  const now = Date.now();
  for (const name of files) {
    const file = path.join(dir, name);
    result.scanned += 1;
    try {
      const stat = fs.statSync(file);
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (entry.expiresAt === null || entry.expiresAt > now) {
        result.kept += 1;
        continue;
      }
      fs.unlinkSync(file);
      result.removed += 1;
      result.bytesFreed += stat.size;
    } catch (err) {
      // Unreadable or unparseable: it can never be served, so it is dead
      // weight. Failing to remove it is not worth reporting either.
      try {
        const stat = fs.statSync(file);
        fs.unlinkSync(file);
        result.removed += 1;
        result.bytesFreed += stat.size;
      } catch (ignored) { /* best effort */ }
    }
  }

  return result;
}

module.exports = { read, write, clear, prune, cacheDir, TTL };
