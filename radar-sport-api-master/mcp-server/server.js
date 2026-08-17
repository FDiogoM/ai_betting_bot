'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const reference = require('./tools/reference');
const fixtures = require('./tools/fixtures');
const stats = require('./tools/stats');
const odds = require('./tools/odds');

const server = new McpServer({ name: 'football-stats', version: '0.1.0' });

reference.register(server);
fixtures.register(server);
stats.register(server);
odds.register(server);

async function main() {
  // stdout is the MCP transport. Diagnostics must go to stderr or they
  // corrupt the protocol stream.
  await server.connect(new StdioServerTransport());
  console.error('football-stats MCP server ready on stdio');
}

main().catch((err) => {
  // Never log a raw error object: an AxiosError serializes err.config.headers,
  // which carries x-apisports-key. Message and stack carry no credentials.
  console.error('fatal:', err && err.message ? err.message : String(err));
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
});
