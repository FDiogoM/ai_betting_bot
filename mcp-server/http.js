'use strict';

const axios = require('axios').default;
const rateLimit = require('./rateLimit');

const BASE_URL = 'https://v3.football.api-sports.io';
const DEFAULT_TIMEOUT_MS = 10000;

class ApiError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ApiError';
    this.details = details || {};
  }
}

function timeoutMs() {
  const raw = Number(process.env.MCP_HTTP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function apiKey() {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) {
    throw new ApiError('API_FOOTBALL_KEY is not set. Export your API-Football key before starting the server.');
  }
  return key;
}

// API-Football signals auth and plan problems with HTTP 200 plus a populated
// `errors` field, which may be an object or an array. A 200 is not success.
function describeErrors(errors) {
  if (!errors) return null;
  if (Array.isArray(errors)) return errors.length ? errors.join('; ') : null;
  if (typeof errors === 'object') {
    const entries = Object.entries(errors);
    return entries.length ? entries.map(([k, v]) => `${k}: ${v}`).join('; ') : null;
  }
  return String(errors);
}

// `Number(x) || null` would turn a genuine remaining-quota of 0 into null,
// hiding exactly the exhaustion the caller needs to see.
function numericHeader(headers, name) {
  const raw = headers[name];
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function classify(err, path) {
  if (err instanceof ApiError) return err;

  const status = err && err.response ? err.response.status : null;
  if (status === 429) {
    // The provider returns 429 for BOTH ceilings and the body distinguishes
    // them. Saying "daily quota exhausted" to a per-minute throttle sends the
    // reader to the wrong number — a dry run on 2026-08-24 hit this with 7000
    // requests still available that day.
    const body = err.response && err.response.data ? JSON.stringify(err.response.data) : '';
    if (/per minute|rateLimit/i.test(body)) {
      return new ApiError(`Rate limited per MINUTE (${path}), not out of daily budget. `
        + 'This resets within the minute. If it repeats, another process is spending against the '
        + 'same key: the pace limiter counts one process and the provider counts them all.',
      { status, perMinute: true });
    }
    return new ApiError(`Daily request quota exhausted (${path}). Check get_api_status; `
      + 'the quota resets at midnight UTC.', { status });
  }
  if (status === 401 || status === 403) {
    return new ApiError(`API key rejected (${path}). Verify API_FOOTBALL_KEY is valid and your plan covers this endpoint.`, { status });
  }
  if (status >= 500) {
    return new ApiError(`Provider unavailable, HTTP ${status} (${path}).`, { status });
  }
  if (status) {
    return new ApiError(`Request failed with HTTP ${status} (${path}).`, { status });
  }
  if (err && err.code === 'ECONNABORTED') {
    return new ApiError(`Request timed out after ${timeoutMs()}ms (${path}).`);
  }
  // err.message is provider/network text; the key lives only in the header,
  // which is never serialized here.
  return new ApiError(`Request failed (${path}): ${err && err.message ? err.message : String(err)}`);
}

// The provider refuses an over-pace request with HTTP 200 and a populated
// `errors` field rather than a 429, so reading the body is the only way to
// recognise it. classify() above handles the 429 form; this handles the one the
// provider actually uses.
function isPaceRejection(problem) {
  // Deliberately broad. The provider has more than one wording for this — a
  // burst on 2026-08-25 produced six refusals whose text began "require", which
  // matched none of the patterns then in use, so the limiter learned nothing and
  // all six were lost. Matching a refusal that turns out to be something else
  // costs one wasted minute; missing one costs the request.
  return typeof problem === 'string'
    && /rate\s*limit|per minute|too many requests|requests? (?:limit|per)/i.test(problem);
}

async function request(path, params = {}, attempt = 0) {
  const key = apiKey();
  // Waits here rather than failing later: the per-minute ceiling is a pace
  // limit, not a budget, so the right response to hitting it is to slow down.
  await rateLimit.shared.acquire();

  let res;
  try {
    res = await axios.get(`${BASE_URL}${path}`, {
      params,
      timeout: timeoutMs(),
      headers: { 'x-apisports-key': key }
    });
  } catch (err) {
    throw classify(err, path);
  }

  // The provider states its own per-minute ceiling on every response. Trusting
  // it beats trusting a default that was right when it was written.
  rateLimit.shared.observe(
    numericHeader(res.headers, 'x-ratelimit-limit'),
    numericHeader(res.headers, 'x-ratelimit-remaining'));

  const problem = describeErrors(res.data && res.data.errors);
  if (problem) {
    // A pace refusal is not a failure, it is a request that arrived too early.
    //
    // Telling the limiter matters more than the retry: this response is the
    // only proof the window was closed, and its headers carry no counter that
    // would have said so. Without it the limiter kept believing it had room —
    // a sweep on 2026-08-25 paused 43 times, waited 46 of its 69 seconds, and
    // still lost 39 requests to a window it never learned was shut.
    //
    // Once only. A second refusal after waiting out a full minute is a real
    // problem — another process on the same key, or a lower ceiling than the
    // headers claim — and should surface rather than spin.
    if (isPaceRejection(problem) && attempt < 1) {
      rateLimit.shared.exhausted();
      return request(path, params, attempt + 1);
    }
    throw new ApiError(`Provider rejected the request (${path}): ${problem}`, { path });
  }

  return {
    data: (res.data && res.data.response) || [],
    quota: {
      limit: numericHeader(res.headers, 'x-ratelimit-requests-limit'),
      remaining: numericHeader(res.headers, 'x-ratelimit-requests-remaining'),
      // The pair that was being thrown away. Reported separately because they
      // answer a different question: the daily figures say whether there is
      // budget left, these say whether the next request may go now.
      perMinuteLimit: numericHeader(res.headers, 'x-ratelimit-limit'),
      perMinuteRemaining: numericHeader(res.headers, 'x-ratelimit-remaining')
    }
  };
}

module.exports = { request, ApiError, BASE_URL };
