'use strict';

const fs = require('fs');
const path = require('path');

// The ledger is the record, not a cache: it lives outside .cache/, is
// git-tracked, and is never cleared.
function ledgerDir() {
  return process.env.MCP_LEDGER_DIR || path.join(__dirname, '..', '..', 'ledger');
}

function monthOf(record) {
  const stamp = record.recordedAt || record.settledAt;
  if (typeof stamp !== 'string' || !/^\d{4}-\d{2}/.test(stamp)) {
    throw new Error('a ledger record needs an ISO recordedAt or settledAt to file it under');
  }
  return stamp.slice(0, 7);
}

// Append-only. Nothing here ever rewrites a line: grading appends a settlement
// that references a prediction, so a retouched history would be visible.
function append(record) {
  const dir = ledgerDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${monthOf(record)}.jsonl`),
    `${JSON.stringify(record)}\n`, 'utf8');
}

function readAll() {
  const dir = ledgerDir();
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  } catch (err) {
    return []; // no ledger yet is not an error
  }

  const records = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch (err) {
        // A truncated final line from a crashed write must not make the rest
        // of the history unreadable.
      }
    }
  }
  return records;
}

module.exports = { append, readAll, ledgerDir };
