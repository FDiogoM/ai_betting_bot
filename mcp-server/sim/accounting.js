'use strict';

// Pure: no imports, no clock, no filesystem.
//
// A paper bankroll over the recorded history, organised the way money actually
// behaves: by month, by day, with what is still at risk kept separate from what
// has resolved.
//
// WHEN A BET HITS THE BALANCE. `returnUnits` in this ledger is the NET result —
// a win records the profit, a loss records minus the stake, a void records
// zero. So the balance moves once, at SETTLEMENT, by exactly that figure. The
// stake is never taken out and put back.
//
// That leaves open bets invisible to the balance, which is why exposure is
// tracked beside it. A month showing +4 units with 9 units riding on unsettled
// matches is not a month that made 4 units, and a single number cannot say so.

function round(n, places = 3) {
  return typeof n === 'number' ? Math.round(n * 10 ** places) / 10 ** places : n;
}

function dayOf(stamp) {
  return typeof stamp === 'string' ? stamp.slice(0, 10) : null;
}

function monthOf(stamp) {
  return typeof stamp === 'string' ? stamp.slice(0, 7) : null;
}

/**
 * Every day on which something happened, in order.
 *
 * Built from the union of placement days and settlement days rather than from a
 * calendar: a day with no activity has nothing to report, and inventing empty
 * rows between them would pad the curve with flat stretches that never existed.
 */
function activeDays(predictions, settlements) {
  const days = new Set();
  for (const p of predictions) if (dayOf(p.recordedAt)) days.add(dayOf(p.recordedAt));
  for (const s of settlements) if (dayOf(s.settledAt)) days.add(dayOf(s.settledAt));
  return [...days].sort();
}

/**
 * The full ledger of a paper bankroll: one row per active day, plus a summary
 * per month.
 *
 * `openingBalance` is the starting bankroll in units. One unit is whatever
 * config.stakeFraction says it is; nothing here needs to know.
 */
function account(predictions, settlements, options = {}) {
  const { openingBalance = 100 } = options;

  const byId = new Map(predictions.map((p) => [p.id, p]));
  const placedOn = new Map();
  const settledOn = new Map();

  for (const p of predictions) {
    const day = dayOf(p.recordedAt);
    if (!day) continue;
    if (!placedOn.has(day)) placedOn.set(day, []);
    placedOn.get(day).push(p);
  }
  for (const s of settlements) {
    const day = dayOf(s.settledAt);
    if (!day) continue;
    if (!settledOn.has(day)) settledOn.set(day, []);
    settledOn.get(day).push(s);
  }

  let balance = openingBalance;
  let exposure = 0;
  let peak = openingBalance;
  let maxDrawdown = 0;

  const days = [];
  for (const day of activeDays(predictions, settlements)) {
    const placed = placedOn.get(day) || [];
    const settled = settledOn.get(day) || [];

    const stakedToday = placed.reduce((acc, p) => acc + p.agent.stake, 0);
    // Stakes leaving exposure are those of the bets that settled today, whoever
    // placed them and whenever — a bet opened three days ago closes here.
    const releasedToday = settled.reduce((acc, s) => {
      const p = byId.get(s.predictionId);
      return acc + (p ? p.agent.stake : 0);
    }, 0);
    const resultToday = settled.reduce(
      (acc, s) => acc + (typeof s.returnUnits === 'number' ? s.returnUnits : 0), 0);

    const opening = balance;
    balance += resultToday;
    exposure += stakedToday - releasedToday;
    peak = Math.max(peak, balance);
    maxDrawdown = Math.max(maxDrawdown, peak - balance);

    const won = settled.filter((s) => s.outcome === 'win').length;
    const lost = settled.filter((s) => s.outcome === 'loss').length;
    const voided = settled.filter((s) => s.outcome === 'void').length;

    days.push({
      date: day,
      month: monthOf(day),
      openingBalance: round(opening),
      betsOpened: placed.length,
      stakedOpened: round(stakedToday),
      betsClosed: settled.length,
      won,
      lost,
      voided,
      resultUnits: round(resultToday),
      closingBalance: round(balance),
      // What is still riding after today's close: the stakes of every bet
      // placed and not yet settled.
      openExposure: round(exposure),
      openBets: round(exposure) === 0 ? 0 : placed.length - settled.length + 0
    });
  }

  // Recompute open bet counts properly: a running count is the only honest way,
  // since a bet placed on one day settles on another.
  let running = 0;
  for (const row of days) {
    running += row.betsOpened - row.betsClosed;
    row.openBets = running;
  }

  const months = [];
  for (const month of [...new Set(days.map((d) => d.month))].sort()) {
    const rows = days.filter((d) => d.month === month);
    const first = rows[0];
    const last = rows[rows.length - 1];
    months.push({
      month,
      openingBalance: first.openingBalance,
      closingBalance: last.closingBalance,
      resultUnits: round(last.closingBalance - first.openingBalance),
      betsOpened: rows.reduce((a, r) => a + r.betsOpened, 0),
      betsClosed: rows.reduce((a, r) => a + r.betsClosed, 0),
      staked: round(rows.reduce((a, r) => a + r.stakedOpened, 0)),
      won: rows.reduce((a, r) => a + r.won, 0),
      lost: rows.reduce((a, r) => a + r.lost, 0),
      voided: rows.reduce((a, r) => a + r.voided, 0),
      openAtClose: last.openBets,
      exposureAtClose: last.openExposure,
      activeDays: rows.length
    });
  }

  const open = predictions.filter((p) => !settlements.some((s) => s.predictionId === p.id));

  return {
    openingBalance,
    closingBalance: round(balance),
    resultUnits: round(balance - openingBalance),
    maxDrawdown: round(maxDrawdown),
    // Reported separately from the balance and never folded into it: this money
    // is committed, not lost and not won.
    openBets: open.length,
    openExposure: round(open.reduce((acc, p) => acc + p.agent.stake, 0)),
    days,
    months,
    openDetail: open.map((p) => ({
      id: p.id,
      recordedAt: p.recordedAt,
      fixture: `${p.fixture.home}–${p.fixture.away}`,
      kickoff: p.fixture.kickoff,
      market: p.market.family,
      selection: p.market.selection + (p.market.line === undefined ? '' : ` ${p.market.line}`),
      stake: p.agent.stake,
      price: p.marketView.bestPrice,
      // What a win would return, so the exposure has a size and not just a
      // count. Losing it is already the exposure figure.
      toReturn: round(p.agent.stake * (p.marketView.bestPrice - 1))
    }))
  };
}

module.exports = { account, activeDays };
