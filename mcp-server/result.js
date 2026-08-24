'use strict';

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

// A successful request that matched nothing is NOT an error. An agent must be
// able to tell "no corner data for this fixture" from "the request broke".
function empty(reason) {
  return { content: [{ type: 'text', text: JSON.stringify({ empty: true, reason }, null, 2) }] };
}

// Set by server.js at startup, and left null everywhere else: tests and direct
// use of these helpers have no process whose life depends on it.
let touch = null;
function onActivity(fn) { touch = fn; }

// Every tool handler wraps its work in this. Nothing else may throw.
//
// It is also the single point every tool call passes through, which makes it
// the one honest place to say "this server is still being used". A timestamp
// set anywhere else would miss a caller, and a server that undercounts its own
// activity exits in the middle of someone's work.
async function run(label, fn) {
  if (touch) touch();
  try {
    const data = await fn();
    if (data === undefined || data === null) return empty(`${label} returned no data`);
    if (Array.isArray(data) && data.length === 0) return empty(`${label} matched nothing`);
    return ok(data);
  } catch (err) {
    return fail(`${label} failed: ${err && err.message ? err.message : String(err)}`);
  }
}

module.exports = { ok, fail, empty, run, onActivity };
