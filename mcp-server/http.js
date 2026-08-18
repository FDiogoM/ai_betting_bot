'use strict';

const axios = require('axios').default;

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
    return new ApiError(`Daily request quota exhausted (${path}). Check get_api_status; the quota resets at midnight UTC.`, { status });
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

async function request(path, params = {}) {
  const key = apiKey();
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

  const problem = describeErrors(res.data && res.data.errors);
  if (problem) {
    throw new ApiError(`Provider rejected the request (${path}): ${problem}`, { path });
  }

  return {
    data: (res.data && res.data.response) || [],
    quota: {
      limit: numericHeader(res.headers, 'x-ratelimit-requests-limit'),
      remaining: numericHeader(res.headers, 'x-ratelimit-requests-remaining')
    }
  };
}

module.exports = { request, ApiError, BASE_URL };
