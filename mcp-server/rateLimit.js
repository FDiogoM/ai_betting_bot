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

  // Learns the real ceiling from a response and tightens to it. The provider
  // knows its own plan better than a default does, and a plan can change under
  // a running process.
  function observe(perMinuteLimit) {
    if (!Number.isFinite(perMinuteLimit) || perMinuteLimit <= 0) return;
    const target = Math.max(1, Math.floor(perMinuteLimit * OBSERVED_SAFETY));
    if (target !== limit) limit = target;
  }

  function state() {
    prune(now());
    return {
      limit,
      usedInWindow: stamps.length,
      remainingInWindow: Math.max(0, limit - stamps.length),
      waits,
      waitedMs
    };
  }

  return { acquire, observe, state };
}

// One limiter for the process, because the ceiling is per key and every request
// this server makes uses the same one. Tests build their own.
const shared = createLimiter();

module.exports = { createLimiter, shared, WINDOW_MS, DEFAULT_PER_MINUTE, OBSERVED_SAFETY };
