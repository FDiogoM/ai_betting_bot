'use strict';

// Before anything reads process.env. Nothing below this line may be hoisted
// above it: http.js resolves the API key lazily, but a future eager reader
// would silently see an unloaded environment.
require('./env').load();

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const cache = require('./cache');
const lifecycle = require('./lifecycle');
const result = require('./result');
const reference = require('./tools/reference');
const fixtures = require('./tools/fixtures');
const stats = require('./tools/stats');
const odds = require('./tools/odds');
const baselines = require('./tools/baselines');
const ledger = require('./tools/ledger');
const notify = require('./tools/notify');
const multiples = require('./tools/multiples');
const simulate = require('./tools/simulate');
const fixtureContext = require('./tools/context');

const server = new McpServer({ name: 'football-stats', version: '0.1.0' });

reference.register(server);
fixtures.register(server);
stats.register(server);
odds.register(server);
baselines.register(server);
ledger.register(server);
notify.register(server);
multiples.register(server);
simulate.register(server);
fixtureContext.register(server);

async function main() {
  // stdout is the MCP transport. Diagnostics must go to stderr or they
  // corrupt the protocol stream.
  await server.connect(new StdioServerTransport());
  console.error('football-stats MCP server ready on stdio');

  // After connecting, never before: pruning walks the whole cache directory,
  // and a client waiting on the handshake must not pay for housekeeping.
  // Expired entries are already treated as misses, so this frees disk without
  // changing a single answer.
  // Armed after connecting so a slow start is never counted as idleness.
  const { touch, idleMs } = lifecycle.start();
  result.onActivity(touch);
  if (idleMs) console.error('idle exit after ' + Math.round(idleMs / 60000) + ' minutes without a tool call');

  const pruned = cache.prune();
  if (pruned.removed) {
    console.error(`cache: pruned ${pruned.removed} expired entries `
      + `(${Math.round(pruned.bytesFreed / 1024)} KB), kept ${pruned.kept}`);
  }
}

main().catch((err) => {
  // Never log a raw error object: an AxiosError serializes err.config.headers,
  // which carries x-apisports-key. Message and stack carry no credentials.
  console.error('fatal:', err && err.message ? err.message : String(err));
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
});
