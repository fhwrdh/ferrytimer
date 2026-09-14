---
name: tune-route-plan
description: Use when asked to improve Ferry Timer's route recommendations or arrival estimates against real sampled data. Runs the eval harness loop - measure, hypothesize, change routePlan.ts, re-measure - with guardrails against overfitting and against editing the tests.
---

# Tune the route plan against the eval

You are improving `src/lib/routePlan.ts` (algorithm v1) using an objective
scorecard built from real trips the sampler recorded. Every `npm run eval`
scores both the frozen v0 and your v1 on exactly the same samples, and the
holdout gates compare v1 to that live v0. The score is only meaningful if the
truth and the guardrails stay fixed, so the rules below are strict.

## What you may change

- `src/lib/routePlan.ts`, including `PARAMS` values and the rule logic.
- `src/lib/routePlan.test.ts`, only to add tests for new behavior or update
  tests whose expected values follow directly from a PARAMS change you made
  and explained.

## What you must never change

These mirror the protected list in `eval/run.ts`, plus the data:

- `eval/scenarios/handcrafted.ts`, `eval/score.ts`, `eval/resolver.ts`
- `eval/run.ts`, `eval/resolve.ts`, `eval/baseline.json`
- `src/lib/routePlan.v0.ts`, `src/lib/fixtures.ts`
- `src/api/ferries.ts`, `src/lib/planInputs.ts`
- `package.json`, `vitest.config.ts`
- `tsconfig.json`, `src/sampler/runSample.ts`, `src/types.ts`
- `.claude/skills/tune-route-plan/SKILL.md` (this file)
- anything in `eval/data/`

Never create, move, or delete the `eval-base` git tag (`git tag`, `git tag
-f`, `git tag -d`). Only a human sets it, before the session starts.

If a guardrail fails, the algorithm is wrong, not the guardrail. If you believe
a guardrail or the resolver itself is wrong, stop and tell the human why. Do
not work around it.

## The loop

Before you start, confirm `npm run eval` does not print `NOTE: no eval-base
tag`. If it does, stop and ask the human to tag the starting commit.

1. **Measure.** Run `npm run eval`. Read:
   - the tune set per-route v0 vs v1 MAE, **bias** (predicted − observed;
     positive means we predict arriving later than reality) and p90, on
     paired rows, with coverage counts,
   - the largest v1 tune misses, including which sailing was actually caught,
   - the holdout ferry MAE v0 vs v1, winner agreement v0 vs v1, coverage, and
     every `GATE FAIL` / `GATE SKIPPED` line.
   Note where v1 stands relative to v0 before you change anything.
2. **Hypothesize.** Before editing, write one sentence naming a systematic
   error and its likely cause, tied to the data. Examples:
   - "Kingston bias is −6m across 20 samples: crossings take longer than 30m."
   - "Misses cluster where the vessel ETA delayed departure: loading time is
     too long."
   Prefer changes that explain many samples over ones that fix one miss.
3. **Change one thing.** Make the smallest change that tests the hypothesis.
4. **Verify.** Run `npx tsc --noEmit`, then `npm test`, then `npm run eval`.
   (`tsx` does not typecheck, so skipping tsc can hide a broken change.)
5. **Decide.**
   - Keep the change only if: tsc is clean, all tests pass, every guardrail
     passes, `RESULT: PASS`, and, compared with v1's position relative to live
     v0 before the change, holdout v1 ferry paired MAE **or** holdout winner
     agreement improved without the other getting worse, and ferry coverage
     (v1 predicted vs v0 predicted) did not drop.
   - Otherwise revert it (`git checkout -- src/lib/routePlan.ts`) and record
     what you learned.
6. **Commit kept changes** with a message stating the hypothesis and the
   before/after holdout numbers (v0 and v1).
7. Repeat up to 5 hypotheses, then stop and summarize.

## Limits of the truth

The outcomes are proxy truth built by `eval/resolver.ts`. Some things cannot
be learned from them:

- **DRIVE truth equals the prediction.** The observed drive-around arrival is
  the sample's own live drive estimate, so drive error is always zero. It is
  excluded from the gates; do not read anything into it.
- **Boarding buffer is baked in.** The resolver decides which sailing was
  caught using a fixed 10-minute boarding buffer, so tuning
  `boardingBufferMinutes` away from 10 is not learnable from this data.
- **Crossings sometimes fall back.** When WSDOT has no arrival for a sailing,
  the resolver uses 35 minutes (Bainbridge) / 30 minutes (Kingston), the same
  as the default crossing parameters. Those rows cannot tell you the crossing
  is wrong.
- **New parameters need a human.** Adding a key to `PARAMS` requires updating
  `HANDCRAFTED_PARAMS` in `eval/scenarios/handcrafted.ts`, which you may not
  edit; the eval fails until it matches. Stop and ask instead.

## Overfitting discipline

- Holdout detail is hidden on purpose. Do not try to infer individual holdout
  samples; tune on the tune set's evidence.
- With few samples, a 1-2 minute MAE change can be noise. Say so when it is.
- A `GATE SKIPPED: insufficient data` line means that gate protected nothing
  this run; say so in your report.
- Never add special cases keyed to specific times, dates, or sample IDs.
- Never make v1 decline to predict a route to avoid an error; the coverage
  gate fails that.
- Winner agreement counts a missing winner as wrong: on a fully resolved row,
  naming no winner counts toward the denominator and never counts as
  agreement, so declining to pick a winner cannot raise the rate.

## Report at the end

A short table: hypothesis, change, tune ferry MAE v0/v1 before/after, holdout
ferry MAE v0/v1 before/after, winner agreement before/after, kept or reverted.
Then one paragraph on what the data says about where the algorithm is still
weak.
