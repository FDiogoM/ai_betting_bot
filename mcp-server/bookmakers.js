'use strict';

// Which bookmakers this operator can actually bet with.
//
// The distinction this file exists to enforce: the CONSENSUS should come from
// every book quoting a market, because the market's opinion is best estimated
// from all of it — but the PRICE must come only from a book you hold an account
// with, because that is the one you can take.
//
// Those were the same thing until 2026-08-24, when the best price across all
// books was being recorded as the price taken. Measured on one live fixture,
// across 49 selections, Betano paid on average 10.1% less than the best
// available and was itself the best on 8 of them. In the middle of the curve
// the gap is small — over 2.5 goals came out at 1.1% — and at the edges it is
// not: over 3.5 goals was 4.50 elsewhere and 3.00 at Betano, a third less.
//
// The consequence was not cosmetic. 26 of the 34 recorded predictions carry a
// price from a book the operator cannot use, so their edge was measured against
// money that was never on the table, and a 3.4% edge against a best price is
// negative at a book paying 4% less.
//
// Unset means unrestricted, which is the old behaviour and the right default
// for anyone who really does shop across books. It is reported rather than
// assumed: every prediction records the restriction it was written under, so a
// ledger spanning a change of regime can still be read.

function configured() {
  const raw = process.env.MCP_BOOKMAKERS;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const names = raw.split(',').map((n) => n.trim()).filter(Boolean);
  return names.length ? names : null;
}

// Case-insensitive and whitespace-tolerant, because a feed that writes both
// "Win To Nil" and "Win to Nil - Away" cannot be trusted to be consistent about
// a bookmaker's capitals either.
function normalise(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function isAllowed(name) {
  const allowed = configured();
  if (!allowed) return true;
  const wanted = normalise(name);
  return allowed.some((a) => normalise(a) === wanted);
}

// The quotes this operator can actually take. An empty result is a real answer:
// a selection none of your books price is a selection you cannot back, and that
// was invisible while the best price across the whole market was being used.
function usable(quotes) {
  return (quotes || []).filter((q) => isAllowed(q.bookmaker));
}

// What was in force when a record was written, for the record to carry.
function restriction() {
  const allowed = configured();
  return {
    restrictedTo: allowed,
    note: allowed
      ? `prices taken only from ${allowed.join(', ')}; the consensus still comes from every `
        + 'book quoting the market'
      : 'unrestricted: the best price across all bookmakers was used, which is only correct '
        + 'if an account is held with all of them'
  };
}

module.exports = { configured, isAllowed, usable, restriction, normalise };
