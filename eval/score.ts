// Pure scoring for the eval harness. Error sign: predicted minus observed, so
// positive means the algorithm said you'd arrive later than you did.

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

export interface Baseline {
  generatedAt: string
  tune: SetMetrics
  holdout: SetMetrics
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

// FNV-1a 32-bit; stable across runs and machines
export function isHoldout(sampleId: string): boolean {
  let hash = 0x811c9dc5
  for (let i = 0; i < sampleId.length; i++) {
    hash ^= sampleId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % 5 === 0
}

const pct = (rate: number) => `${Math.round(rate * 100)}%`

export function gateAgainstBaseline(holdout: SetMetrics, baseline: Baseline): string[] {
  const failures: string[] = []
  const mae = holdout.overall.meanAbsError
  const baseMae = baseline.holdout.overall.meanAbsError
  if (mae !== null && baseMae !== null && mae > baseMae + MAE_TOLERANCE_MINUTES) {
    failures.push(
      `holdout mean absolute error ${mae.toFixed(1)}m is worse than baseline ${baseMae.toFixed(1)}m by more than ${MAE_TOLERANCE_MINUTES}m`
    )
  }
  const rate = holdout.winner.rate
  const baseRate = baseline.holdout.winner.rate
  if (rate !== null && baseRate !== null && rate < baseRate) {
    failures.push(`holdout winner agreement ${pct(rate)} is lower than baseline ${pct(baseRate)}`)
  }
  return failures
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
