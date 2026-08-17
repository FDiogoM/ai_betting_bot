'use strict';

const fs = require('fs');
const paths = require('./paths');

// A .env at the repository root, so a fresh machine needs one file edit and no
// shell configuration. Deliberately dependency-free: this runs before anything
// else and a secrets loader is not worth a supply chain.
//
// A value already in the environment wins over the file, so a machine that
// exports API_FOOTBALL_KEY globally needs no .env at all. An EMPTY value does
// not win: .mcp.json expands ${API_FOOTBALL_KEY:-} to an empty string when the
// variable is unset, and that empty string must not mask the file.
function parse(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue; // not an assignment; ignore rather than guess

    const key = trimmed.slice(0, eq).replace(/^export\s+/, '').trim();
    if (!key) continue;

    let value = trimmed.slice(eq + 1).trim();
    // Quotes delimit the value; they are not part of it. An unquoted value
    // keeps whatever it holds, including '#', because an API key may contain one.
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function load(file = paths.ENV_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { file, loaded: false, applied: [] }; // no .env is a valid setup
  }

  const applied = [];
  for (const [key, value] of Object.entries(parse(text))) {
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return { file, loaded: true, applied };
}

module.exports = { load, parse };
