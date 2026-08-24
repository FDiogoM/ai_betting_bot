'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const version = require('../version');

// Nothing here writes into the real source tree. The test runner runs files in
// parallel, so a temporary module dropped beside the real ones would make every
// concurrent version.status() call read stale and fail tests in other files at
// random. The first draft of this file did exactly that, and the suite went
// from 216 passing to 214 on roughly one run in three.
function tempTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-version-'));
  fs.mkdirSync(path.join(root, 'markets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server.js'), '// entry point\n', 'utf8');
  fs.writeFileSync(path.join(root, 'markets', 'index.js'), '// a family registry\n', 'utf8');
  return root;
}

test('the fingerprint covers the modules the server actually loads', () => {
  const files = version.sourceFiles().map((f) => path.basename(f));

  assert.ok(files.includes('server.js'), 'the entry point must be covered');
  assert.ok(files.includes('scoring.js'), 'a module three directories deep must be covered');
  assert.ok(files.includes('staking.js'));
  // Tests are never required at runtime, so a change to one says nothing about
  // what this process is running.
  assert.ok(!files.some((f) => f.endsWith('.test.js')), 'tests must not be fingerprinted');
});

test('the fingerprint is stable when nothing changes', () => {
  assert.strictEqual(version.fingerprint(), version.fingerprint());
});

test('a changed source file changes the fingerprint', () => {
  const root = tempTree();
  try {
    const before = version.fingerprint(root);

    const added = path.join(root, 'markets', 'cards.js');
    fs.writeFileSync(added, '// a new market family\n', 'utf8');
    const afterAdd = version.fingerprint(root);

    fs.writeFileSync(added, '// the same family, priced differently\n', 'utf8');
    const afterEdit = version.fingerprint(root);

    fs.unlinkSync(added);

    assert.notStrictEqual(afterAdd, before, 'adding a module must change the fingerprint');
    assert.notStrictEqual(afterEdit, afterAdd, 'editing one must change it again');
    assert.strictEqual(version.fingerprint(root), before, 'and removing it must restore it');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the fingerprint follows content, not modification time', () => {
  const root = tempTree();
  try {
    const before = version.fingerprint(root);
    const file = path.join(root, 'server.js');
    const contents = fs.readFileSync(file);

    // Rewritten identically: a file touched but unchanged is the same server.
    fs.writeFileSync(file, contents);

    assert.strictEqual(version.fingerprint(root), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The verdict is pure, so the wording and the comparison are testable without a
// real process and without a single file being written.
test('a disk that has moved past the loaded code reads as stale', () => {
  const stale = version.describeStaleness('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb');

  assert.strictEqual(stale.stale, true);
  assert.match(stale.note, /STALE/);
  assert.match(stale.note, /[Rr]estart/, 'the note must name the only fix there is');
});

test('a matching fingerprint reads as current', () => {
  const same = version.describeStaleness('aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa');

  assert.strictEqual(same.stale, false);
  assert.match(same.note, /matches the source on disk/);
});

test('status carries what is needed to identify the running process', () => {
  const s = version.status();

  assert.strictEqual(s.version, '0.1.0');
  assert.match(s.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Number.isFinite(s.uptimeSeconds) && s.uptimeSeconds >= 0);
  // The loaded fingerprint describes THIS process and nothing on disk may edit
  // that claim; the disk one is read fresh on every call.
  assert.strictEqual(s.loadedFingerprint, version.LOADED);
  assert.strictEqual(s.diskFingerprint, version.fingerprint());
  assert.strictEqual(s.stale, false, 'a suite run against an unmodified tree is never stale');
});
