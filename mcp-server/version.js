'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// An MCP server over stdio is a long-lived process. It loads its code once, at
// startup, and nothing afterwards makes it notice that the files on disk have
// moved on — so a process launched before an edit keeps serving the old
// behaviour indefinitely, silently, while the repository says otherwise.
//
// That is not hypothetical. On 2026-08-21 the daily bulletin reported that
// get_ledger_summary had returned neither `marketConsensus` nor `judgment`.
// Both had been on disk for three days. Six server processes were alive, the
// oldest started half an hour before the edit that added them, and the run had
// been answered by one of those. The only reason it surfaced at all is that the
// procedure said to report what the tool actually returned rather than what it
// was expected to return.
//
// So the server fingerprints its own source at startup and can re-fingerprint
// on demand. A difference between the two is proof — not a guess — that this
// process is stale.

const SOURCE_DIRS = ['', 'aggregate', 'baselines', 'ledger', 'markets', 'provider', 'tools'];

// Every .js file the server actually loads. Tests are excluded: they are never
// required at runtime, so a change to one says nothing about this process.
// `root` exists for the tests. They must never mutate the real source tree to
// exercise this: the test runner runs files in parallel, and a temporary module
// dropped beside the real ones makes every concurrent status() call read stale.
// That flakiness is not hypothetical — it is what the first version of these
// tests did.
function sourceFiles(root = __dirname) {
  const files = [];
  for (const dir of SOURCE_DIRS) {
    const full = path.join(root, dir);
    let entries;
    try {
      entries = fs.readdirSync(full);
    } catch (err) {
      continue; // a directory that does not exist contributes nothing
    }
    for (const name of entries) {
      if (!name.endsWith('.js')) continue;
      const file = path.join(full, name);
      // Sub-entries of the root read are directories or dotfiles; skip anything
      // that is not a plain file so `smoke.js` counts and `.cache` does not.
      try {
        if (!fs.statSync(file).isFile()) continue;
      } catch (err) {
        continue;
      }
      files.push(file);
    }
  }
  // Sorted so the hash depends on content, never on directory-listing order.
  return files.sort();
}

// Content-addressed, not mtime-based: a file touched but unchanged is not a
// different server, and a file changed inside the same second is.
function fingerprint(root = __dirname) {
  const hash = crypto.createHash('sha256');
  for (const file of sourceFiles(root)) {
    hash.update(path.relative(root, file).replace(/\\/g, '/'));
    try {
      hash.update(fs.readFileSync(file));
    } catch (err) {
      hash.update('<unreadable>');
    }
  }
  return hash.digest('hex').slice(0, 16);
}

// Frozen at require time, which is startup: this is what the running process
// actually loaded.
const LOADED = fingerprint();
const STARTED_AT = new Date().toISOString();

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
  } catch (err) {
    return null;
  }
}

/**
 * The verdict, separated from the reading that produces it.
 *
 * Pure, so the wording and the comparison can be tested without a real process
 * and without touching a file. The fix is always the same — restart the server
 * — and the note says so, because the failure mode is a reader who sees an
 * unfamiliar field missing and concludes the feature was never built.
 */
function describeStaleness(loaded, onDisk) {
  const stale = onDisk !== loaded;
  return {
    stale,
    note: stale
      ? 'STALE: the source on disk has changed since this process started, so the tools you are '
        + 'calling are running older code than the repository contains. Restart the MCP server '
        + 'before trusting any tool surface or output shape. Nothing else clears this.'
      : 'the running code matches the source on disk'
  };
}

// What this process is, and whether it still matches the disk.
function status() {
  const onDisk = fingerprint();
  return {
    version: packageVersion(),
    startedAt: STARTED_AT,
    uptimeSeconds: Math.round(process.uptime()),
    loadedFingerprint: LOADED,
    diskFingerprint: onDisk,
    ...describeStaleness(LOADED, onDisk)
  };
}

module.exports = {
  status, describeStaleness, fingerprint, sourceFiles, LOADED, STARTED_AT
};
