---
name: daily-bulletin
description: Use when producing the daily betting bulletin - grades yesterday's predictions, computes corner baselines for upcoming fixtures, records judgments against them, and publishes the bulletin artifact
---

# Daily Betting Bulletin

Produce one day's bulletin. Follow these steps in order. The order matters:
grading comes before analysis so today's bulletin opens with yesterday's result.

Pass `dry-run` as an argument to execute every step WITHOUT calling
`record_prediction` and WITHOUT publishing. Use it to validate a change to this
procedure. A test prediction written into the ledger contaminates the very
measurement the system exists to produce.

## Step 0 — Read the configuration

Read `config/bulletin.json`. If `leagues` is empty, STOP and tell the owner the
watchlist is unset. Do not substitute a guess: the watchlist is what bounds the
run.

## Step 1 — Check the budget

Call `get_api_status`. Record plan and remaining requests; they go in the
bulletin's footer. If remaining requests are fewer than
`maxPicks × 2 × matchCount`, say so in the bulletin and reduce the number of
fixtures you analyse rather than failing halfway through.

## Step 2 — Grade what has played

Call `grade_pending_predictions`. It settles everything outstanding, not just
yesterday's. Note `settled`, `stillPending` and any `failures` for the bulletin.

## Step 3 — Read the record

Call `get_ledger_summary`. This is the performance panel. Carry through: agent
Brier, baseline Brier, `verdict`, `verdictNote`, P&L in units, `n`, and the
calibration bands.

If `verdict` is `baseline-better`, say so plainly at the top of the bulletin.
That is the finding the whole system exists to surface, and burying it would
defeat the purpose.

## Step 4 — Find the fixtures

For each entry in `leagues`, call `get_fixtures` with the league, season, and a
date range covering the next `windowHours` hours. Collect every fixture not yet
played.

## Step 5 — Compute the baseline

For each fixture, call `get_corner_baseline` with `matchCount` and `lines` from
the configuration.

**Read the `caveats` array.** A baseline built on a fallback venue sample is
weaker than one that was not, and that belongs in your `confidence`, which
describes the inputs, not the outcome.

**Compare `overProbability` against `empiricalOverRate`.** A wide gap means the
Poisson model is fitting the sample badly. Say so in your reasoning rather than
trusting the parametric number silently.

## Step 6 — Read the market

For each fixture, call `get_market_probabilities`. A fixture nobody quotes on
corners cannot be bet: skip it and count it as skipped. A line whose
`consensus` is null is quoted on one side only — its best price is still real,
but you have no market probability to test yourself against, so treat it as
weaker evidence.

## Step 7 — Judge

For each line worth considering, decide YOUR probability. You may agree with the
baseline, disagree with it, or ignore it. Three rules:

1. State your own probability. Not a lean, a number.
2. If you differ from the baseline by more than 0.03, you must have a reason
   that names something concrete — a venue sample, a dispersion ratio, a
   head-to-head, a schedule. "Feels high" is not a reason and
   `record_prediction` will reject the write without one.
3. Never invent an input the tools did not give you. If you find yourself
   reasoning about team news, motivation or weather, stop: none of it is in the
   data, and none of it belongs in the record.

Call `evaluate_bet` with your probability and the best price. Do not compute
edge or expected value yourself.

## Step 8 — Filter

Keep only selections whose `edge` is at least `minEdge`. Sort by edge
descending and keep at most `maxPicks`. Zero picks is a valid bulletin — a day
with no value is information, not a malfunction.

## Step 9 — Record

For each kept selection, call `record_prediction`, copying `baseline` from
Step 5 and `marketView` from Step 6 for the exact line you are backing. Set
`stake` in units (at most 1) and `confidence` from the input quality you
assessed in Step 5.

Skip this step entirely on a dry run.

## Step 10 — Publish

Build an HTML file and publish it with the Artifact tool. **Load the
`artifact-design` skill before writing it.**

Reuse the SAME file path and the SAME artifact URL every day so the owner opens
one stable link. History lives in the ledger, not in a trail of URLs.

The page carries, in this order:

1. If `verdict` is `baseline-better`, that finding, at the top, unmissable.
2. Today's picks. Per pick: fixture and kickoff, market and line, baseline
   probability, empirical rate, market consensus, best price and bookmaker,
   YOUR probability, edge, stake, and **your divergence reason in full**. The
   reason must be visible — it is what makes the judgment auditable.
3. The performance panel from Step 3: agent Brier against baseline Brier, P&L
   in units, `n`, and the calibration bands.
4. A footer: fixtures analysed, fixtures skipped and why, grading results from
   Step 2, and the quota reading from Step 1.

Then send a push notification with one line — picks count, top edge, and the
link.

Skip this step entirely on a dry run; report what you would have published.

## Step 11 — Commit the ledger

```bash
git add ledger/
git commit -m "chore(ledger): record <n> predictions and <m> settlements for <date>"
```

The git history is what attests that each prediction was written before its
match, not after. Skip on a dry run.

## Failure handling

If the API is unreachable or the quota is exhausted, publish a bulletin that
SAYS SO and record nothing. Never write a prediction from partial data — a
prediction built on half a profile is worse than no prediction, because it
enters the record looking like the others.
