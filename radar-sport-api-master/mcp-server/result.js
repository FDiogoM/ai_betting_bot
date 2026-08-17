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

// Every tool handler wraps its work in this. Nothing else may throw.
async function run(label, fn) {
  try {
    const data = await fn();
    if (data === undefined || data === null) return empty(`${label} returned no data`);
    if (Array.isArray(data) && data.length === 0) return empty(`${label} matched nothing`);
    return ok(data);
  } catch (err) {
    return fail(`${label} failed: ${err && err.message ? err.message : String(err)}`);
  }
}

module.exports = { ok, fail, empty, run };
