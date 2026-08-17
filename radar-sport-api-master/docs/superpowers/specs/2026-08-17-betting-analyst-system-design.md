# Betting Analyst System — Design

**Date:** 2026-08-17
**Status:** Awaiting review
**Builds on:** `2026-08-17-football-stats-mcp-server-design.md` (the MCP data layer)

## Goal

A daily betting bulletin produced by a scheduled agent: it reads football data through the
existing MCP server, computes a deterministic baseline for each market it covers, forms its own
judgment against that baseline and against the market's implied probability, records every
prediction before kickoff, and grades itself once the match finishes.

The point is not to produce opinions. It is to produce opinions **that can be checked**. Every
design decision below serves one question: after two months, does the agent's judgment add value
on top of the arithmetic, or destroy it?

## Non-goals

- **No bet placement.** No bookmaker authentication, no wagering, no movement of money. The
  system outputs a probability, a price and a stake fraction; the human acts on it or does not.
- **No stake sizing beyond a fixed fraction.** The agent never decides how much to risk. It
  reports a stake computed from a fraction the owner configures.
- **No modelling of what the data cannot see.** Dressing-room news, motivation, weather and
  bookmaker money flow are outside the API and therefore outside the system. Absent inputs are
  not estimated.
- **No hosting.** The run is local (see *Scheduling constraint*).

## Why the intelligence is split

Three arrangements were considered.

**All in the agent** — read raw data, decide freely. Nothing new to build beyond scheduling, but
the agent re-derives every number each run, two runs over the same data can disagree, and when a
pick is wrong there is no way to tell whether the arithmetic or the reading failed.

**All in the MCP** — compute every number deterministically and let the agent narrate. Reliable
and testable, but it discards the free judgment that motivated the project.

**Split (chosen)** — the MCP computes baselines and nothing else; the agent sees the baseline and
the market's implied probability and may agree, disagree or ignore, but must state its own
probability and must justify any divergence; a ledger records both and scores them against each
other.

The split is the only one of the three that yields all of: free judgment, numbers that do not
drift between runs, and a measurable answer to whether the judgment is worth having. Without that
measurement, "a better analyst than the others" is a claim nobody — owner or author — can check.

## System shape

```
MCP server  ──  data tools (built)  +  baseline tools (new)  +  ledger tools (new)
     │
     ├─ baselines/     pure functions: no network, no clock, no randomness
     ├─ ledger/        append-only JSONL, git-tracked
     │
Daily run   ──  .claude/skills/daily-bulletin/SKILL.md  (fixed procedure)
     │
Delivery    ──  one Artifact at a stable URL, redeployed daily  +  push notification
```

Four units with clean seams. Baselines are pure and testable against hand-computed values. Ledger
is an append-only store with three operations. The run is procedure. Only the data tools touch the
network, and only `provider/apiFootball.js` knows the upstream's shapes — unchanged from the MCP
design.

## Build order

The build proceeds as a **vertical slice first**: one market travels all four layers into the
owner's hands before any market is added. The slice is **corners** — the market that motivated the
project, whose data path (`get_team_corner_profile`) is already built and proven.

The alternative — finish every data tool, then every baseline, then the ledger, then the run —
was rejected because the ledger schema and the bulletin's shape are the two things most likely to
be wrong on first design, and they are cheapest to correct while a single market depends on them.
The vertical order also starts accumulating graded predictions weeks earlier, and the value of the
whole system rests on that record existing.

| Plan | Contents | Notes |
|---|---|---|
| 2 | Corner slice: `get_odds`, corner baseline, ledger, daily run, artifact | `get_odds` is pulled forward — without implied probability the agent has no market to declare itself against |
| 3 | MCP data: injuries, players, squads, lineups, card and shot aggregators | Cards and shots ride on the already-built `get_fixture_statistics` |
| 4 | Remaining baselines: goals/BTTS, cards, shots, 1X2, half-time | Pure additions to `baselines/` |
| 5 | Player markets | Needs a second run near kickoff; see *Cadence limitation* |

## What each market's analysis rests on

A market is analysable only when the API carries the statistic that feeds it.

| Market family | Feeding data | Strength |
|---|---|---|
| Corners (total, per team, handicap) | `fixtures/statistics` → Corner Kicks | Strong |
| Over/under goals | `teams/statistics` → goals for and against, home/away splits | Strong |
| Both teams to score | Same source plus clean sheets | Strong |
| 1X2, double chance | Standings, form, head-to-head, home/away splits | Strong |
| Cards | `fixtures/statistics` → Yellow/Red, plus the fixture's referee | Medium-strong |
| Shots, shots on target | `fixtures/statistics` → Shots on/off Goal | Medium |
| Asian handicap | Derived from relative strength and expected goals | Medium |
| First-half goals, HT/FT | `score.halftime` of previous fixtures | Medium |
| Player markets | `players`, `lineups`, `injuries` | Medium — depends on the probable eleven |

## Baseline tools

### Where the mathematics lives

`mcp-server/baselines/` holds pure functions: no network, no clock, no randomness. `tools/
baselines.js` fetches and calls them. This is what makes the mathematics testable with
hand-computed values instead of HTTP mocks, and what delivers the property the whole approach
rests on: **same inputs, same outputs, every time.**

### `get_corner_baseline(fixtureId, matchCount?)`

Composes both teams' `get_team_corner_profile` results and returns a baseline per market line.

```
λ_home  = (home's corners-for mean   +  away's corners-against mean) / 2
λ_away  = (away's corners-for mean   +  home's corners-against mean) / 2
λ_total = λ_home + λ_away        →  Poisson  →  P(over 8.5), P(over 9.5), …
```

For each line it returns **two** probabilities:

- the **parametric** one, from Poisson at `λ_total`
- the **empirical** one — in how many of the analysed matches the real total cleared that line

They are computed independently: one is a model, the other is a count. When they diverge sharply
the agent is watching the model mis-fit, without needing that explained to it.

Alongside them, `dispersion: { mean, variance, ratio }`. Corner counts are over-dispersed relative
to Poisson (variance exceeds the mean), and the ratio says by how much. Ten matches per team is
too small to estimate a negative-binomial dispersion parameter without heavy noise, so Poisson
plus the empirical figure beside it is the honest choice for the slice. The ledger will show
within two months whether the parametric number is worth replacing.

Also returned: `caveats[]`, generated by code rather than opinion — *"no league normalisation"*,
*"away team's away-venue sample is 3, used all matches"*. Simplifications are declared, not hidden.

Known simplifications, all listed in `caveats`: no league-average normalisation (computing it would
cost many requests for a small correction), no opponent-strength adjustment, equal weighting across
matches with no recency decay, and a venue split that falls back to all matches below a
four-match sample.

### `get_market_probabilities(fixtureId, market)`

Odds converted to probability with the bookmaker's margin removed, per bookmaker and in consensus.

- Raw implied probability is `1 / odd`. Across a market's outcomes these sum above 1; the excess
  is the `overround`, returned explicitly.
- De-vigging is **proportional** (divide each by the sum). For two-outcome markets this is
  adequate. Better methods (Shin) assume a favourite-longshot bias that cannot be verified without
  a history; revisit when the ledger provides one.
- Returns both `consensus` (median of the fair probabilities) and `bestPrice` (the best available
  odd and its bookmaker). These play different roles: the consensus is the market opinion the agent
  declares itself against; the best price determines whether value exists.

Requires the new `get_odds` tool and `ENDPOINTS.ODDS`, cached at the existing `TTL.ODDS`
(15 minutes).

### `evaluate_bet(probability, decimalOdd, bankrollFraction)`

Pure arithmetic, no network. It exists because this is precisely where an agent doing mental
arithmetic slips, and a sign error in expected value corrupts the entire ledger.

The two formulas, fixed here so nothing downstream has to guess which convention is in use:

```
edge          = agentProbability − 1 / bestPrice
expectedValue = agentProbability × (bestPrice − 1) − (1 − agentProbability)
```

`edge` is measured against the **raw** implied probability of the price actually available, not
against the de-vigged consensus. That is deliberate: the bookmaker's margin is a real cost borne by
whoever takes the price, so an edge that only exists once the margin is removed is not an edge. The
de-vigged consensus has a different job — it is the market's honest opinion, the thing the agent's
probability is compared against when judging divergence.

`expectedValue` is per unit staked, where one unit is `stakeFraction` of bank. Both figures are
stored on the prediction record.

### Testing the baselines

Pure layer: Poisson against hand-computed values for known λ; properties (probabilities sum to 1,
P(over) decreases monotonically in the line, λ=0 gives P(over)=0); one golden case from a real
fixture. Tool layer: nock, as the existing tools do, plus the per-call quota ceiling counting
**both** teams' uncached requests.

## The ledger

### Storage

Append-only JSONL, one file per month (`ledger/2026-08.jsonl`). Nothing is ever rewritten.
Grading a match does not edit the prediction — it appends a settlement record referencing it. For
a record the owner will judge themselves by, an immutable trail is the property that matters: a
prediction retouched after the result would be visible.

At the configured ceiling of 8 picks a day, and two records per prediction once settled, this is
about 6,000 lines a year. A database here would be dead weight.

`ledger/` is **git-tracked**, unlike the discardable `.cache/`, and the daily run commits it as its
last step. Backup and tamper-evidence come free, with git history attesting that each line was
written before the match rather than after.

### Records

Prediction, written before kickoff:

```jsonc
{ "type": "prediction", "id": "2026-08-22-1234567-corners-o9.5", "recordedAt": "…",
  "fixture":  { "id": 1234567, "league": "…", "home": "…", "away": "…", "kickoff": "…" },
  "market":   { "family": "corners", "selection": "over", "line": 9.5 },
  "baseline": { "probability": 0.58, "empiricalRate": 0.50, "empiricalSample": 10,
                "lambda": 9.9, "dispersionRatio": 1.4, "caveats": ["no league normalisation"] },
  "marketView": { "consensusProbability": 0.54, "bestPrice": 1.95,
                  "bookmaker": "…", "overround": 0.045 },
  "agent":    { "probability": 0.62, "confidence": "medium", "divergenceReason": "…",
                "stake": 1 },
  "edge": 0.107, "expectedValue": 0.209 }
```

Field conventions, stated so two implementations cannot read them differently:

- `agent.confidence` is an enum — `"low" | "medium" | "high"` — and describes confidence in the
  **inputs**, not in the outcome. The probability already carries the outcome view. A fixture with a
  three-match venue sample and one quoting bookmaker is `"low"` however strong the edge looks.
- `agent.stake` is in units of `stakeFraction` of bank, so `1` means one full configured stake. The
  agent may record a fraction of a unit but never more than one.
- `edge` and `expectedValue` follow the formulas under `evaluate_bet`.

Settlement, written after:

```jsonc
{ "type": "settlement", "predictionId": "…", "settledAt": "…", "fixtureStatus": "FT",
  "observed": { "totalCorners": 11 }, "outcome": "win", "returnUnits": 0.95 }
```

`returnUnits` is profit or loss in staked units at the recorded `bestPrice`: `+0.95` for a win at
1.95, `−1` for a loss, `0` for a void. Summing the column gives P&L in units directly.

The prediction stores the baseline **as the agent saw it**. It is never recomputed at grading time.
`get_team_corner_profile` uses a sliding `last: N` window, so tomorrow's inputs differ because
matches were played — what is deterministic is the transformation, not the input. Storing the
baseline is what later separates "the mathematics was wrong" from "the data moved".

### Enforcement — where the design stops being an intention

`record_prediction` **rejects the write** when `agent.probability` is missing, and rejects it when
the agent departs from the baseline by more than 0.03 without filling `divergenceReason`. This is
zod validation that fails, not a polite request in a prompt. To disagree with the arithmetic, the
agent must say why, or it writes nothing.

### Grading

`grade_pending_predictions()` finds predictions with no settlement, fetches fixture status and
statistics, and decides. It is **idempotent** — a second run does not settle twice, because any
`predictionId` already carrying a settlement is skipped. Outcome is `void` when the statistic was
not recorded (the `null` case `stats.js` already handles correctly) or the match was abandoned. A
result is never inferred from absent data.

It settles **everything** outstanding, not only yesterday's, so a missed run costs a day of
predictions rather than the integrity of the record.

### Scoring

`get_ledger_summary(from?, to?, market?)` does not return a win rate — with varying odds a win
rate means nothing. It returns:

- **Brier score for the agent and for the baseline, over the same predictions, side by side.**
  This comparison, and only this, answers whether the judgment adds value or destroys it.
- **Log loss**, secondary: it punishes confident errors harder than Brier does.
- **Realised P&L in units**, at the prices actually taken.
- **Calibration by band**: of the predictions placed at 50-60%, how many landed?
- Counts: total, pending, void.

At the `maxPicks` ceiling of 8 a day, two months gives roughly 500 predictions — enough for an
aggregate Brier comparison between agent and baseline, **not** enough to split by market or by
league. So the summary reports `n` for every slice and returns `"insufficient"` below 30 rather than
a number that looks meaningful. Without that guard, noise reads as skill, which is the easiest
failure this project affords.

Scoring functions are pure and tested against hand-computed Brier and log-loss values.

## The daily run

### Procedure

The procedure lives in a skill — `.claude/skills/daily-bulletin/SKILL.md` — versioned in the repo
and editable. A scheduler's prompt is an intention; a skill is a procedure, and it fixes the order
so two runs take the same steps.

```
1.  get_api_status                    budget before spending
2.  grade_pending_predictions         FIRST — settle what has already played
3.  get_ledger_summary                so today's bulletin opens with yesterday's result
4.  fixtures in window ∩ watchlist    without a watchlist it sweeps the world and burns the quota
5.  get_corner_baseline per fixture   the arithmetic
6.  get_market_probabilities          the market's opinion
7.  judgment: own probability, and a reason when diverging
8.  filter on minEdge and maxPicks    a bulletin is a shortlist, not a dump
9.  record_prediction                 written before kickoff
10. publish artifact + notify
11. commit the ledger
```

Grading precedes analysis so that today's bulletin opens with yesterday's outcome, putting
performance in view daily instead of somewhere the owner has to go and look for it.

### Scheduling constraint

The MCP server is stdio-local and the ledger is local disk, so **the run must execute on the
owner's machine** — a local cron, not a cloud routine. If the machine is off at the scheduled hour
the run is missed. The procedure is built to survive that: grading settles everything pending, and
a missed run costs a day of predictions, not the record. Hosting this off the owner's machine is a
project of its own and is not designed here.

### Cadence limitation

A morning run is right for corners, goals and cards, and **wrong** for player markets — the
probable eleven appears about an hour before kickoff. Plan 5 will need a second run near kickoff.
This is not the slice's problem, but it is why full market coverage does not fit a single schedule.

### Delivery

One Artifact at a **stable URL**, redeployed daily, so the owner always opens the same link.
History is not lost to this: it lives in the git-tracked ledger. The page carries two parts:

- **Today's picks** — fixture, market, line, baseline probability, market probability, best price
  and bookmaker, agent probability, edge, stake, and the divergence reason **prominently**. The
  reason being visible is what makes the agent auditable.
- **A running performance panel** — agent Brier against baseline Brier, P&L in units, calibration
  by band, and `n`.

A push notification carries a one-line summary and the link.

### Failure handling

If the API fails or the quota is exhausted, the run publishes a bulletin **saying so** and writes no
prediction from partial data. Zero picks is a valid bulletin: a day with no value to bet is
information, not a malfunction.

### Testing a procedure

The skill accepts a dry-run mode that executes all eleven steps without writing to the ledger or
publishing. This is how the full run is validated without contaminating the record — and a record
contaminated in its first month ruins precisely the measurement that justifies the system.

## Configuration

`config/bulletin.json`:

| Key | Proposed | Why |
|---|---|---|
| `leagues` | owner-supplied | Without it there is no run; see *Open questions* |
| `windowHours` | 48 | Fixtures kicking off within 48h of the run — wide enough that a missed day still catches most matches |
| `minEdge` | 0.03 | Below 3 pp the edge sits inside the baseline's own error, so acting on it is acting on noise |
| `maxPicks` | 8 per day | A shortlist forces choosing |
| `stakeFraction` | 0.01 of bank | Fixed fraction, the owner's decision, never the agent's |
| `matchCount` | 10 matches | Sample against quota |
| `runHour` | 09:00 local | Before the owner's day, after odds open |

## Quota, revisited

The MCP design was built around a hard 100 requests/day free tier — "the quota constraint drives
the architecture". The owner has since bought a paid plan, so quota is no longer the dominant
constraint, and two defaults become too conservative for a bulletin sweeping dozens of fixtures:
`MCP_MAX_REQUESTS_PER_CALL` (default 25) and `MAX_MATCH_COUNT` (20) in `stats.js`.

Both stay configurable and both keep their guard — a ceiling is still what stops a runaway
aggregation. The values are re-derived from the purchased tier's daily allowance once it is known;
the formula, not a number, is what this spec fixes: a single bulletin run must be able to cover
`maxPicks` fixtures × 2 teams × `matchCount` matches with a cold cache and still leave the day's
allowance mostly unspent.

## Risks

| Risk | Mitigation |
|---|---|
| Poisson mis-fits over-dispersed corner counts | Empirical rate returned beside every parametric probability; `dispersionRatio` exposed; ledger measures whether the model needs replacing |
| Agent's judgment is worse than the baseline | That is what the side-by-side Brier is for. The measurement is the mitigation — and if it says defer, the honest response is to defer |
| Small samples read as skill | `n` reported on every slice; `"insufficient"` below 30 instead of a plausible-looking number |
| Missed runs from a machine that was off | Grading settles all outstanding predictions, not just yesterday's |
| Ledger contaminated by test runs | Dry-run mode writes nothing and publishes nothing |
| Odds coverage for corner lines is thin at some bookmakers | Consensus is a median over whoever quotes it; a fixture with no corner market is skipped, not guessed |
| Paid-tier quota still insufficient for a wide watchlist | Per-call ceiling refuses rather than silently burning; watchlist is the throttle |

## Open questions

1. **Which leagues?** `config.leagues` cannot be defaulted — it is the throttle on the whole run
   and it depends on what the owner follows. Needed before the first live run, not before
   implementation.
2. **Which paid plan was purchased?** Determines the re-derived values for
   `MCP_MAX_REQUESTS_PER_CALL` and `MAX_MATCH_COUNT`. Implementation proceeds with the existing
   conservative defaults; only the numbers change.
3. **Does the API's odds coverage include corner totals for the chosen leagues?** Verified with one
   live `/odds` call during Plan 2, before the baseline is wired to it. If corner lines are absent,
   the slice still functions on the baseline alone, with no edge calculation and no `marketView`.
