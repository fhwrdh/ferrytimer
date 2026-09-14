---
name: tune-route-plan
description: Use when asked to improve Ferry Timer's route recommendations or arrival estimates against real sampled data. Runs the eval harness loop - measure, hypothesize, change routePlan.ts, re-measure - with guardrails against overfitting and against editing the tests.
---

# Tune the route plan against the eval

You are improving `src/lib/routePlan.ts` (algorithm v1) using an objective
scorecard built from real trips the sampler recorded. The score is only
meaningful if the truth and the guardrails stay fixed, so the rules below are
strict.

## What you may change

- `src/lib/routePlan.ts`, including `PARAMS` and the rule logic.
- `src/lib/routePlan.test.ts`, only to add tests for new behavior or update
  tests whose expected values follow directly from a PARAMS change you made
  and explained.

## What you must never change

- `eval/scenarios/handcrafted.ts`, `eval/score.ts`, `eval/resolver.ts`
- `eval/baseline.json`, anything in `eval/data/`
- `src/lib/routePlan.v0.ts`, `src/lib/fixtures.ts`

If a guardrail fails, the algorithm is wrong, not the guardrail. If you believe
a guardrail or the resolver itself is wrong, stop and tell the human why. Do
not work around it.

## The loop

1. **Measure.** Run `npm run eval`. Read:
   - the tune set per-route MAE and **bias** (predicted − observed; positive
     means we predict arriving later than reality),
   - the largest tune misses, including which sailing was actually caught,
   - the holdout totals and whether any gate failed.
   Note the numbers you start from.
2. **Hypothesize.** Before editing, write one sentence naming a systematic
   error and its likely cause, tied to the data. Examples:
   - "Kingston bias is −6m across 20 samples: crossings take longer than 30m."
   - "Misses cluster where the caught sailing is later than predicted: the
     boarding buffer is too short for Colman at rush hour."
   Prefer changes that explain many samples over ones that fix one miss.
3. **Change one thing.** Make the smallest change that tests the hypothesis.
4. **Verify.** Run `npm test` then `npm run eval`.
5. **Decide.**
   - Keep the change only if: all tests pass, every guardrail passes,
     `RESULT: PASS`, and holdout MAE or holdout winner agreement improved
     without the other getting worse.
   - Otherwise revert it (`git checkout -- src/lib/routePlan.ts`) and record
     what you learned.
6. **Commit kept changes** with a message stating the hypothesis and the
   before/after holdout numbers.
7. Repeat up to 5 hypotheses, then stop and summarize.

## Overfitting discipline

- Holdout detail is hidden on purpose. Do not try to infer individual holdout
  samples; tune on the tune set's evidence.
- With few samples, a 1-2 minute MAE change can be noise. Say so when it is.
- Never add special cases keyed to specific times, dates, or sample IDs.

## Report at the end

A short table: hypothesis, change, tune MAE before/after, holdout MAE
before/after, winner agreement before/after, kept or reverted. Then one
paragraph on what the data says about where the algorithm is still weak.
