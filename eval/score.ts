// Pure scoring for the eval harness. Error sign: predicted minus observed, so
// positive means the algorithm said you'd arrive later than you did.

import { createHash } from 'node:crypto'
import type { RoutePlan } from '../src/lib/routePlan'
import type { RouteOption } from '../src/types'

export type RouteName = 'DRIVE' | 'BAINBRIDGE' | 'KINGSTON'
export const ROUTE_NAMES: RouteName[] = ['DRIVE', 'BAINBRIDGE', 'KINGSTON']

export type RouteOutcome = { arrivalAt: string; caughtSailing: string | null } | { unresolved: string }

export interface Outcome {
  sampleId: string
  routes: Record<RouteName, RouteOutcome>
  observedBest: RouteName | null
}

export interface Prediction {
  arrivals: Record<RouteName, string | null>
  winner: RouteName | null
}

export interface RouteMetrics {
  n: number
  meanAbsError: number | null
  meanSignedError: number | null
  p90AbsError: number | null
}

export interface SetMetrics {
  samples: number
  unresolved: number
  overall: RouteMetrics
  routes: Record<RouteName, RouteMetrics>
  winner: { n: number; agree: number; rate: number | null }
}

export interface ScoredRow {
  prediction: Prediction
  outcome: Outcome
}

export interface Miss {
  sampleId: string
  route: RouteName
  errorMinutes: number
  predicted: string
  observed: string
  caughtSailing: string | null
}

// v0 and v1 scored on the same sample. Paired metrics only count a route when
// the outcome resolved AND both algorithms predicted it, so neither side can
// improve its error by declining to predict hard trips.
export interface PairedRow {
  outcome: Outcome
  v0: Prediction
  v1: Prediction
}

export interface PairedRouteMetrics {
  resolved: number
  v0Predicted: number
  v1Predicted: number
  v0: RouteMetrics
  v1: RouteMetrics
}

export interface WinnerAgreement {
  n: number
  agree: number
  rate: number | null
}

export interface PairedMetrics {
  samples: number
  routes: Record<RouteName, PairedRouteMetrics>
  ferryOverall: { v0: RouteMetrics; v1: RouteMetrics }
  // Only rows where all three routes resolved, so observedBest is a real best
  winner: { fullyResolved: number; v0: WinnerAgreement; v1: WinnerAgreement }
}

// A record for humans. Gates compare against v0 scored live, not this file.
export interface Baseline {
  generatedAt: string
  sampleCount: number
  scoredIdsSha256: string
  tune: PairedMetrics
  holdout: PairedMetrics
}

export interface HandcraftedExpect {
  winner: RouteName
  isCloseCall: boolean
  routes?: Partial<Record<RouteName, {
    departure?: string | null
    fallbackDeparture?: string | null
    arrivalAt?: string | null
  }>>
}

export const MAE_TOLERANCE_MINUTES = 2
const ARRIVAL_TOLERANCE_MS = 2 * 60_000

const emptyArrivals = (): Record<RouteName, string | null> => ({ DRIVE: null, BAINBRIDGE: null, KINGSTON: null })

export function predictionFromPlan(plan: RoutePlan): Prediction {
  const arrivals = emptyArrivals()
  for (const route of plan.routes) arrivals[route.name as RouteName] = route.arrivalAt
  const winner = plan.winner && Number.isFinite(plan.winner.totalTimeMinutes) ? (plan.winner.name as RouteName) : null
  return { arrivals, winner }
}

export function predictionFromV0(routes: RouteOption[], now: string): Prediction {
  const arrivals = emptyArrivals()
  for (const route of routes) {
    if (Number.isFinite(route.totalTimeMinutes)) {
      arrivals[route.name as RouteName] = new Date(Date.parse(now) + route.totalTimeMinutes * 60_000).toISOString()
    }
  }
  const first = routes[0]
  const winner = first && Number.isFinite(first.totalTimeMinutes) ? (first.name as RouteName) : null
  return { arrivals, winner }
}

function metrics(errors: number[]): RouteMetrics {
  if (errors.length === 0) return { n: 0, meanAbsError: null, meanSignedError: null, p90AbsError: null }
  const abs = errors.map(Math.abs).sort((a, b) => a - b)
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
  return {
    n: errors.length,
    meanAbsError: sum(abs) / abs.length,
    meanSignedError: sum(errors) / errors.length,
    p90AbsError: abs[Math.ceil(0.9 * abs.length) - 1],
  }
}

function errorsFor(row: ScoredRow, name: RouteName): number | null {
  const observed = row.outcome.routes[name]
  const predicted = row.prediction.arrivals[name]
  if (!('arrivalAt' in observed) || predicted === null) return null
  return (Date.parse(predicted) - Date.parse(observed.arrivalAt)) / 60_000
}

export function scoreSet(rows: ScoredRow[]): SetMetrics {
  const perRoute: Record<RouteName, number[]> = { DRIVE: [], BAINBRIDGE: [], KINGSTON: [] }
  let unresolved = 0
  let winnerN = 0
  let agree = 0

  for (const row of rows) {
    for (const name of ROUTE_NAMES) {
      if ('unresolved' in row.outcome.routes[name]) unresolved++
      const error = errorsFor(row, name)
      if (error !== null) perRoute[name].push(error)
    }
    if (row.prediction.winner && row.outcome.observedBest) {
      winnerN++
      if (row.prediction.winner === row.outcome.observedBest) agree++
    }
  }

  return {
    samples: rows.length,
    unresolved,
    overall: metrics(ROUTE_NAMES.flatMap(name => perRoute[name])),
    routes: {
      DRIVE: metrics(perRoute.DRIVE),
      BAINBRIDGE: metrics(perRoute.BAINBRIDGE),
      KINGSTON: metrics(perRoute.KINGSTON),
    },
    winner: { n: winnerN, agree, rate: winnerN === 0 ? null : agree / winnerN },
  }
}

export function worstMisses(rows: ScoredRow[], limit: number): Miss[] {
  const misses: Miss[] = []
  for (const row of rows) {
    for (const name of ROUTE_NAMES) {
      const observed = row.outcome.routes[name]
      const predicted = row.prediction.arrivals[name]
      const error = errorsFor(row, name)
      if (error === null || !('arrivalAt' in observed) || predicted === null) continue
      misses.push({
        sampleId: row.outcome.sampleId,
        route: name,
        errorMinutes: error,
        predicted,
        observed: observed.arrivalAt,
        caughtSailing: observed.caughtSailing,
      })
    }
  }
  return misses
    .sort((a, b) => Math.abs(b.errorMinutes) - Math.abs(a.errorMinutes))
    .slice(0, limit)
}

// FNV-1a 32-bit; stable across runs and machines. Callers pass the sample's
// `now` (run time), not its sampleId: records from different origins in the
// same sampler run share `now` and nearly all ferry inputs, so they must land
// in the same split or the holdout leaks.
export function isHoldout(key: string): boolean {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % 5 === 0
}

const FERRY_NAMES: RouteName[] = ['BAINBRIDGE', 'KINGSTON']

function arrivalError(predicted: string | null, observed: RouteOutcome): number | null {
  if (!('arrivalAt' in observed) || predicted === null) return null
  return (Date.parse(predicted) - Date.parse(observed.arrivalAt)) / 60_000
}

function agreement(n: number, agree: number): WinnerAgreement {
  return { n, agree, rate: n === 0 ? null : agree / n }
}

export function scorePaired(rows: PairedRow[]): PairedMetrics {
  const errors = (): Record<RouteName, number[]> => ({ DRIVE: [], BAINBRIDGE: [], KINGSTON: [] })
  const v0Errors = errors()
  const v1Errors = errors()
  const coverage = Object.fromEntries(
    ROUTE_NAMES.map(name => [name, { resolved: 0, v0Predicted: 0, v1Predicted: 0 }])
  ) as Record<RouteName, { resolved: number; v0Predicted: number; v1Predicted: number }>
  let fullyResolved = 0
  const winners = { v0: { n: 0, agree: 0 }, v1: { n: 0, agree: 0 } }

  for (const row of rows) {
    let allResolved = true
    for (const name of ROUTE_NAMES) {
      const observed = row.outcome.routes[name]
      if (!('arrivalAt' in observed)) {
        allResolved = false
        continue
      }
      coverage[name].resolved++
      if (row.v0.arrivals[name] !== null) coverage[name].v0Predicted++
      if (row.v1.arrivals[name] !== null) coverage[name].v1Predicted++
      const e0 = arrivalError(row.v0.arrivals[name], observed)
      const e1 = arrivalError(row.v1.arrivals[name], observed)
      if (e0 !== null && e1 !== null) {
        v0Errors[name].push(e0)
        v1Errors[name].push(e1)
      }
    }
    if (allResolved && row.outcome.observedBest) {
      fullyResolved++
      for (const key of ['v0', 'v1'] as const) {
        // Every fully-resolved row counts toward the denominator, even when the
        // algorithm names no winner: a null winner is a disagreement, not a
        // skip, so an algorithm cannot raise its rate by declining to pick.
        winners[key].n++
        if (row[key].winner === row.outcome.observedBest) winners[key].agree++
      }
    }
  }

  const routes = Object.fromEntries(
    ROUTE_NAMES.map(name => [name, { ...coverage[name], v0: metrics(v0Errors[name]), v1: metrics(v1Errors[name]) }])
  ) as Record<RouteName, PairedRouteMetrics>

  return {
    samples: rows.length,
    routes,
    ferryOverall: {
      v0: metrics(FERRY_NAMES.flatMap(name => v0Errors[name])),
      v1: metrics(FERRY_NAMES.flatMap(name => v1Errors[name])),
    },
    winner: {
      fullyResolved,
      v0: agreement(winners.v0.n, winners.v0.agree),
      v1: agreement(winners.v1.n, winners.v1.agree),
    },
  }
}

const pct = (rate: number) => `${Math.round(rate * 100)}%`

// Holdout gates: v1 against v0 scored live on the same rows. DRIVE is excluded
// because its truth is the sample's own drive prediction (error always zero).
export function gateAgainstLive(holdout: PairedMetrics): string[] {
  const failures: string[] = []
  const mae1 = holdout.ferryOverall.v1.meanAbsError
  const mae0 = holdout.ferryOverall.v0.meanAbsError
  if (mae1 !== null && mae0 !== null && mae1 > mae0 + MAE_TOLERANCE_MINUTES) {
    failures.push(
      `holdout ferry mean absolute error ${mae1.toFixed(1)}m is worse than v0 ${mae0.toFixed(1)}m by more than ${MAE_TOLERANCE_MINUTES}m`
    )
  }
  const rate1 = holdout.winner.v1.rate
  const rate0 = holdout.winner.v0.rate
  if (rate1 !== null && rate0 !== null && rate1 < rate0) {
    failures.push(`holdout winner agreement ${pct(rate1)} is lower than v0 ${pct(rate0)}`)
  }
  for (const name of FERRY_NAMES) {
    const r = holdout.routes[name]
    if (r.v1Predicted < r.v0Predicted) {
      failures.push(
        `${name}: v1 predicts fewer resolved trips than v0 (${r.v1Predicted} vs ${r.v0Predicted} of ${r.resolved})`
      )
    }
  }
  return failures
}

// Gates gateAgainstLive could not evaluate for lack of data
export function skippedGates(holdout: PairedMetrics): string[] {
  const skipped: string[] = []
  if (holdout.ferryOverall.v1.meanAbsError === null || holdout.ferryOverall.v0.meanAbsError === null) {
    skipped.push('ferry mean absolute error')
  }
  if (holdout.winner.v1.rate === null || holdout.winner.v0.rate === null) skipped.push('winner agreement')
  for (const name of FERRY_NAMES) {
    if (holdout.routes[name].resolved === 0) skipped.push(`${name} coverage`)
  }
  return skipped
}

function deepKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.keys(value).flatMap(key => deepKeys((value as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key))
}

// Deep key difference: "+key" exists only in a, "-key" only in b. Empty when the shapes match.
export function paramKeyDiff(a: object, b: object): string[] {
  const keysA = new Set(deepKeys(a))
  const keysB = new Set(deepKeys(b))
  return [
    ...[...keysA].filter(k => !keysB.has(k)).sort().map(k => `+${k}`),
    ...[...keysB].filter(k => !keysA.has(k)).sort().map(k => `-${k}`),
  ]
}

// Pure decision for eval/run.ts's protected-file gate: given the paths of
// protected files that changed since the `eval-base` tag (committed or not),
// decide what fails the run and what's merely a note. eval/baseline.json is
// the one protected file a human is expected to regenerate after tagging, so
// it never fails on its own.
export function protectedChangeReport(paths: string[]): { failures: string[]; notes: string[] } {
  const baseline = 'eval/baseline.json'
  const offenders = paths.filter(p => p !== baseline)
  const failures = offenders.length ? [`protected eval files changed since eval-base: ${offenders.join(', ')}`] : []
  const notes = paths.includes(baseline) ? [`${baseline} changed since eval-base (allowed: a human regenerates it)`] : []
  return { failures, notes }
}

export function scoredIdsHash(sampleIds: string[]): string {
  return createHash('sha256').update([...sampleIds].sort().join('\n')).digest('hex')
}

export function checkHandcrafted(plan: RoutePlan, expect: HandcraftedExpect): string[] {
  const failures: string[] = []
  const winner = plan.winner?.name ?? null
  if (winner !== expect.winner) failures.push(`winner: expected ${expect.winner}, got ${winner}`)
  if (plan.isCloseCall !== expect.isCloseCall) {
    failures.push(`isCloseCall: expected ${expect.isCloseCall}, got ${plan.isCloseCall}`)
  }

  for (const name of ROUTE_NAMES) {
    const want = expect.routes?.[name]
    if (!want) continue
    const route = plan.routes.find(r => r.name === name)
    if (!route) {
      failures.push(`${name}: route missing from plan`)
      continue
    }
    if (want.departure !== undefined) {
      const got = route.nextDeparture ? route.nextDeparture.toISOString() : null
      if (got !== want.departure) failures.push(`${name} departure: expected ${want.departure}, got ${got}`)
    }
    if (want.fallbackDeparture !== undefined) {
      const got = route.fallback?.departure ?? null
      if (got !== want.fallbackDeparture) {
        failures.push(`${name} fallbackDeparture: expected ${want.fallbackDeparture}, got ${got}`)
      }
    }
    if (want.arrivalAt !== undefined) {
      const got = route.arrivalAt
      const ok = want.arrivalAt === null
        ? got === null
        : got !== null && Math.abs(Date.parse(got) - Date.parse(want.arrivalAt)) <= ARRIVAL_TOLERANCE_MS
      if (!ok) failures.push(`${name} arrivalAt: expected ${want.arrivalAt} ±2m, got ${got}`)
    }
  }

  return failures
}
