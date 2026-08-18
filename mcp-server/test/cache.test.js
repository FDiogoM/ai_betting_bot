'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cache = require('../cache');
const quota = require('../quota');

test.beforeEach(() => {
  process.env.MCP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cache-'));
});

test.afterEach(() => {
  fs.rmSync(process.env.MCP_CACHE_DIR, { recursive: true, force: true });
});

test('a written value reads back', () => {
  cache.write('/fixtures', { id: 1 }, { hello: 'world' }, cache.TTL.PERMANENT);

  assert.deepStrictEqual(cache.read('/fixtures', { id: 1 }), { hello: 'world' });
});

test('different params are different cache entries', () => {
  cache.write('/fixtures', { id: 1 }, 'one', cache.TTL.PERMANENT);
  cache.write('/fixtures', { id: 2 }, 'two', cache.TTL.PERMANENT);

  assert.strictEqual(cache.read('/fixtures', { id: 1 }), 'one');
  assert.strictEqual(cache.read('/fixtures', { id: 2 }), 'two');
});

test('param order does not change the cache key', () => {
  cache.write('/fixtures', { a: 1, b: 2 }, 'value', cache.TTL.PERMANENT);

  assert.strictEqual(cache.read('/fixtures', { b: 2, a: 1 }), 'value');
});

// Joining raw `k=v` pairs made these two param sets hash identically, so one
// would silently be served the other's cached data.
test('a param value containing the key separator cannot collide with other params', () => {
  cache.write('/fixtures', { a: '1&b=2' }, 'ambiguous', cache.TTL.PERMANENT);

  assert.strictEqual(cache.read('/fixtures', { a: 1, b: 2 }), null,
    'distinct param sets must never share a cache key');
});

// Two Date.now() readings could straddle a millisecond, making the stored
// window ttlMs + drift and any `window <= TTL` assertion intermittent.
test('the stored window is exactly the requested TTL', () => {
  cache.write('/fixtures', { id: 1 }, 'value', cache.TTL.LIVE);

  const names = fs.readdirSync(process.env.MCP_CACHE_DIR)
    .filter((f) => /^[0-9a-f]{64}\.json$/.test(f));
  assert.strictEqual(names.length, 1);
  const entry = JSON.parse(fs.readFileSync(path.join(process.env.MCP_CACHE_DIR, names[0]), 'utf8'));
  assert.strictEqual(entry.expiresAt - entry.storedAt, cache.TTL.LIVE);
});

test('a miss returns null', () => {
  assert.strictEqual(cache.read('/fixtures', { id: 99 }), null);
});

test('an expired entry reads as a miss', () => {
  cache.write('/fixtures', { id: 1 }, 'stale', 1);

  const until = Date.now() + 25;
  while (Date.now() < until) { /* let the 1ms TTL lapse */ }

  assert.strictEqual(cache.read('/fixtures', { id: 1 }), null);
});

test('a permanent entry does not expire', () => {
  cache.write('/fixtures', { id: 1 }, 'forever', cache.TTL.PERMANENT);

  assert.strictEqual(cache.read('/fixtures', { id: 1 }), 'forever');
});

test('prune removes expired entries and keeps permanent ones', () => {
  cache.write('/odds', { fixture: 1 }, 'stale', 1);
  cache.write('/odds', { fixture: 2 }, 'stale too', 1);
  cache.write('/fixtures/statistics', { fixture: 3 }, 'immutable', cache.TTL.PERMANENT);
  cache.write('/fixtures', { id: 4 }, 'fresh', cache.TTL.TABLE);

  const until = Date.now() + 25;
  while (Date.now() < until) { /* let the 1ms TTLs lapse */ }

  const result = cache.prune();

  assert.strictEqual(result.removed, 2);
  assert.strictEqual(result.kept, 2);
  assert.ok(result.bytesFreed > 0, 'freed bytes must be reported');
  // The survivors are still readable: pruning frees disk, it does not change
  // a single answer.
  assert.strictEqual(cache.read('/fixtures/statistics', { fixture: 3 }), 'immutable');
  assert.strictEqual(cache.read('/fixtures', { id: 4 }), 'fresh');
});

test('prune removes a corrupt entry, which can never be served anyway', () => {
  cache.write('/fixtures', { id: 1 }, 'good', cache.TTL.PERMANENT);
  fs.writeFileSync(path.join(cache.cacheDir(), 'broken.json'), '{not json', 'utf8');

  const result = cache.prune();

  assert.strictEqual(result.removed, 1);
  assert.strictEqual(result.kept, 1);
  assert.strictEqual(cache.read('/fixtures', { id: 1 }), 'good');
});

test('prune leaves the quota file alone', () => {
  quota.record({ limit: 100, remaining: 42 });

  cache.prune();

  assert.strictEqual(quota.read().remaining, 42);
});

test('prune on a missing cache directory is not an error', () => {
  cache.clear();

  assert.deepStrictEqual(cache.prune(), { scanned: 0, removed: 0, kept: 0, bytesFreed: 0 });
});

test('quota is recorded and read back', () => {
  quota.record({ limit: 100, remaining: 42 });

  const stored = quota.read();
  assert.strictEqual(stored.limit, 100);
  assert.strictEqual(stored.remaining, 42);
  assert.ok(stored.updatedAt);
});

test('a null quota reading does not overwrite a known value', () => {
  quota.record({ limit: 100, remaining: 42 });
  quota.record({ limit: null, remaining: null });

  assert.strictEqual(quota.read().remaining, 42);
});

test('the per-call request ceiling defaults to 25 and honours the env override', () => {
  assert.strictEqual(quota.maxRequestsPerCall(), 25);

  process.env.MCP_MAX_REQUESTS_PER_CALL = '5';
  assert.strictEqual(quota.maxRequestsPerCall(), 5);
  delete process.env.MCP_MAX_REQUESTS_PER_CALL;
});
