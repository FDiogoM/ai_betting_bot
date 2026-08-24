'use strict';

// A stdio MCP server is supposed to die when its client goes away. In practice
// it does not always notice: the client holds the pipe open, `end` never fires,
// and the process sits there until the machine reboots.
//
// Six of them were found alive on 2026-08-24, accumulating at about two a day
// since the 18th. That is not a memory problem — six small node processes cost
// nothing. It is a correctness problem: each one serves the code it loaded when
// it started, and the oldest answered the bulletin of 2026-08-21 with three-day-
// old code, which is how that run lost `judgment` and `marketConsensus` without
// anything erroring.
//
// So the server takes responsibility for its own exit. Three ways out:
//
//   1. stdin closes — the client really did go away
//   2. a signal — someone asked
//   3. idleness — nobody has called a tool in a long time
//
// The third is the one that actually works, because it needs nothing from the
// client. An MCP client respawns a stdio server on demand, so exiting when idle
// costs a cold start on the next call and nothing else.

const DEFAULT_IDLE_MS = 30 * 60 * 1000;

function idleTimeoutMs() {
  const raw = Number(process.env.MCP_IDLE_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  // An explicit zero disables it, for a process someone is deliberately keeping
  // alive. Anything else, including nonsense, gets the default.
  if (raw === 0) return 0;
  return DEFAULT_IDLE_MS;
}

/**
 * Arms the exits. Returns `touch`, to be called whenever the server does
 * something on behalf of a client — that is what "idle" is measured against.
 *
 * `exit` and the timer functions are injectable so the behaviour can be tested
 * without killing the test runner or waiting half an hour.
 */
function start(options = {}) {
  const {
    idleMs = idleTimeoutMs(),
    exit = (code) => process.exit(code),
    log = (message) => console.error(message),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    stdin = process.stdin,
    signals = process
  } = options;

  let timer = null;
  let stopped = false;

  function leave(reason, code = 0) {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimer(timer);
    log(`football-stats MCP server exiting: ${reason}`);
    exit(code);
  }

  function touch() {
    if (stopped || !idleMs) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      leave(`idle for ${Math.round(idleMs / 60000)} minutes. An MCP client respawns this `
        + 'server on demand, so nothing is lost by not lingering');
    }, idleMs);
    // A pending exit timer must not itself keep the process alive.
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  // The client closing the pipe is the clean signal, when it arrives.
  if (stdin && typeof stdin.on === 'function') {
    stdin.on('end', () => leave('stdin closed'));
    stdin.on('close', () => leave('stdin closed'));
  }

  if (signals && typeof signals.on === 'function') {
    signals.on('SIGTERM', () => leave('received SIGTERM'));
    signals.on('SIGINT', () => leave('received SIGINT'));
  }

  touch();

  return { touch, leave, idleMs };
}

module.exports = { start, idleTimeoutMs, DEFAULT_IDLE_MS };
