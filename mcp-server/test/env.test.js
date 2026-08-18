'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const env = require('../env');
const paths = require('../paths');

function writeEnv(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

test('a key and value survive the round trip', () => {
  const values = env.parse('API_FOOTBALL_KEY=abc123\n');
  assert.strictEqual(values.API_FOOTBALL_KEY, 'abc123');
});

test('blank lines and comments are not variables', () => {
  const values = env.parse('# a comment\n\n  \nA=1\n');
  assert.deepStrictEqual(Object.keys(values), ['A']);
});

test('quotes delimit a value rather than belonging to it', () => {
  assert.strictEqual(env.parse('A="x y"\n').A, 'x y');
  assert.strictEqual(env.parse("A='x y'\n").A, 'x y');
});

test('an unquoted hash stays in the value', () => {
  // An API key may contain one, and dropping it would produce a key that is
  // wrong in a way no error message explains.
  assert.strictEqual(env.parse('A=se#cret\n').A, 'se#cret');
});

test('a shell-style export prefix is tolerated', () => {
  assert.strictEqual(env.parse('export A=1\n').A, '1');
});

test('a value containing = keeps everything after the first one', () => {
  assert.strictEqual(env.parse('A=b=c\n').A, 'b=c');
});

test('loading applies the file to the environment', () => {
  const file = writeEnv('MCP_ENV_TEST_FRESH=fromfile\n');
  delete process.env.MCP_ENV_TEST_FRESH;

  const result = env.load(file);

  assert.strictEqual(process.env.MCP_ENV_TEST_FRESH, 'fromfile');
  assert.ok(result.loaded);
  assert.ok(result.applied.includes('MCP_ENV_TEST_FRESH'));
  delete process.env.MCP_ENV_TEST_FRESH;
});

test('an existing environment value beats the file', () => {
  const file = writeEnv('MCP_ENV_TEST_SET=fromfile\n');
  process.env.MCP_ENV_TEST_SET = 'fromenv';

  env.load(file);

  assert.strictEqual(process.env.MCP_ENV_TEST_SET, 'fromenv');
  delete process.env.MCP_ENV_TEST_SET;
});

test('an empty environment value does not beat the file', () => {
  // .mcp.json expands ${API_FOOTBALL_KEY:-} to '' when the variable is unset.
  // Treating that as "already set" would mask the .env and leave the operator
  // staring at a key-not-set error with a filled-in .env in front of them.
  const file = writeEnv('MCP_ENV_TEST_EMPTY=fromfile\n');
  process.env.MCP_ENV_TEST_EMPTY = '';

  env.load(file);

  assert.strictEqual(process.env.MCP_ENV_TEST_EMPTY, 'fromfile');
  delete process.env.MCP_ENV_TEST_EMPTY;
});

test('a missing .env is a valid setup, not a failure', () => {
  const result = env.load(path.join(os.tmpdir(), 'mcp-env-does-not-exist', '.env'));

  assert.strictEqual(result.loaded, false);
  assert.deepStrictEqual(result.applied, []);
});

test('the ledger resolves to the repository root, beside .mcp.json', () => {
  // The whole point of paths.js: a wrong depth here writes the record into the
  // nested library folder, where the git-tracked ledger/ is not.
  assert.strictEqual(path.basename(paths.LEDGER), 'ledger');
  assert.ok(fs.existsSync(path.join(paths.ROOT, '.mcp.json')),
    `expected .mcp.json at the resolved root ${paths.ROOT}`);
});
