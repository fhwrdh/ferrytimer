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
Pacific. Two origins (Downtown, Northgate) to Town & Country Market, Poulsbo.
Each run appends one line per origin to `samples.jsonl`:
`{ sampleId, schemaVersion, origin, destination, now, inputs }`.
- Live legs: origin→Colman, origin→Edmonds, origin→destination avoiding ferries;
  Bainbridge→destination, Kingston→destination.
- WSDOT schedule, sailing space (filtered to the arrival terminal), vessel
  locations with terminal context.
- Timed home legs for 3 candidate sailings per route, priced at departure +
  crossing time.
- Budget 650 Routes calls per Pacific day; about 42 per hour.

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

Expected volume: 2 origins × ~40 schema-2 runs ≈ 80 samples by 21:00; samples
after about 18:30 resolve only after their trips finish. Thin by design; the
scorecard shows counts next to every metric.

## 5. Evaluation

`npm run eval` runs every scenario and prints a scorecard for v1, next to v0's
baseline.

| Set | Metrics | Gate |
|---|---|---|
| Handcrafted | exact winner, primary/fallback sailing, isCloseCall; arrival ±2 min | any failure → exit 1 |
| Samples: tune | per-route mean absolute arrival error, mean signed error, p90; winner agreement with `observedBest` | reported in detail |
| Samples: holdout | same metrics, totals only | mean absolute error worse than baseline by >2 min, or winner agreement lower than baseline → exit 1 |

Split: samples assigned to tune/holdout by a deterministic hash of `sampleId`,
80/20, stable across runs.

**Baseline.** `npm run eval:baseline` scores v0 on the same scenarios and writes
`eval/baseline.json`. Only a human runs it. v0 has no arrival time, so its
arrival = `now + totalTimeMinutes`.

## 6. Agent loop (skill)

`.claude/skills/tune-route-plan/SKILL.md` instructs the agent to:
1. Run `npm run eval`; read the tune-set detail and holdout totals.
2. Form a hypothesis from systematic error (e.g. Kingston arrivals consistently
   late ⇒ loading time too low); state it before editing.
3. Edit only `src/lib/routePlan.ts` (not v0, not eval code, not data).
4. Run `npm test` and `npm run eval`; accept only if handcrafted passes and
   holdout improves; otherwise revert.
5. Never edit handcrafted `expect` blocks, `eval/data/`, or `baseline.json`.

`eval/run.ts` prints a loud warning when `git status` shows changes to
handcrafted scenarios, `eval/baseline.json`, `src/lib/routePlan.v0.ts`, or
`eval/score.ts`. `.gitignore` gains an exception so `.claude/skills/` is
committed.

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
