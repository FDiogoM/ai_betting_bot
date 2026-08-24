'use strict';

const test = require('node:test');
const assert = require('node:assert');

const rateLimit = require('../rateLimit');
const lifecycle = require('../lifecycle');

// A fake clock and a fake sleep, so a limiter with a sixty-second window can be
// tested in microseconds. A test that takes a real minute is a test nobody runs,
// and a limiter nobody tests is a limiter nobody trusts.
function fakeClock(start = 1000000) {
  let at = start;
  const slept = [];
  return {
    now: () => at,
    sleep: async (ms) => { slept.push(ms); at += ms; },
    advance: (ms) => { at += ms; },
    slept
  };
}

test('requests below the ceiling never wait', async () => {
  const clock = fakeClock();
  const limiter = rateLimit.createLimiter({ perMinute: 5, now: clock.now, sleep: clock.sleep });

  for (let i = 0; i < 5; i += 1) await limiter.acquire();

  assert.deepStrictEqual(clock.slept, [], 'nothing should have waited');
  assert.strictEqual(limiter.state().remainingInWindow, 0);
});

test('the request over the ceiling waits for the window to roll', async () => {
  const clock = fakeClock();
  const limiter = rateLimit.createLimiter({ perMinute: 3, now: clock.now, sleep: clock.sleep });

  for (let i = 0; i < 3; i += 1) await limiter.acquire();
  await limiter.acquire();

  assert.strictEqual(clock.slept.length, 1, 'exactly one wait');
  // The oldest request was at t0, so the slot frees just after t0 + 60s.
  assert.strictEqual(clock.slept[0], rateLimit.WINDOW_MS + 1);
  assert.strictEqual(limiter.state().waits, 1);
});

// Rolling, not fixed: a request made 61 seconds ago does not count against the
// next one, however many were made in between.
test('the window rolls rather than resetting', async () => {
  const clock = fakeClock();
  const limiter = rateLimit.createLimiter({ perMinute: 2, now: clock.now, sleep: clock.sleep });

  await limiter.acquire();
  await limiter.acquire();
  assert.strictEqual(limiter.state().usedInWindow, 2);

  clock.advance(rateLimit.WINDOW_MS + 1);

  await limiter.acquire();
  assert.deepStrictEqual(clock.slept, [], 'the old requests have aged out');
  assert.strictEqual(limiter.state().usedInWindow, 1);
});

// The invariant, rather than a count of waits: no sixty-second window may ever
// contain more than the limit. Counting sleeps would be asserting an artefact of
// the fake clock, which advances globally and so makes concurrent waits
// sequential — the property that matters holds either way.
test('no sixty-second window ever exceeds the limit', async () => {
  const clock = fakeClock();
  const limit = 4;
  const limiter = rateLimit.createLimiter({ perMinute: limit, now: clock.now, sleep: clock.sleep });

  const at = [];
  // Thirty callers, as a cold-cache corner sweep at concurrency 3 produces.
  for (let i = 0; i < 30; i += 1) {
    await limiter.acquire();
    at.push(clock.now());
  }

  for (let i = 0; i < at.length; i += 1) {
    const inWindow = at.filter((t) => t >= at[i] && t - at[i] < rateLimit.WINDOW_MS).length;
    assert.ok(inWindow <= limit,
      `${inWindow} requests fell inside one window starting at index ${i}, above ${limit}`);
  }
  assert.ok(limiter.state().waits > 0, 'a burst this size must have been paced');
});

// The provider states its ceiling on every response, and it knows its own plan
// better than a constant written months ago does.
test('the observed ceiling tightens the limit, with a safety margin', async () => {
  const clock = fakeClock();
  const limiter = rateLimit.createLimiter({ perMinute: 1000, now: clock.now, sleep: clock.sleep });

  limiter.observe(300);

  assert.strictEqual(limiter.state().limit, Math.floor(300 * rateLimit.OBSERVED_SAFETY),
    'below the provider ceiling: our window rolls and theirs does not');
});

test('a missing or nonsensical ceiling is ignored rather than obeyed', () => {
  const limiter = rateLimit.createLimiter({ perMinute: 50 });

  limiter.observe(null);
  limiter.observe(0);
  limiter.observe(-5);
  limiter.observe(NaN);

  assert.strictEqual(limiter.state().limit, 50, 'the working limit must survive bad input');
});

test('the default is under the provider ceiling seen in the wild', () => {
  assert.ok(rateLimit.DEFAULT_PER_MINUTE < 300,
    'the observed plan allows 300 a minute and a rolling window needs headroom');
});

// --- lifecycle ---------------------------------------------------------------

function fakeProcess() {
  const handlers = new Map();
  return {
    on(event, fn) { handlers.set(event, fn); },
    fire(event) { const fn = handlers.get(event); if (fn) fn(); },
    has(event) { return handlers.has(event); }
  };
}

function arrange(idleMs = 1000) {
  const exits = [];
  const logs = [];
  let scheduled = null;
  const stdin = fakeProcess();
  const signals = fakeProcess();

  const started = lifecycle.start({
    idleMs,
    stdin,
    signals,
    exit: (code) => exits.push(code),
    log: (m) => logs.push(m),
    setTimer: (fn) => { scheduled = fn; return { unref() {} }; },
    clearTimer: () => { scheduled = null; }
  });

  return { started, exits, logs, stdin, signals, fire: () => scheduled && scheduled() };
}

test('an idle server exits on its own', () => {
  const a = arrange();

  a.fire();

  assert.deepStrictEqual(a.exits, [0], 'it must exit cleanly, not crash');
  assert.match(a.logs[0], /idle for 0 minutes|idle for \d+ minutes/);
  assert.match(a.logs[0], /respawns/, 'the log must say why this is safe');
});

test('activity postpones the exit', () => {
  const a = arrange();

  a.started.touch();
  a.started.touch();

  // The previous timer was cleared each time, so only the latest can fire.
  a.fire();
  assert.deepStrictEqual(a.exits, [0]);
});

test('stdin closing is taken as the client leaving', () => {
  const a = arrange();

  a.stdin.fire('end');

  assert.deepStrictEqual(a.exits, [0]);
  assert.match(a.logs[0], /stdin closed/);
});

test('signals are honoured', () => {
  const a = arrange();

  assert.ok(a.signals.has('SIGTERM') && a.signals.has('SIGINT'));
  a.signals.fire('SIGTERM');
  assert.match(a.logs[0], /SIGTERM/);
});

// Whichever exit fires first wins; the others must not pile on.
test('the server exits once, however many exits fire', () => {
  const a = arrange();

  a.stdin.fire('end');
  a.signals.fire('SIGTERM');
  a.fire();

  assert.strictEqual(a.exits.length, 1, 'exactly one exit');
  assert.strictEqual(a.logs.length, 1);
});

test('an idle timeout of zero disables the exit entirely', () => {
  const a = arrange(0);

  a.started.touch();

  assert.deepStrictEqual(a.exits, [], 'a deliberately long-lived process is allowed');
});

test('the default idle timeout is long enough not to interrupt work', () => {
  assert.ok(lifecycle.DEFAULT_IDLE_MS >= 15 * 60 * 1000,
    'too short and it would exit mid-session');
  assert.ok(lifecycle.DEFAULT_IDLE_MS <= 60 * 60 * 1000,
    'too long and processes accumulate, which is the whole problem');
});

test('the environment can override the idle timeout', () => {
  process.env.MCP_IDLE_TIMEOUT_MS = '5000';
  assert.strictEqual(lifecycle.idleTimeoutMs(), 5000);

  process.env.MCP_IDLE_TIMEOUT_MS = 'nonsense';
  assert.strictEqual(lifecycle.idleTimeoutMs(), lifecycle.DEFAULT_IDLE_MS,
    'bad input must not disable the exit');

  delete process.env.MCP_IDLE_TIMEOUT_MS;
});

// The window above counts one process; the provider counts every process using
// the key. A dry run on 2026-08-24 hit the ceiling with the limiter in place,
// because the MCP server and a script were each counting only themselves. The
// header is the only figure that accounts for both.
test('a low remaining from the provider tightens the local window', async () => {
  const clock = fakeClock();
  const limiter = rateLimit.createLimiter({ perMinute: 10, now: clock.now, sleep: clock.sleep });

  await limiter.acquire();
  assert.strictEqual(limiter.state().remainingInWindow, 9, 'this process has spent one');

  // The provider says only two are left: somebody else spent the rest.
  limiter.observe(null, 2);

  assert.strictEqual(limiter.state().remainingInWindow, 2,
    'the local window must believe the provider over its own count');
});

test('a high remaining never hands back slots this process knows it spent', async () => {
  const clock = fakeClock();
  const limiter = rateLimit.createLimiter({ perMinute: 10, now: clock.now, sleep: clock.sleep });

  for (let i = 0; i < 8; i += 1) await limiter.acquire();
  limiter.observe(null, 9);   // stale response claiming plenty left

  assert.strictEqual(limiter.state().remainingInWindow, 2,
    'observe only ever tightens');
});

test('an exhausted remaining makes the next request wait', async () => {
  const clock = fakeClock();
  const limiter = rateLimit.createLimiter({ perMinute: 10, now: clock.now, sleep: clock.sleep });

  limiter.observe(null, 0);
  await limiter.acquire();

  assert.strictEqual(clock.slept.length, 1, 'it must wait rather than fire into a full window');
});
