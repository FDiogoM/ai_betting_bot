'use strict';

const test = require('node:test');
const assert = require('node:assert');
const nock = require('nock');

const http = require('../http');

const BASE = 'https://v3.football.api-sports.io';

test.beforeEach(() => {
  nock.cleanAll();
  process.env.API_FOOTBALL_KEY = 'test-key-123';
});

test('request sends the api key header and unwraps the response array', async () => {
  const scope = nock(BASE, { reqheaders: { 'x-apisports-key': 'test-key-123' } })
    .get('/status')
    .reply(200, { errors: [], results: 1, response: [{ account: { firstname: 'x' } }] });

  const { data } = await http.request('/status');

  assert.strictEqual(data.length, 1);
  assert.ok(scope.isDone());
});

test('query parameters are passed through', async () => {
  const scope = nock(BASE)
    .get('/fixtures')
    .query({ team: '33', last: '5' })
    .reply(200, { errors: [], response: [] });

  await http.request('/fixtures', { team: 33, last: 5 });

  assert.ok(scope.isDone());
});

test('quota headers are captured', async () => {
  nock(BASE).get('/status').reply(200, { errors: [], response: [] }, {
    'x-ratelimit-requests-limit': '100',
    'x-ratelimit-requests-remaining': '87'
  });

  const { quota } = await http.request('/status');

  assert.strictEqual(quota.limit, 100);
  assert.strictEqual(quota.remaining, 87);
});

test('a remaining quota of zero is reported as 0, not null', async () => {
  nock(BASE).get('/status').reply(200, { errors: [], response: [] }, {
    'x-ratelimit-requests-limit': '100',
    'x-ratelimit-requests-remaining': '0'
  });

  const { quota } = await http.request('/status');

  assert.strictEqual(quota.remaining, 0, 'exhaustion must not be reported as unknown');
});

test('absent quota headers read as null', async () => {
  nock(BASE).get('/status').reply(200, { errors: [], response: [] });

  const { quota } = await http.request('/status');

  assert.strictEqual(quota.limit, null);
  assert.strictEqual(quota.remaining, null);
});

test('a 200 carrying an errors object is treated as failure, not success', async () => {
  nock(BASE).get('/status').reply(200, { errors: { token: 'invalid key' }, response: [] });

  await assert.rejects(
    () => http.request('/status'),
    (err) => err instanceof http.ApiError && /invalid key/.test(err.message)
  );
});

test('an empty errors array is not treated as failure', async () => {
  nock(BASE).get('/status').reply(200, { errors: [], response: [{ ok: true }] });

  const { data } = await http.request('/status');

  assert.strictEqual(data.length, 1);
});

test('HTTP 429 produces a quota-exhaustion message', async () => {
  nock(BASE).get('/status').reply(429, {});

  await assert.rejects(
    () => http.request('/status'),
    (err) => err instanceof http.ApiError && /quota/i.test(err.message)
  );
});

test('HTTP 401 produces an API-key message', async () => {
  nock(BASE).get('/status').reply(401, {});

  await assert.rejects(
    () => http.request('/status'),
    (err) => err instanceof http.ApiError && /api key/i.test(err.message)
  );
});

test('a missing API key fails before any request is made', async () => {
  delete process.env.API_FOOTBALL_KEY;
  const scope = nock(BASE).get('/status').reply(200, { errors: [], response: [] });

  await assert.rejects(
    () => http.request('/status'),
    (err) => /API_FOOTBALL_KEY/.test(err.message)
  );
  assert.ok(!scope.isDone(), 'no request should be issued without a key');
  nock.cleanAll();
});

// Guards the timeout constraint itself: without `timeout: timeoutMs()` on the
// axios call this hangs until nock's delay elapses and then succeeds.
test('a request that outlives MCP_HTTP_TIMEOUT_MS is aborted with a timeout error', async () => {
  process.env.MCP_HTTP_TIMEOUT_MS = '40';
  nock(BASE).get('/status').delayConnection(500)
    .reply(200, { errors: [], response: [] });

  try {
    await assert.rejects(
      () => http.request('/status'),
      (err) => err instanceof http.ApiError && /timed out/i.test(err.message)
    );
  } finally {
    delete process.env.MCP_HTTP_TIMEOUT_MS;
    nock.cleanAll();
  }
});

test('the API key never appears in an error message', async () => {
  nock(BASE).get('/status').reply(500, { message: 'boom' });

  try {
    await http.request('/status');
    assert.fail('expected a rejection');
  } catch (err) {
    assert.ok(!JSON.stringify(err.message).includes('test-key-123'), 'key leaked into error message');
  }
});
