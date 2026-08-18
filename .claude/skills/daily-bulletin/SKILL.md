---
name: daily-bulletin
description: Use when producing the daily betting bulletin - grades yesterday's predictions, computes corner and goals baselines for upcoming fixtures, records judgments against them, and publishes the bulletin artifact
---

# Daily Betting Bulletin

Produce one day's bulletin across both market families, **corners** and
**goals**. Follow these steps in order. The order matters: grading comes before
analysis so today's bulletin opens with yesterday's result.

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

Call `get_ledger_summary` three times: once with no filter for the overall
picture, then once per family with `market: "corners"` and `market: "goals"`.
Carry through, for each: agent Brier, baseline Brier, **`marketConsensus.brier`**,
`verdict`, `verdictNote`, P&L in units, `n`, and the calibration bands.

**Read `judgment` before anything else.** It measures how much judgment is
actually being exercised — median and maximum divergence from the baseline, how
many predictions sat inside the 0.03 threshold, how many carried a reason. If
its `note` says the typical prediction restates the baseline, put that in the
bulletin: it means the comparison below it is measuring nothing, and no amount
of further running will fix that on its own.

**`marketConsensus` is the hard benchmark.** Beating a venue-split Poisson is
easy; beating the de-vigged market is the thing that pays. `blend.weight` is the
model weight that would have scored best in hindsight — near 0 says the market
knows better, near 1 says the model does. It is fitted in sample and is not
applied anywhere; report it, do not act on it.

The per-family reading is the one that means something. Brier scores are only
comparable within a family — goals lines sit at probabilities corners lines
never reach — so an overall number mixing them says less than either half. Each
family needs its own 30 settled predictions before its verdict stops being
`insufficient`.

If `verdict` is `baseline-better`, say so plainly at the top of the bulletin.
That is the finding the whole system exists to surface, and burying it would
defeat the purpose.

## Step 4 — Find the fixtures

For each entry in `leagues`, call `get_fixtures` with the league, season, and a
date range covering the next `windowHours` hours. Collect every fixture not yet
played.

## Step 5 — Compute the baselines

Two market families are built: **corners** and **goals**. For each fixture,
call both `get_corner_baseline` and `get_goals_baseline` with `matchCount` from
the configuration, and pass each family its own lines: `lines.corners` to the
corner baseline, `lines.goals` to the goals one. The two sets are not
interchangeable — 7.5 to 12.5 is meaningless for goals — so never pass one
family's lines to the other's baseline.

**Order matters for cost.** Both families now read the same per-match
statistics — corners for the corner count, goals for shots on target — so call
`get_corner_baseline` FIRST. Finished matches are cached permanently, so the
goals baseline that follows spends almost nothing on the same fixture. Called
the other way round the total is the same; called on a fixture where you skip
corners, the goals baseline pays the full per-match cost itself.

**Read `signal` on the goals baseline.** `"shots"` means the rate came from
shots on target scaled by a pooled conversion — the intended path, and the less
noisy one. `"goals"` means coverage was too thin and it fell back to the older
goal-rate model; that is weaker evidence and belongs in your `confidence`.
When the signal is `shots`, `comparison` carries what the goals-based model
would have said. A wide gap between the two is worth a sentence in your
reasoning: it means recent scoring has been running ahead of or behind the
underlying shot volume.

Copy `signal` into `baseline.signal` when you record the prediction. It is what
lets the two models be scored against each other later.

Everything below about caveats and dispersion applies to both.

**Read the `caveats` array.** A baseline built on a fallback venue sample is
weaker than one that was not, and that belongs in your `confidence`, which
describes the inputs, not the outcome.

**Compare `overProbability` against `empiricalOverRate`.** A wide gap means the
Poisson model is fitting the sample badly. Say so in your reasoning rather than
trusting the parametric number silently.

**Read `dispersion.ratio` per family, and expect different things of it.** Goal
counts sit close to the Poisson assumption, so a goals ratio far from 1 is a
warning. Corner counts are noisier by nature, so a corner ratio of 0.8 or 1.3
is ordinary. The same number does not mean the same thing in both.

## Step 6 — Read the market

For each fixture, call `get_market_probabilities` once per family — with
`market: "corners"` and again with `market: "goals"`. The tool reads only the
full-match total; per-team, first-half and handicap variants are deliberately
excluded because they are different bets. A family nobody quotes on this
fixture cannot be bet: skip that family and count it as skipped. A line whose
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

**Agreeing with the baseline is a real answer. Nudging it is not.** On
2026-08-18 seven predictions went in at a median of 0.021 below their baselines,
every one just inside the threshold that would have demanded an explanation, at
round numbers a shade under whatever the baseline said. That is not judgment —
it is a constant shrinkage applied by hand, and it leaves the agent-versus-
baseline comparison unable to separate the two however long it runs.

So: if you have a concrete reason, say it and diverge properly. If you do not,
**copy the baseline's number exactly**. A ledger of honest agreements is worth
more than one of invented small differences, because it leaves the comparison
able to answer its own question. `get_ledger_summary` now reports
`judgment.medianAbsDivergence` and will say plainly when this slips again.

Call `evaluate_bet` with your probability and the best price. Do not compute
edge or expected value yourself.

## Step 8 — Filter

Keep only selections whose `edge` is at least `minEdge`. Sort by edge
descending and keep at most `maxPicks`. Zero picks is a valid bulletin — a day
with no value is information, not a malfunction.

## Step 9 — Record

**Size it first.** Call `suggest_stake` with the fixture, the selection and your
probability. It applies fractional Kelly capped at one unit, then scales by what
the baseline says about its own inputs, and returns every penalty it applied.
Use the number it gives you. You may override it, but only downward and only
with a reason you would be willing to read back after the match — on 2026-08-18
all seven picks went in at a full unit, including one built on nine matches with
a dispersion ratio of 1.46, which was the weakest evidence of the day at the
largest size available.

Then call `record_prediction` with `fixtureId`, the `market` block, the same
`matchCount` you used in Step 5, and your `agent` block. **You no longer pass
the baseline or the market view** — it derives both itself from the same tools
you just called, so what lands in the ledger is what the arithmetic produced
rather than what you transcribed. Compare the echoed `baseline` and
`marketView` in the result against what you had in front of you; if they differ,
something is wrong and it is worth saying so in the bulletin.

Never back both families on the same fixture without saying why in each
reason. They are not independent: a match with more goals tends to have more
corners, so two picks on one fixture is closer to one double-sized bet than to
two bets.

The same caution applies across a single evening. Five overs on one night of
European qualifiers is closer to one large directional bet than to five, so if
the day's picks lean one way, say so in the bulletin footer with the total
units at risk.

Skip this step entirely on a dry run.

## Step 10 — Publish

Build an HTML file and publish it with the Artifact tool. **Load the
`artifact-design` skill before writing it.**

Reuse the SAME file path and the SAME artifact URL every day so the owner opens
one stable link. History lives in the ledger, not in a trail of URLs.

The page carries, in this order:

1. If `verdict` is `baseline-better`, that finding, at the top, unmissable.
2. Today's picks. Per pick: fixture and kickoff, **market family** and line,
   baseline probability, empirical rate, market consensus, best price and
   bookmaker, YOUR probability, edge, stake, and **your divergence reason in
   full**. The reason must be visible — it is what makes the judgment
   auditable. The family must be visible too: a reader cannot check a 2.5 line
   without knowing whether it is goals or corners.
3. The performance panel from Step 3, **split by family**: agent Brier against
   baseline Brier, P&L in units, `n`, and the calibration bands, for corners
   and for goals separately. Report the overall figures too, but do not let
   them lead — they mix two things that are not comparable.
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
