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
