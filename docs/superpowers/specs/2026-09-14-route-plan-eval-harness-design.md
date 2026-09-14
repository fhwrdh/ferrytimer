# Route Plan Accuracy + Eval Harness — Design

Date: 2026-09-14
Status: Draft for review
Context: demo for an interview session on AI-assisted development (2026-09-15)

## Goal

Make the ferry-vs-drive recommendation more accurate with deterministic code,
then build an eval harness that scores the algorithm against real and observed
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

## Decisions and trade-offs

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| AI placement | Dev loop (eval-driven agent) | Agent inside the app | Runtime answer must be repeatable, fast, free; agent value is in iterating on the algorithm with objective feedback |
| Nearly-full sailing | Headline uses next boat; close-call judged on fallback | Always optimistic; always pessimistic | Matches in-the-field "go for it" behavior while staying honest about risk |
| Home-leg pricing | Two-stage fetch, priced at real arrival time | Interpolate fixed times; cache | Correctness at cost of 2 extra Google calls; cache deferred |
| Trip storage | Server JSONL + auto home detection + tap for route taken | localStorage export; manual-only logging | Real trips replay directly into eval as scenarios |
| Ground truth for demo | Server sampler + resolver (proxy truth) plus real trips | Real trips only | Real trips alone yield ~2 data points by demo time; tuning on that is overfitting |
| Overfit guard | Tune/holdout split + handcrafted guardrails | Single pooled score | A change counts only if holdout improves |

## 1. Components

```
src/lib/planInputs.ts     Inputs type: all upstream data a plan needs, JSON-serializable
src/lib/routePlan.ts      Pure: selectSailings(stage1Inputs, now) -> home-leg requests
                                planRoutes(inputs, now, bias) -> RoutePlan
src/hooks/useRouteCalculation.ts
                          Fetch only: stage 1, selectSailings, stage 2, planRoutes
server/server.mjs         + POST /api/trips, PATCH /api/trips/:id
server/sampler.mjs        Cron: runs stage 1+2 from fixed origins, appends samples
server/resolver.mjs       Resolves due samples into observed outcomes
eval/scenarios/handcrafted/*.json   committed, synthetic locations
eval/scenarios/real/      gitignored: imported trips + resolved samples
eval/run.ts               Scorecard, baseline comparison, exit code
eval/import.ts            Pull trips.jsonl + samples from droplet into scenarios
eval/baseline.json        Scores of the pre-change algorithm (human-updated only)
.claude/skills/tune-route-plan/SKILL.md   Agent loop instructions
```

`planRoutes` runs in the browser, the server sampler, and the eval, from one
source file. The server stays dependency-free: the deploy script bundles
`src/lib/routePlan.ts` to `server/lib/routePlan.mjs` with esbuild (already
installed via Vite). The browser fetchers in `src/api` call relative `/api`
URLs, so the sampler has its own small upstream fetch module
(`server/upstream.mjs`) with the same response parsing. The home location for
the sampler comes from server env (`HOME_LAT`, `HOME_LNG`), never the repo.

## 2. Algorithm rules

1. **Adjusted schedule.** If a vessel reports an ETA, departure = max(scheduled,
   ETA + loading time). Arrival shifts by the same delay.
2. **Primary sailing.** First adjusted sailing departing after
   `now + driveToTerminal + boardingBuffer`.
3. **Space state** for the matched sailing:
   - `null` → unknown; primary, no warning
   - `0` → full; roll forward and re-check; if none remain, route has no sailings
   - `1..nearlyFullThreshold-1` → nearly full; fallback = following sailing
   - otherwise → ok
4. **Crossing time** = scheduled arrival − scheduled departure. `CROSSING_TIMES`
   used only when WSDOT omits the arrival.
5. **Home leg.** Priced by Google with `departureTime` = the sailing's adjusted
   arrival, for primary and fallback. On failure, retry once without
   `departureTime` and add a warning.
6. **Totals.** `primaryTotal` and `fallbackTotal`, each driveToTerminal + wait +
   crossing + driveHome for that sailing.
7. **Winner and close call.** Headline time = `primaryTotal` (+ bias for
   drive-around). `decisionTime` = `fallbackTotal` if nearly full, else
   `primaryTotal` (+ bias for drive-around). Winner = lowest headline time.
   Close call if the top-two gap by `decisionTime` ≤ 15 min, or if ranking by
   `decisionTime` changes the winner.
8. **Drive-around** unchanged: starts now, low risk.

Tunable parameters, exported as one `PARAMS` object: `vesselLoadingMinutes`
(15), `boardingBufferMinutes` (10), `nearlyFullThreshold` (10),
`closeCallMinutes` (15).

Output: `RoutePlan { routes, winner, isCloseCall, closeCallGap, warnings }`.
`RouteOption` adds `spaceState` and `fallback: { departure, totalMinutes } | null`.
`App.tsx` only renders; close-call math moves out of it. Nearly-full caution
reads e.g. "8 spaces left — else the 6:15, +45m".

## 3. Trip capture

**Client.** A trip starts at the first successful calculation away from home;
`tripId` lives in localStorage and expires after 4 h. Each calculation POSTs
`{ tripId, at, now, bias, inputs, plan }`. Opening the app near home with an
open trip shows "Home. Took: Kingston / Bainbridge / Drive" with Dismiss; a tap
PATCHes `{ arrivedAt: now, routeTaken }`. The first prediction of a trip is the
one scored.

Known limitation: `arrivedAt` is when the app was opened at home, which can be
later than real arrival. Dismiss discards bad trips.

**Server.** Append events to `trips.jsonl` in a data directory outside `dist/`.
Same-origin guard, 10/min per IP, 256 KB body cap, refuse writes over 50 MB.

## 4. Sampler and resolver (proxy ground truth)

Verified 2026-09-14: Google Routes rejects a `departureTime` in the past, so
history cannot be re-queried; WSDOT `vesselhistory/{Vessel}/{from}/{to}` returns
`ScheduledDepart`, `ActualDepart`, and `EstArrival` (an estimate, not a recorded
arrival); the Routes daily cap is 1,000 calls for the whole GCP project, shared
with the live app.

**Sampler.** Cron fires every 20 min; the sampler itself exits unless Pacific
local time is 06:00–21:00 (the droplet runs UTC and Debian cron has no reliable
`CRON_TZ`). Two fixed origins (Downtown, Northgate) to the home location in
server env. Each run records, and appends one line per origin to
`samples.jsonl` as `{ sampleId, origin, now, inputs }`:
- Live Google legs (`departureTime` omitted): origin→Colman, origin→Edmonds,
  origin→home avoiding ferries (per origin); Bainbridge→home, Kingston→home
  (shared). These double as observations of "traffic now".
- WSDOT schedule, sailing space, vessel locations (free).
- Timed Google home legs for **candidate sailings**: for each ferry route, the
  first 3 sailings departing after `now + shortest drive to that terminal`,
  deduplicated across origins, priced at each sailing's scheduled arrival.
  Recording a superset of what any algorithm would pick keeps replays from
  going stale when the algorithm changes which sailing it picks.

The sampler does not run `planRoutes`; plans are computed at eval time from the
recorded inputs, for whichever algorithm version is being scored.

Budget: 6 + 2 live + up to 6 timed ≈ 14 Routes calls per run × 45 runs ≈ 630
per day, leaving ~370 for the app. A counter file enforces a hard stop at 650
calls per Pacific day.

**Resolver (Plan 2).** No Google calls. For a sample predicted at `now`:
- Drive legs: the observed duration of a leg starting at time *t* is the live
  duration recorded by the run nearest *t* (within 10 min); otherwise the
  scenario is `unresolved`.
- Ferry legs: `vesselhistory` gives the actual departure of the chosen sailing;
  arrival = actual departure + (EstArrival − ActualDepart). Sold-out truth
  comes from the last sailing-space reading before the predicted terminal
  arrival.
- Output: observed arrival per route, appended to `outcomes.jsonl`. Labeled
  proxy truth in the scorecard.

Expected volume by demo: 2 origins × ~25 runs (12:30–21:00 today) ≈ 50
samples, plus the morning of 2026-09-15. Thin by design; the scorecard shows
sample counts next to every metric.

## 5. Evaluation

`npm run eval` runs every scenario and prints a scorecard.

| Set | Metrics | Gate |
|---|---|---|
| Handcrafted | exact winner, primary/fallback sailing, isCloseCall; arrival ±2 min | any failure → exit 1 |
| Samples: tune | per-route mean absolute error, mean signed error, p90; winner agreement with observed-best route | reported in detail |
| Samples: holdout | same metrics, totals only | mean absolute error worse than baseline by >2 min → exit 1 |
| Real trips | error for route taken; agreement with route taken | reported; separate row |

Split: samples assigned to tune/holdout by a deterministic hash of `sampleId`,
80/20, stable across runs.

**Stale inputs.** Replayed scenarios only contain home-leg prices for sailings
the recording algorithm selected. If new code selects a sailing without a
recorded price, the scenario is reported as `stale-inputs` and skipped with a
count, never estimated.

**Baseline.** `eval/baseline.json` is produced from the current algorithm
before fixes 1–3 and updated only by a human via `npm run eval:baseline`. The
extracted pre-fix algorithm is kept as `src/lib/routePlan.v0.ts` so the
baseline can be regenerated on the same scenario set. Fed recorded inputs, v0
uses the recorded home-leg price for its primary sailing; where v0 picks a
sailing without one (a full boat it ignores), the scenario counts as
`stale-inputs` for v0 too.

## 6. Agent loop (skill)

`.claude/skills/tune-route-plan/SKILL.md` instructs the agent to:
1. Run `npm run eval`; read the tune-set detail and holdout totals.
2. Form a hypothesis from systematic error (e.g. Kingston arrivals consistently
   late ⇒ loading time too low); state it before editing.
3. Edit only `src/lib/**`.
4. Run `npm test` and `npm run eval`; accept only if handcrafted passes and
   holdout improves; otherwise revert.
5. Never edit scenario `expect` blocks, outcomes, or `baseline.json`.

`eval/run.ts` warns loudly when git shows changes to scenarios, outcomes, or the
baseline in the working tree.

## Error handling

- Stage 1 failures behave as today: a route drops only when its required data
  is missing; refinements (spaces, vessels) degrade to empty.
- Stage 2 failures retry without `departureTime`, then warn.
- Trip POST failures are silent to the user (logged to console); they never
  block the recommendation.
- Sampler/resolver failures log and skip the slot; no retries that burn quota.

## Testing

- vitest added as a dev dependency.
- `routePlan` built test-first: characterization tests of current behavior
  first, then failing tests for rules 1–7.
- Server endpoints: a small node test for body cap, size cap, and PATCH of an
  unknown id.

## Build order

1. Verify `vesselhistory` responses and Google daily quota caps (gate).
2. Extract `routePlan` with characterization tests; capture baseline; deploy
   sampler (collect data as early as possible). Requires droplet deploy + cron
   approval.
3. Fixes 1–3 test-first; two-stage fetching in the hook; UI reads plan.
4. Resolver, `eval/run.ts`, handcrafted scenarios, baseline.
5. Trips endpoint, arrival card, importer.
6. Tuning skill; rehearse the agent loop on collected data.
