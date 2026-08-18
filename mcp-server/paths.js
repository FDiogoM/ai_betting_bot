'use strict';

const path = require('path');

// Every machine-independent path hangs off this one. The server lives at
// <root>/mcp-server, one level below the repository root, and nothing outside
// this file may assume that depth: when the nesting changes, this constant is
// the only edit.
const ROOT = path.join(__dirname, '..');

// The ledger is the record, not a cache: repository root, git-tracked.
const LEDGER = path.join(ROOT, 'ledger');

// Operator-supplied secrets. Never committed; see .env.example.
const ENV_FILE = path.join(ROOT, '.env');

module.exports = { ROOT, LEDGER, ENV_FILE };
