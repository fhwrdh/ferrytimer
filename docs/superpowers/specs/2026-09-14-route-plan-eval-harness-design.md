# Route Plan Accuracy + Eval Harness — Design

Date: 2026-09-14
Status: Plan 1 shipped (sampler live); Plan 2 scope revised 2026-09-14 afternoon
Context: demo for an interview session on AI-assisted development (2026-09-15)

## Goal

Make the ferry-vs-drive recommendation more accurate with deterministic code,
then build an eval harness that scores the algorithm against observed
outcomes, so a coding agent can change the runtime algorithm and get an
objective verdict.

The demo: an agent evaluates real data and changes the runtime algorithm,
guarded against overfitting and against gaming its own tests.

## Non-goals

- No LLM in the app's runtime path. Trip decisions must be deterministic and
  reproducible.
- No user-selected future start time. "Now" remains the trip start. The design
  keeps `now` a parameter so this can be added later.
- No drive-time uncertainty bands, leave-later comparisons, or home-leg caching
  (items 4–7 from brainstorming). Candidates for later.
- Cut 2026-09-14 for time: real-trip capture (trips endpoint, arrival card,
  importer). A "what's next": recorded `PlanInputs` already replay the same way
  a captured trip would.
- Cut for now: UI for the fallback-sailing caution. The eval scores the plan,
  not the screen.
- Ad-hoc destinations (saved home plus easy alternatives, Google Maps style) are
  a separate future feature. Nothing in `PlanInputs` assumes home.

## Decisions and trade-offs

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| AI placement | Dev loop (eval-driven agent) | Agent inside the app | Runtime answer must be repeatable, fast, free; agent value is in iterating on the algorithm with objective feedback |
| Nearly-full sailing | Headline uses next boat; close-call judged on fallback | Always optimistic; always pessimistic | Matches in-the-field "go for it" behavior while staying honest about risk |
| Home-leg pricing | Priced at the sailing's arrival time | Interpolate fixed times; cache | Correctness at cost of extra Google calls; cache deferred |
| Ground truth for demo | Server sampler + local resolver (proxy truth) | Real trips only | Real trips alone yield ~1 data point by demo time; tuning on that is overfitting |
| Sampler destination | Public place (Town & Country Market, Poulsbo) | User's home | Replayable and shareable data, nothing private on screen |
| Overfit guard | Tune/holdout split + handcrafted guardrails | Single pooled score | A change counts only if holdout improves |
| Sampling horizon | Today only (06:00–21:00 PDT, stopped after 21:05) | Continue into demo day | Keeps the full Google quota for the demo |

## 1. Components

Shipped in Plan 1:

```
src/api/ferries.ts            pure WSDOT parsers (ETA parse bug fixed)
src/lib/planInputs.ts         JSON-serializable algorithm inputs
src/lib/routePlan.v0.ts       pre-change algorithm, pure, frozen as baseline
src/hooks/useRouteCalculation.ts   gathers PlanInputs, calls v0
src/sampler/*                 cron sampler, bundled to server/dist/sampler.mjs
server/run-sampler.sh         cron wrapper
```

Plan 2:

```
src/lib/routePlan.ts          v1 algorithm (rules below), pure, tuned by the agent
eval/fetchSamples.ts          copy samples.jsonl from the droplet (scp)
eval/resolve.ts               samples + WSDOT vesselhistory -> outcomes
eval/scenarios/handcrafted/*.json   committed guardrail scenarios
eval/score.ts                 pure scoring: plan vs outcome -> metrics
eval/run.ts                   scorecard, baseline comparison, exit code
eval/baseline.json            v0 scores (human-updated only)
.claude/skills/tune-route-plan/SKILL.md   agent loop instructions
```

Eval scripts run locally with `tsx` (dev dependency). The resolver runs
locally, not on the droplet: WSDOT is free and the local `.env.local` key works.
Resolved data lives in gitignored `eval/data/`.

## 2. Algorithm rules (v1, `routePlan.ts`)

1. **Adjusted schedule.** If a vessel reports an ETA **to the sailing's departing
   terminal**, departure = max(scheduled, ETA + loading time). Vessel terminal
   fields are recorded from schema version 2 on; when they're absent, fall back to
   name-only matching like v0.
2. **Primary sailing.** First adjusted sailing departing after
   `now + driveToTerminal + boardingBuffer`.
3. **Space state** for the matched sailing:
   - `null` → unknown; primary, no warning
   - `0` → full; roll forward and re-check; if none remain, route has no sailings
   - `1..nearlyFullThreshold-1` → nearly full; fallback = following sailing
   - otherwise → ok
4. **Crossing time** = `CROSSING_TIMES` for the route. WSDOT `scheduletoday`
   never returns an arrival time (verified: 124/124 recorded sailings), so the
   schedule cannot supply it.
5. **Home leg** for a sailing starts at adjusted departure + crossing time. Its
   duration is the recorded timed home leg whose `departAt` is nearest that
   start, within `homeLegMatchMinutes`; otherwise the live (`departAt: null`)
   leg, flagged in the route's warnings. The app would price it at that time;
   replay uses the nearest recorded price.
6. **Totals.** `primaryTotal` and `fallbackTotal`, each driveToTerminal + wait +
   crossing + driveHome for that sailing.
7. **Winner and close call.** Headline time = `primaryTotal` (+ bias for
   drive-around). `decisionTime` = `fallbackTotal` if nearly full, else
   `primaryTotal` (+ bias for drive-around). Winner = lowest headline time.
   Close call if the top-two gap by `decisionTime` ≤ `closeCallMinutes`, or if
   ranking by `decisionTime` changes the winner.
8. **Drive-around** unchanged: starts now, low risk.

Tunable parameters, exported as one `PARAMS` object: `vesselLoadingMinutes`
(15), `boardingBufferMinutes` (10), `nearlyFullThreshold` (10),
`closeCallMinutes` (15), `homeLegMatchMinutes` (20), and per-route crossing
minutes (35 Bainbridge, 30 Kingston).

`planRoutes(inputs, params = PARAMS, bias = 0)` returns
`RoutePlan { routes, winner, isCloseCall, closeCallGap, warnings }`. Each route
carries `arrivalAt` (ISO), `spaceState`, the chosen sailing's departure, and
`fallback: { departure, totalMinutes } | null`.

## 3. Trip capture

Cut (see Non-goals).

## 4. Sampler (shipped) and resolver

Verified 2026-09-14:
- Google Routes rejects a `departureTime` in the past; history cannot be re-queried.
- WSDOT `vesselhistory/{Vessel}/{from}/{to}` returns `ScheduledDepart`,
  `ActualDepart`, `EstArrival`, and is current to within about 30 minutes.
- WSDOT `scheduletoday` omits `ArrivingTime`.
- Routes daily cap is 1,000 calls for the whole GCP project, shared with the app.

**Sampler (live).** Cron every 20 min, sampler exits outside 06:00–21:00
Pacific. Three origins (Downtown, Northgate, AI2) to Town & Country Market, Poulsbo.
Each run appends one line per origin to `samples.jsonl`:
`{ sampleId, schemaVersion, origin, destination, now, inputs }`.
- Live legs: origin→Colman, origin→Edmonds, origin→destination avoiding ferries;
  Bainbridge→destination, Kingston→destination.
- WSDOT schedule, sailing space (filtered to the arrival terminal), vessel
  locations with terminal context.
- Timed home legs for 3 candidate sailings per route, priced at departure +
  crossing time.
- Budget 650 Routes calls per Pacific day; about 17 Routes calls per run
  (3 origins), about 51 per hour.

Records without `schemaVersion` (4 lines, before 18:34 UTC) priced timed legs
at departure time; the eval excludes them.

**Resolver (`eval/resolve.ts`).** No Google calls. For each sample with
`schemaVersion >= 2` whose trips have finished, per route:
- **Drive-around:** observed = the sample's own live drive-around minutes
  (priced at `now`, which is when that trip starts).
- **Ferry route:**
  1. Terminal arrival = `now` + the sample's own live drive-to-terminal minutes.
  2. Caught sailing = first sailing whose `ActualDepart` (vesselhistory, matched
     by vessel name and scheduled departure) is after terminal arrival +
     boarding buffer, skipping a sailing whose last sailing-space reading from
     any sample taken before terminal arrival shows 0 drive-up spaces.
  3. Crossing = `EstArrival − ActualDepart` for that sailing.
  4. Home leg = the live terminal→destination minutes from the sample run
     nearest the actual arrival (within 10 minutes).
  5. Observed arrival = actual arrival + home leg.
- A route is `unresolved` when any step lacks data (no vesselhistory row, no
  nearby run). The scorecard counts unresolved routes.
- Output: `eval/data/outcomes.jsonl`, one line per sample:
  `{ sampleId, routes: { DRIVE, BAINBRIDGE, KINGSTON } }`, each
  `{ arrivalAt, caughtSailing? } | { unresolved: reason }`, plus
  `observedBest` (earliest resolved arrival). Labeled proxy truth.

A sample is resolvable once `now + 3 h` is at least 30 minutes in the past.

Expected volume on 2026-09-14: 2 origins for the 11:40–12:20 PDT schema-2
runs, then 3 origins (AI2 added) for ~26 runs to 21:00 ≈ 85 samples; at 17
calls per run the day uses ~510 of the 650 budget. Samples after about 18:30
resolve only after their trips finish. Thin by design; the scorecard shows
counts next to every metric.

## 5. Evaluation

`npm run eval` runs every handcrafted scenario, then scores **both** v0 and v1
live on every sample that has an outcome, in the same run. v0 has no arrival
time, so its arrival = `now + totalTimeMinutes`.

| Set | Metrics | Gate |
|---|---|---|
| Handcrafted | exact winner, primary/fallback sailing, isCloseCall; arrival ±2 min | any failure → exit 1 |
| Samples: tune | per-route v0 vs v1 mean absolute arrival error, mean signed error, p90 on paired rows, with coverage counts; ferry-overall; winner agreement; largest v1 misses | reported in detail |
| Samples: holdout | ferry-overall v0 vs v1, winner agreement v0 vs v1, coverage counts; no sample ids | see gates → exit 1 |

**Split.** Tune/holdout by a deterministic FNV-1a hash of the sample's `now`
(run time), 80/20, stable across runs. Records from different origins in one
sampler run share `now` and nearly all ferry inputs; hashing `sampleId` would
put twins in different sets and leak the holdout.

**Paired scoring.** A route's error counts only when its outcome resolved AND
both v0 and v1 predicted an arrival, so neither side can improve MAE by
declining to predict hard trips. Coverage per route reports `resolved`,
`v0Predicted`, `v1Predicted` (predicted and resolved). Ferry-overall MAE pools
Bainbridge and Kingston paired errors only. Winner agreement with
`observedBest` counts only rows where all three routes resolved (a partially
resolved row's "best" is biased toward whichever route resolved, usually
DRIVE) and the algorithm named a winner.

**Holdout gates** (v1 against live v0, ferry-only):
1. v1 ferry paired MAE > v0 ferry paired MAE + 2 min → fail.
2. v1 winner agreement rate < v0 rate → fail.
3. For either ferry route, v1Predicted < v0Predicted → fail ("v1 predicts
   fewer resolved trips than v0").
A gate whose metrics are null does not fail; the scorecard prints
`GATE SKIPPED: insufficient data (<gate>)`. DRIVE is never gated (see limits).

**Run integrity checks** (each → exit 1): any v1 planning error; `git status`
failing (protected files cannot be verified); the deep key set of `PARAMS` no
longer matching `HANDCRAFTED_PARAMS` (a new parameter would otherwise run the
guardrails with `undefined`).

**Baseline record.** `npm run eval:baseline` writes `eval/baseline.json` with
the paired tune and holdout metrics, `sampleCount`, and a SHA-256 of the sorted
scored sample ids. It is a record for humans, not a gate input: the outcome set
grows as samples resolve, so a frozen total would compare different rows.
`npm run eval` notes when the scored set differs from the recorded hash.

**Limits of the truth.**
- DRIVE observed arrival is the sample's own live drive estimate, so DRIVE
  error is always zero; it is excluded from gates.
- The resolver picks the caught sailing with a fixed 10-minute boarding buffer,
  so tuning `boardingBufferMinutes` away from 10 is not learnable from this
  data.
- When WSDOT has no arrival for a sailing, the resolver falls back to 35/30
  minute crossings, the same as the default parameters.
- A new `PARAMS` key needs a human to update `HANDCRAFTED_PARAMS`.

## 6. Agent loop (skill)

`.claude/skills/tune-route-plan/SKILL.md` instructs the agent to:
1. Run `npm run eval`; read the tune-set detail and holdout totals.
2. Form a hypothesis from systematic error (e.g. Kingston arrivals consistently
   late ⇒ loading time too low); state it before editing.
3. Edit only `src/lib/routePlan.ts` (not v0, not eval code, not data).
4. Run `npx tsc --noEmit`, `npm test` and `npm run eval`; keep a change only if
   `RESULT: PASS`, all guardrails pass, holdout v1 ferry paired MAE or winner
   agreement improves relative to live v0 without the other worsening, and
   coverage does not drop; otherwise revert.
5. Never edit any protected file or `eval/data/`.
6. Respect the limits of the truth (§5): ignore DRIVE error, do not tune the
   boarding buffer, and stop and ask before adding a parameter.

`eval/run.ts` prints a loud warning when `git status` shows changes to any
protected file: `eval/scenarios/handcrafted.ts`, `eval/baseline.json`,
`eval/score.ts`, `eval/resolver.ts`, `src/lib/routePlan.v0.ts`,
`src/lib/fixtures.ts`, `eval/run.ts`, `eval/resolve.ts`, `package.json`,
`vitest.config.ts`, `src/api/ferries.ts`, `src/lib/planInputs.ts`. If
`git status` itself fails the run fails. The skill's never-change list mirrors
this list plus `eval/data/`. `.gitignore` gains an exception so
`.claude/skills/` is committed.

## Error handling

- Sampler failures log and skip the slot; no retries that burn quota.
- Resolver: missing data marks a route `unresolved`, never guessed.
- Eval: a scenario whose inputs fail to plan is counted as `error` with its
  message; it does not crash the run.

## Testing

- vitest for `routePlan.ts` rules (test-first), `score.ts`, and resolver
  matching logic on fixture data.
- Eval end-to-end: `npm run eval` on handcrafted scenarios alone exits 0.

## Build order

Plan 1 (done): parsers and ETA fix, v0 extraction, sampler, deploy, cron.

Plan 2:
1. `routePlan.ts` v1, test-first.
2. `score.ts` and handcrafted scenarios.
3. `fetchSamples.ts` and `resolve.ts` with fixture tests.
4. `run.ts`, baseline, npm scripts.
5. Skill and `.gitignore` exception; rehearse the loop on real data.
