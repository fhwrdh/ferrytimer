// npm run eval            guardrails, then v0 and v1 scored live on identical rows; holdout gates v1 vs v0
// npm run eval:baseline   write eval/baseline.json, a human record of the paired metrics (not used by gates)

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { PARAMS, planRoutes } from '../src/lib/routePlan'
import { planRoutesV0 } from '../src/lib/routePlan.v0'
import type { SampleRecord } from '../src/sampler/runSample'
import { HANDCRAFTED, HANDCRAFTED_PARAMS } from './scenarios/handcrafted'
import {
  checkHandcrafted,
  gateAgainstLive,
  isHoldout,
  paramKeyDiff,
  predictionFromPlan,
  predictionFromV0,
  protectedChangeReport,
  ROUTE_NAMES,
  scoredIdsHash,
  scorePaired,
  skippedGates,
  worstMisses,
  type Baseline,
  type Outcome,
  type PairedMetrics,
  type PairedRow,
  type Prediction,
  type RouteMetrics,
  type WinnerAgreement,
} from './score'

const SAMPLES = 'eval/data/samples.jsonl'
const OUTCOMES = 'eval/data/outcomes.jsonl'
const BASELINE = 'eval/baseline.json'

// Files that define the truth, the guardrails, or how the eval runs. Changing
// them can make a score look better without the algorithm getting better.
const PROTECTED = [
  'eval/scenarios/handcrafted.ts',
  'eval/baseline.json',
  'eval/score.ts',
  'eval/resolver.ts',
  'src/lib/routePlan.v0.ts',
  'src/lib/fixtures.ts',
  'eval/run.ts',
  'eval/resolve.ts',
  'package.json',
  'vitest.config.ts',
  'src/api/ferries.ts',
  'src/lib/planInputs.ts',
  'tsconfig.json',
  'src/sampler/runSample.ts',
  'src/types.ts',
  '.claude/skills/tune-route-plan/SKILL.md',
]

const EVAL_BASE_TAG = 'refs/tags/eval-base'

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as T)
}

// Returns false when the check itself could not run
function warnOnProtectedChanges(): boolean {
  try {
    const changed = execFileSync('git', ['status', '--porcelain', '--', ...PROTECTED], { encoding: 'utf8' }).trim()
    if (changed) {
      console.log('\n!!! WARNING: protected eval files have uncommitted changes:')
      console.log(changed)
      console.log('!!! Scores below are not trustworthy until a human reviews these changes.\n')
    }
    return true
  } catch {
    console.log('FAIL: could not verify protected files (git status failed)')
    return false
  }
}

// Without a tag pinning the start of a tuning session, a tuning agent could
// edit a protected file and then, in the same uncommitted working tree,
// revert it before the last `npm run eval` — or the change simply never shows
// as "uncommitted" once committed. Diffing against the `eval-base` tag (set by
// a human right before a session) catches both committed and uncommitted
// changes for the whole session. Returns true when the run should fail.
function checkProtectedFiles(): boolean {
  let tagExists = true
  try {
    execFileSync('git', ['rev-parse', '-q', '--verify', EVAL_BASE_TAG], { stdio: ['ignore', 'ignore', 'ignore'] })
  } catch {
    tagExists = false
  }

  if (!tagExists) {
    console.log('NOTE: no eval-base tag. Before a tuning session a human runs: git tag -f eval-base')
    return !warnOnProtectedChanges()
  }

  try {
    const diffed = execFileSync('git', ['diff', '--name-only', 'eval-base', '--', ...PROTECTED], { encoding: 'utf8' })
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', ...PROTECTED], { encoding: 'utf8' })
    const changed = [...new Set([...diffed.split('\n'), ...untracked.split('\n')].map(p => p.trim()).filter(Boolean))]
    const { failures, notes } = protectedChangeReport(changed)
    for (const note of notes) console.log(`NOTE: ${note}`)
    for (const failure of failures) console.log(`FAIL: ${failure}`)
    return failures.length > 0
  } catch {
    console.log('FAIL: could not verify protected files (git diff against eval-base failed)')
    return true
  }
}

const fmt = (n: number | null) => (n === null ? '—' : n.toFixed(1))
const signed = (n: number | null) => (n === null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}`)
const pct = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`)
const clock = (iso: string) => iso.slice(11, 16) + 'Z'

const maeLine = (label: string, v0: RouteMetrics, v1: RouteMetrics) =>
  `  ${label.padEnd(11)} paired n=${String(v1.n).padStart(3)}  MAE v0 ${fmt(v0.meanAbsError)}m v1 ${fmt(v1.meanAbsError)}m` +
  `  bias v0 ${signed(v0.meanSignedError)}m v1 ${signed(v1.meanSignedError)}m  p90 v0 ${fmt(v0.p90AbsError)}m v1 ${fmt(v1.p90AbsError)}m`

const winnerLine = (m: PairedMetrics) => {
  const w = (a: WinnerAgreement) => `${a.agree}/${a.n} (${pct(a.rate)})`
  return `  winner matches observed best (${m.winner.fullyResolved} fully resolved rows): v0 ${w(m.winner.v0)}  v1 ${w(m.winner.v1)}`
}

const coverageLine = (m: PairedMetrics, name: (typeof ROUTE_NAMES)[number]) => {
  const r = m.routes[name]
  return `resolved ${r.resolved}, predicted v0 ${r.v0Predicted} v1 ${r.v1Predicted}`
}

function printTune(m: PairedMetrics, rows: PairedRow[]) {
  console.log(`\nTune set (detail)  samples ${m.samples}; errors on rows where the outcome resolved and both v0 and v1 predicted`)
  for (const name of ROUTE_NAMES) {
    console.log(maeLine(name, m.routes[name].v0, m.routes[name].v1))
    console.log(`  ${''.padEnd(11)} coverage: ${coverageLine(m, name)}`)
  }
  console.log(maeLine('FERRY', m.ferryOverall.v0, m.ferryOverall.v1))
  console.log(winnerLine(m))

  const misses = worstMisses(rows.map(row => ({ prediction: row.v1, outcome: row.outcome })), 5)
  if (misses.length) {
    console.log('\n  largest v1 tune misses (predicted − observed):')
    for (const miss of misses) {
      console.log(
        `    ${miss.errorMinutes >= 0 ? '+' : ''}${miss.errorMinutes.toFixed(0)}m  ${miss.route.padEnd(10)} ${miss.sampleId}` +
        `  predicted ${clock(miss.predicted)} observed ${clock(miss.observed)}` +
        `${miss.caughtSailing ? `  caught ${clock(miss.caughtSailing)}` : ''}`
      )
    }
  }
}

function printHoldout(m: PairedMetrics) {
  console.log(`\nHoldout set (totals only)  samples ${m.samples}`)
  const { v0, v1 } = m.ferryOverall
  console.log(`  FERRY       paired n=${String(v1.n).padStart(3)}  MAE v0 ${fmt(v0.meanAbsError)}m v1 ${fmt(v1.meanAbsError)}m`)
  console.log(winnerLine(m))
  for (const name of ['BAINBRIDGE', 'KINGSTON'] as const) {
    console.log(`  ${name.padEnd(11)} coverage: ${coverageLine(m, name)}`)
  }
}

function scoreSamples() {
  const samples = readJsonl<SampleRecord>(SAMPLES)
  const outcomes = new Map(readJsonl<Outcome>(OUTCOMES).map(o => [o.sampleId, o]))
  const tune: PairedRow[] = []
  const holdout: PairedRow[] = []
  const scoredIds: string[] = []
  const errors = { v0: 0, v1: 0 }

  for (const sample of samples) {
    const outcome = outcomes.get(sample.sampleId)
    if (!outcome) continue
    // Split on run time so twin records from different origins stay together
    const inHoldout = isHoldout(sample.now)
    const label = inHoldout ? 'a holdout sample' : sample.sampleId
    let v0: Prediction
    let v1: Prediction
    try {
      v0 = predictionFromV0(planRoutesV0(sample.inputs).routes, sample.inputs.now)
    } catch (error) {
      errors.v0++
      console.log(`  v0 error planning ${label}: ${(error as Error).message}`)
      continue
    }
    try {
      v1 = predictionFromPlan(planRoutes(sample.inputs))
    } catch (error) {
      errors.v1++
      console.log(`  error planning ${label}: ${(error as Error).message}`)
      continue
    }
    ;(inHoldout ? holdout : tune).push({ outcome, v0, v1 })
    scoredIds.push(sample.sampleId)
  }

  return { tune, holdout, scoredIds, errors, samples: samples.length, outcomes: outcomes.size }
}

function writeBaseline() {
  const scored = scoreSamples()
  const baseline: Baseline = {
    generatedAt: new Date().toISOString(),
    sampleCount: scored.scoredIds.length,
    scoredIdsSha256: scoredIdsHash(scored.scoredIds),
    tune: scorePaired(scored.tune),
    holdout: scorePaired(scored.holdout),
  }
  writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + '\n')
  printTune(baseline.tune, scored.tune)
  printHoldout(baseline.holdout)
  console.log(`\nwrote ${BASELINE} (${baseline.sampleCount} scored samples; a record only, gates compare against live v0)`)
}

function runEval() {
  let failed = false
  if (checkProtectedFiles()) failed = true

  const keyDiff = paramKeyDiff(PARAMS, HANDCRAFTED_PARAMS)
  if (keyDiff.length) {
    console.log(
      `FAIL: HANDCRAFTED_PARAMS no longer matches PARAMS keys: ${keyDiff.join(', ')}. ` +
      'A human must update eval/scenarios/handcrafted.ts.'
    )
    failed = true
  }

  console.log('Handcrafted guardrails (frozen parameters)')
  for (const scenario of HANDCRAFTED) {
    const failures = checkHandcrafted(planRoutes(scenario.inputs, HANDCRAFTED_PARAMS, scenario.bias ?? 0), scenario.expect)
    console.log(`  ${failures.length ? 'FAIL' : 'pass'}  ${scenario.name}`)
    for (const failure of failures) console.log(`          ${failure}`)
    if (failures.length) failed = true
  }

  const scored = scoreSamples()
  console.log(
    `\nSamples ${scored.samples}, resolved outcomes ${scored.outcomes}, scored ${scored.scoredIds.length}` +
    ` (tune ${scored.tune.length}, holdout ${scored.holdout.length}), planning errors v1 ${scored.errors.v1} v0 ${scored.errors.v0}`
  )
  if (scored.errors.v1) failed = true

  const tune = scorePaired(scored.tune)
  const holdout = scorePaired(scored.holdout)
  printTune(tune, scored.tune)
  printHoldout(holdout)

  console.log('\n(baseline.json is a record only; gates compare against live v0)')
  if (existsSync(BASELINE)) {
    try {
      const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Partial<Baseline>
      if (baseline.scoredIdsSha256 !== scoredIdsHash(scored.scoredIds)) {
        console.log(`note: scored samples changed since baseline.json was written (${baseline.sampleCount ?? '?'} then, ${scored.scoredIds.length} now)`)
      }
    } catch {
      console.log('note: eval/baseline.json could not be read')
    }
  }

  for (const gate of skippedGates(holdout)) console.log(`GATE SKIPPED: insufficient data (${gate})`)
  const gates = gateAgainstLive(holdout)
  for (const gate of gates) console.log(`GATE FAIL: ${gate}`)
  if (gates.length) failed = true

  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS')
  process.exitCode = failed ? 1 : 0
}

if (process.argv.includes('--baseline')) writeBaseline()
else runEval()
