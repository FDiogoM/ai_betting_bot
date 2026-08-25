'use strict';

// The provider enforces TWO limits and this server only ever watched one.
//
//   x-ratelimit-requests-limit / -remaining   7500 per DAY
//   x-ratelimit-limit / -remaining             300 per MINUTE
//
// The daily pair was read from the first commit; the per-minute pair was
// ignored entirely. The bulletin of 2026-08-21 hit the per-minute ceiling three
// times during collection and reported it as a footnote, while get_api_status
// went on saying "6822 remaining" in a reassuring tone. A corner profile runs
// its fetches at a concurrency of 3 and a sweep of forty fixtures fires
// hundreds of statistics requests as fast as the socket allows, so on a cold
// cache the burst is the whole problem.
//
// This is a client-side rolling window rather than a reaction to the server's
// counter, because the header says how many are left but never when the window
// resets. Counting our own requests over the last sixty seconds needs no such
// guess and cannot drift out of step with a clock we do not control.

const WINDOW_MS = 60000;

// Below the provider's own ceiling on purpose. The window is rolling on our
// side and fixed on theirs, so two bursts either side of their boundary can
// both be legal here and add up to more than 300 there. The margin absorbs it.
const DEFAULT_PER_MINUTE = 240;
const OBSERVED_SAFETY = 0.8;

function defaultPerMinute() {
  const raw = Number(process.env.MCP_MAX_REQUESTS_PER_MINUTE);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PER_MINUTE;
}

/**
 * A rolling-window limiter.
 *
 * `now` and `sleep` are injectable so the behaviour can be tested without
 * waiting a real minute — a limiter whose tests take sixty seconds is a
 * limiter nobody runs.
 */
function createLimiter(options = {}) {
  const {
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); })
  } = options;

  let limit = options.perMinute || defaultPerMinute();
  let stamps = [];
  let waits = 0;
  let waitedMs = 0;
  let rejections = 0;

  function prune(at) {
    stamps = stamps.filter((t) => at - t < WINDOW_MS);
  }

  // Waits, if needed, then records the request as spent. Serialised by the
  // caller's await: two concurrent callers each take a turn rather than both
  // reading the same free slot.
  async function acquire() {
    for (;;) {
      const at = now();
      prune(at);
      if (stamps.length < limit) {
        stamps.push(at);
        return { waited: 0 };
      }
      // The oldest request in the window is the one whose expiry frees a slot.
      const wait = WINDOW_MS - (at - stamps[0]) + 1;
      waits += 1;
      waitedMs += wait;
      await sleep(wait);
    }
  }

  // Learns from a response: the ceiling, and how much of it is actually left.
  //
  // The `remaining` half exists because the window above is PER PROCESS and the
  // provider's limit is PER KEY. A dry run on 2026-08-24 hit the ceiling anyway:
  // the MCP server and a script were both spending against the same key, each
  // counting only itself, and neither ever saw a full window. The header is the
  // only figure that accounts for all of them.
  //
  // So a low `remaining` back-fills the local window with phantom stamps until
  // it matches what the provider says is left. The next acquire() then waits on
  // its own arithmetic, and no second mechanism is needed.
  function observe(perMinuteLimit, perMinuteRemaining) {
    if (Number.isFinite(perMinuteLimit) && perMinuteLimit > 0) {
      const target = Math.max(1, Math.floor(perMinuteLimit * OBSERVED_SAFETY));
      if (target !== limit) limit = target;
    }

    if (!Number.isFinite(perMinuteRemaining) || perMinuteRemaining < 0) return;
    const at = now();
    prune(at);
    const shouldBeUsed = Math.max(0, limit - perMinuteRemaining);
    // Only ever tightens. A high `remaining` from a stale response must not
    // hand back slots this process knows it has spent.
    while (stamps.length < shouldBeUsed) stamps.push(at);
  }

  // The provider just said no. Fill the window so the next acquire() waits out
  // the rest of the minute.
  //
  // This exists because the refusal arrives as HTTP 200 with an `errors` field
  // rather than a 429, and that response carries no useful per-minute counter —
  // so `observe` learns nothing from the one message that proves we overran. A
  // sweep on 2026-08-25 paused 43 times, waited 46 of its 69 seconds, and still
  // lost 39 requests, because every rejection taught the limiter nothing and it
  // kept firing into a closed window.
  function exhausted() {
    const at = now();
    prune(at);
    while (stamps.length < limit) stamps.push(at);
    rejections += 1;
  }

  function state() {
    prune(now());
    return {
      limit,
      usedInWindow: stamps.length,
      remainingInWindow: Math.max(0, limit - stamps.length),
      waits,
      waitedMs,
      rejections
    };
  }

  return { acquire, observe, exhausted, state };
}

// One limiter for the process, because the ceiling is per key and every request
// this server makes uses the same one. Tests build their own.
const shared = createLimiter();

module.exports = { createLimiter, shared, WINDOW_MS, DEFAULT_PER_MINUTE, OBSERVED_SAFETY };
