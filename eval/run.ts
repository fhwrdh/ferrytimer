// npm run eval            score v1: guardrails, tune detail, holdout totals, gates
// npm run eval:baseline   score frozen v0 and write eval/baseline.json (human step)

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { planRoutes } from '../src/lib/routePlan'
import { planRoutesV0 } from '../src/lib/routePlan.v0'
import type { SampleRecord } from '../src/sampler/runSample'
import { HANDCRAFTED, HANDCRAFTED_PARAMS } from './scenarios/handcrafted'
import {
  checkHandcrafted,
  gateAgainstBaseline,
  isHoldout,
  predictionFromPlan,
  predictionFromV0,
  ROUTE_NAMES,
  scoreSet,
  worstMisses,
  type Baseline,
  type Outcome,
  type Prediction,
  type ScoredRow,
  type SetMetrics,
} from './score'

const SAMPLES = 'eval/data/samples.jsonl'
const OUTCOMES = 'eval/data/outcomes.jsonl'
const BASELINE = 'eval/baseline.json'

// Files that define the truth or the guardrails. Changing them can make a
// score look better without the algorithm getting better.
const PROTECTED = [
  'eval/scenarios/handcrafted.ts',
  'eval/baseline.json',
  'eval/score.ts',
  'eval/resolver.ts',
  'src/lib/routePlan.v0.ts',
  'src/lib/fixtures.ts',
]

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as T)
}

function warnOnProtectedChanges() {
  try {
    const changed = execFileSync('git', ['status', '--porcelain', '--', ...PROTECTED], { encoding: 'utf8' }).trim()
    if (changed) {
      console.log('\n!!! WARNING: protected eval files have uncommitted changes:')
      console.log(changed)
      console.log('!!! Scores below are not trustworthy until a human reviews these changes.\n')
    }
  } catch {
    console.log('(could not run git status to check protected files)')
  }
}

const fmt = (n: number | null) => (n === null ? '—' : n.toFixed(1))
const pct = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`)
const clock = (iso: string) => iso.slice(11, 16) + 'Z'

function printSet(title: string, m: SetMetrics, base: SetMetrics | undefined, detail: boolean) {
  console.log(`\n${title}  (samples ${m.samples}, unresolved routes ${m.unresolved})`)
  if (detail) {
    for (const name of ROUTE_NAMES) {
      const r = m.routes[name]
      const b = base?.routes[name]
      console.log(
        `  ${name.padEnd(11)} n=${String(r.n).padStart(3)}  MAE ${fmt(r.meanAbsError)}m` +
        `${b ? ` (v0 ${fmt(b.meanAbsError)})` : ''}  bias ${fmt(r.meanSignedError)}m  p90 ${fmt(r.p90AbsError)}m`
      )
    }
  }
  const o = m.overall
  console.log(
    `  ${'OVERALL'.padEnd(11)} n=${String(o.n).padStart(3)}  MAE ${fmt(o.meanAbsError)}m` +
    `${base ? ` (v0 ${fmt(base.overall.meanAbsError)})` : ''}  bias ${fmt(o.meanSignedError)}m`
  )
  console.log(
    `  winner matches observed best: ${m.winner.agree}/${m.winner.n} (${pct(m.winner.rate)})` +
    `${base ? ` (v0 ${pct(base.winner.rate)})` : ''}`
  )
}

function scoreSamples(predict: (sample: SampleRecord) => Prediction) {
  const samples = readJsonl<SampleRecord>(SAMPLES)
  const outcomes = new Map(readJsonl<Outcome>(OUTCOMES).map(o => [o.sampleId, o]))
  const tune: ScoredRow[] = []
  const holdout: ScoredRow[] = []
  let errors = 0

  for (const sample of samples) {
    const outcome = outcomes.get(sample.sampleId)
    if (!outcome) continue
    try {
      const row = { prediction: predict(sample), outcome }
      ;(isHoldout(sample.sampleId) ? holdout : tune).push(row)
    } catch (error) {
      errors++
      console.log(`  error planning ${sample.sampleId}: ${(error as Error).message}`)
    }
  }

  return { tune, holdout, errors, samples: samples.length, outcomes: outcomes.size }
}

const predictV1 = (s: SampleRecord) => predictionFromPlan(planRoutes(s.inputs))
const predictV0 = (s: SampleRecord) => predictionFromV0(planRoutesV0(s.inputs).routes, s.inputs.now)

function writeBaseline() {
  const scored = scoreSamples(predictV0)
  const baseline: Baseline = {
    generatedAt: new Date().toISOString(),
    tune: scoreSet(scored.tune),
    holdout: scoreSet(scored.holdout),
  }
  writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + '\n')
  printSet('v0 baseline: tune', baseline.tune, undefined, true)
  printSet('v0 baseline: holdout', baseline.holdout, undefined, false)
  console.log(`\nwrote ${BASELINE}`)
}

function runEval() {
  warnOnProtectedChanges()
  let failed = false

  console.log('Handcrafted guardrails (frozen parameters)')
  for (const scenario of HANDCRAFTED) {
    const failures = checkHandcrafted(planRoutes(scenario.inputs, HANDCRAFTED_PARAMS, scenario.bias ?? 0), scenario.expect)
    console.log(`  ${failures.length ? 'FAIL' : 'pass'}  ${scenario.name}`)
    for (const failure of failures) console.log(`          ${failure}`)
    if (failures.length) failed = true
  }

  const baseline = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline) : null
  const scored = scoreSamples(predictV1)
  console.log(`\nSamples ${scored.samples}, resolved outcomes ${scored.outcomes}, planning errors ${scored.errors}`)
  if (scored.errors) failed = true

  const tune = scoreSet(scored.tune)
  const holdout = scoreSet(scored.holdout)
  printSet('v1 tune set (detail)', tune, baseline?.tune, true)

  const misses = worstMisses(scored.tune, 5)
  if (misses.length) {
    console.log('\n  largest tune misses (predicted − observed):')
    for (const miss of misses) {
      console.log(
        `    ${miss.errorMinutes >= 0 ? '+' : ''}${miss.errorMinutes.toFixed(0)}m  ${miss.route.padEnd(10)} ${miss.sampleId}` +
        `  predicted ${clock(miss.predicted)} observed ${clock(miss.observed)}` +
        `${miss.caughtSailing ? `  caught ${clock(miss.caughtSailing)}` : ''}`
      )
    }
  }

  printSet('v1 holdout set (totals only)', holdout, baseline?.holdout, false)

  if (baseline) {
    const gates = gateAgainstBaseline(holdout, baseline)
    for (const gate of gates) console.log(`GATE FAIL: ${gate}`)
    if (gates.length) failed = true
  } else {
    console.log('\nNo eval/baseline.json yet. A human runs: npm run eval:baseline')
  }

  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS')
  process.exitCode = failed ? 1 : 0
}

if (process.argv.includes('--baseline')) writeBaseline()
else runEval()
