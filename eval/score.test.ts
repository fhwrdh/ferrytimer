import { describe, it, expect } from 'vitest'
import { PARAMS, planRoutes } from '../src/lib/routePlan'
import { planRoutesV0 } from '../src/lib/routePlan.v0'
import { at, FIXTURE_NOW, planInputs } from '../src/lib/fixtures'
import { HANDCRAFTED, HANDCRAFTED_PARAMS } from './scenarios/handcrafted'
import {
  checkHandcrafted,
  gateAgainstLive,
  isHoldout,
  paramKeyDiff,
  predictionFromPlan,
  predictionFromV0,
  scoredIdsHash,
  scorePaired,
  scoreSet,
  skippedGates,
  worstMisses,
  type Outcome,
  type PairedMetrics,
  type PairedRow,
  type Prediction,
  type ScoredRow,
} from './score'

function outcome(sampleId: string, arrivals: Partial<Record<'DRIVE' | 'BAINBRIDGE' | 'KINGSTON', string>>, best: Outcome['observedBest']): Outcome {
  const r = (a?: string) => (a ? { arrivalAt: a, caughtSailing: null } : { unresolved: 'no data' })
  return { sampleId, routes: { DRIVE: r(arrivals.DRIVE), BAINBRIDGE: r(arrivals.BAINBRIDGE), KINGSTON: r(arrivals.KINGSTON) }, observedBest: best }
}

describe('handcrafted guardrails', () => {
  for (const scenario of HANDCRAFTED) {
    it(`passes: ${scenario.name}`, () => {
      const plan = planRoutes(scenario.inputs, HANDCRAFTED_PARAMS, scenario.bias ?? 0)
      expect(checkHandcrafted(plan, scenario.expect)).toEqual([])
    })
  }

  it('reports each mismatch', () => {
    const plan = planRoutes(planInputs(), HANDCRAFTED_PARAMS)
    expect(checkHandcrafted(plan, {
      winner: 'KINGSTON',
      isCloseCall: true,
      routes: { BAINBRIDGE: { departure: at(90), arrivalAt: at(120) } },
    })).toEqual([
      'winner: expected KINGSTON, got BAINBRIDGE',
      'isCloseCall: expected true, got false',
      `BAINBRIDGE departure: expected ${at(90)}, got ${at(40)}`,
      `BAINBRIDGE arrivalAt: expected ${at(120)} ±2m, got ${at(107)}`,
    ])
  })
})

describe('predictions', () => {
  it('reads v1 arrivals and winner', () => {
    expect(predictionFromPlan(planRoutes(planInputs()))).toEqual({
      arrivals: { DRIVE: at(150), BAINBRIDGE: at(107), KINGSTON: at(147) },
      winner: 'BAINBRIDGE',
    })
  })

  it('derives v0 arrivals from now plus total minutes', () => {
    const prediction = predictionFromV0(planRoutesV0(planInputs()).routes, FIXTURE_NOW)
    expect(prediction.arrivals.DRIVE).toBe(at(150))
    expect(prediction.winner).toBe('BAINBRIDGE')
  })

  it('drops unreachable routes from v0 arrivals', () => {
    const prediction = predictionFromV0(planRoutesV0(planInputs({ bainbridge: { schedule: [] } })).routes, FIXTURE_NOW)
    expect(prediction.arrivals.BAINBRIDGE).toBeNull()
  })
})

describe('scoreSet', () => {
  const rows: ScoredRow[] = [
    {
      prediction: { arrivals: { DRIVE: at(100), BAINBRIDGE: at(90), KINGSTON: null }, winner: 'BAINBRIDGE' },
      outcome: outcome('a', { DRIVE: at(110), BAINBRIDGE: at(80) }, 'BAINBRIDGE'),
    },
    {
      prediction: { arrivals: { DRIVE: at(100), BAINBRIDGE: at(90), KINGSTON: at(95) }, winner: 'BAINBRIDGE' },
      outcome: outcome('b', { DRIVE: at(96), KINGSTON: at(95) }, 'KINGSTON'),
    },
  ]

  it('computes per-route and overall errors in minutes', () => {
    const m = scoreSet(rows)
    expect(m.samples).toBe(2)
    expect(m.routes.DRIVE).toEqual({ n: 2, meanAbsError: 7, meanSignedError: -3, p90AbsError: 10 })
    expect(m.routes.BAINBRIDGE).toEqual({ n: 1, meanAbsError: 10, meanSignedError: 10, p90AbsError: 10 })
    expect(m.routes.KINGSTON).toEqual({ n: 1, meanAbsError: 0, meanSignedError: 0, p90AbsError: 0 })
    expect(m.overall.n).toBe(4)
    expect(m.overall.meanAbsError).toBe(6)
    expect(m.unresolved).toBe(2)
    expect(m.winner).toEqual({ n: 2, agree: 1, rate: 0.5 })
  })

  it('returns null metrics for an empty set', () => {
    const m = scoreSet([])
    expect(m.overall).toEqual({ n: 0, meanAbsError: null, meanSignedError: null, p90AbsError: null })
    expect(m.winner.rate).toBeNull()
  })

  it('lists the largest misses first', () => {
    expect(worstMisses(rows, 2)).toEqual([
      { sampleId: 'a', route: 'DRIVE', errorMinutes: -10, predicted: at(100), observed: at(110), caughtSailing: null },
      { sampleId: 'a', route: 'BAINBRIDGE', errorMinutes: 10, predicted: at(90), observed: at(80), caughtSailing: null },
    ])
  })
})

describe('split', () => {
  const nows = Array.from({ length: 1000 }, (_, i) => new Date(Date.parse(FIXTURE_NOW) + i * 20 * 60_000).toISOString())

  it('assigns holdout deterministically at roughly one in five', () => {
    const holdout = nows.filter(isHoldout).length
    expect(isHoldout(nows[0])).toBe(isHoldout(nows[0]))
    expect(holdout).toBeGreaterThan(150)
    expect(holdout).toBeLessThan(250)
  })

  it('keeps twin records from the same run (same now, different origin) in the same split', () => {
    const twins = nows.map(now => [
      { sampleId: `downtown-${now}`, now },
      { sampleId: `northgate-${now}`, now },
    ])
    for (const [a, b] of twins) expect(isHoldout(a.now)).toBe(isHoldout(b.now))
    // Hashing sampleId instead would split some twins apart
    expect(twins.some(([a, b]) => isHoldout(a.sampleId) !== isHoldout(b.sampleId))).toBe(true)
  })
})

const pred = (arrivals: Partial<Record<'DRIVE' | 'BAINBRIDGE' | 'KINGSTON', string>>, winner: Prediction['winner']): Prediction => ({
  arrivals: { DRIVE: arrivals.DRIVE ?? null, BAINBRIDGE: arrivals.BAINBRIDGE ?? null, KINGSTON: arrivals.KINGSTON ?? null },
  winner,
})

describe('scorePaired', () => {
  const rows: PairedRow[] = [
    // all resolved; both predict everything
    {
      outcome: outcome('a', { DRIVE: at(100), BAINBRIDGE: at(80), KINGSTON: at(90) }, 'BAINBRIDGE'),
      v0: pred({ DRIVE: at(100), BAINBRIDGE: at(84), KINGSTON: at(90) }, 'BAINBRIDGE'),
      v1: pred({ DRIVE: at(100), BAINBRIDGE: at(82), KINGSTON: at(92) }, 'KINGSTON'),
    },
    // KINGSTON unresolved; v1 skips BAINBRIDGE (a hard trip v0 got badly wrong)
    {
      outcome: outcome('b', { DRIVE: at(100), BAINBRIDGE: at(80) }, 'BAINBRIDGE'),
      v0: pred({ DRIVE: at(100), BAINBRIDGE: at(120), KINGSTON: at(95) }, 'DRIVE'),
      v1: pred({ DRIVE: at(100), KINGSTON: at(95) }, 'DRIVE'),
    },
  ]

  it('counts errors only on rows where the outcome resolved and both algorithms predicted', () => {
    const m = scorePaired(rows)
    expect(m.samples).toBe(2)
    expect(m.routes.BAINBRIDGE).toEqual({
      resolved: 2,
      v0Predicted: 2,
      v1Predicted: 1,
      v0: { n: 1, meanAbsError: 4, meanSignedError: 4, p90AbsError: 4 },
      v1: { n: 1, meanAbsError: 2, meanSignedError: 2, p90AbsError: 2 },
    })
    expect(m.routes.KINGSTON).toMatchObject({ resolved: 1, v0Predicted: 1, v1Predicted: 1 })
    expect(m.routes.KINGSTON.v1.meanAbsError).toBe(2)
    expect(m.routes.DRIVE.v0.n).toBe(2)
  })

  it('excludes DRIVE from ferry-overall', () => {
    const m = scorePaired([{
      outcome: outcome('c', { DRIVE: at(100), BAINBRIDGE: at(80), KINGSTON: at(90) }, 'BAINBRIDGE'),
      v0: pred({ DRIVE: at(130), BAINBRIDGE: at(82), KINGSTON: at(94) }, 'BAINBRIDGE'),
      v1: pred({ DRIVE: at(160), BAINBRIDGE: at(80), KINGSTON: at(90) }, 'BAINBRIDGE'),
    }])
    expect(m.ferryOverall.v0).toEqual({ n: 2, meanAbsError: 3, meanSignedError: 3, p90AbsError: 4 })
    expect(m.ferryOverall.v1).toEqual({ n: 2, meanAbsError: 0, meanSignedError: 0, p90AbsError: 0 })
  })

  it('scores winner agreement only on fully resolved rows', () => {
    const m = scorePaired(rows)
    expect(m.winner.fullyResolved).toBe(1)
    expect(m.winner.v0).toEqual({ n: 1, agree: 1, rate: 1 })
    expect(m.winner.v1).toEqual({ n: 1, agree: 0, rate: 0 })
  })

  it('returns null metrics and no winner rows for an empty set', () => {
    const m = scorePaired([])
    expect(m.ferryOverall.v1.meanAbsError).toBeNull()
    expect(m.winner.v0.rate).toBeNull()
    expect(m.routes.KINGSTON.resolved).toBe(0)
  })
})

describe('gateAgainstLive', () => {
  const route = (mae: number | null) => ({ n: mae === null ? 0 : 10, meanAbsError: mae, meanSignedError: mae, p90AbsError: mae })
  const coverage = (resolved: number, v0Predicted: number, v1Predicted: number) =>
    ({ resolved, v0Predicted, v1Predicted, v0: route(null), v1: route(null) })
  const holdout = (opts: {
    mae0?: number | null; mae1?: number | null; rate0?: number | null; rate1?: number | null
    bainbridge?: [number, number, number]; kingston?: [number, number, number]
  } = {}): PairedMetrics => {
    const { mae0 = 8, mae1 = 8, rate0 = 0.5, rate1 = 0.5, bainbridge = [10, 10, 10], kingston = [10, 10, 10] } = opts
    const agreement = (rate: number | null) => ({ n: rate === null ? 0 : 10, agree: rate === null ? 0 : rate * 10, rate })
    return {
      samples: 10,
      routes: { DRIVE: coverage(10, 10, 10), BAINBRIDGE: coverage(...bainbridge), KINGSTON: coverage(...kingston) },
      ferryOverall: { v0: route(mae0), v1: route(mae1) },
      winner: { fullyResolved: 10, v0: agreement(rate0), v1: agreement(rate1) },
    }
  }

  it('passes within tolerance, equal agreement and equal coverage', () => {
    expect(gateAgainstLive(holdout({ mae1: 10 }))).toEqual([])
    expect(skippedGates(holdout())).toEqual([])
  })

  it('fails when v1 ferry error is worse than live v0 by more than the tolerance', () => {
    expect(gateAgainstLive(holdout({ mae1: 10.5 }))).toEqual([
      'holdout ferry mean absolute error 10.5m is worse than v0 8.0m by more than 2m',
    ])
  })

  it('fails when v1 winner agreement is lower than live v0', () => {
    expect(gateAgainstLive(holdout({ rate1: 0.4 }))).toEqual(['holdout winner agreement 40% is lower than v0 50%'])
  })

  it('fails when v1 predicts fewer resolved ferry trips than v0', () => {
    expect(gateAgainstLive(holdout({ kingston: [10, 9, 7] }))).toEqual([
      'KINGSTON: v1 predicts fewer resolved trips than v0 (7 vs 9 of 10)',
    ])
  })

  it('does not fail but reports skipped gates when metrics are null', () => {
    const empty = holdout({ mae0: null, mae1: null, rate0: null, rate1: 0.1, bainbridge: [0, 0, 0], kingston: [0, 0, 0] })
    expect(gateAgainstLive(empty)).toEqual([])
    expect(skippedGates(empty)).toEqual([
      'ferry mean absolute error',
      'winner agreement',
      'BAINBRIDGE coverage',
      'KINGSTON coverage',
    ])
  })
})

describe('paramKeyDiff', () => {
  it('matches the frozen handcrafted parameters to PARAMS today', () => {
    expect(paramKeyDiff(PARAMS, HANDCRAFTED_PARAMS)).toEqual([])
  })

  it('reports deep keys missing on either side', () => {
    expect(paramKeyDiff(
      { a: 1, crossingMinutes: { BAINBRIDGE: 35, KINGSTON: 30, SOUTHWORTH: 40 } },
      { a: 1, b: 2, crossingMinutes: { BAINBRIDGE: 35, KINGSTON: 30 } },
    )).toEqual(['+crossingMinutes.SOUTHWORTH', '-b'])
  })
})

describe('scoredIdsHash', () => {
  it('is a stable sha256 hex independent of order', () => {
    expect(scoredIdsHash(['b', 'a'])).toBe(scoredIdsHash(['a', 'b']))
    expect(scoredIdsHash(['a'])).toMatch(/^[0-9a-f]{64}$/)
    expect(scoredIdsHash(['a'])).not.toBe(scoredIdsHash(['a', 'b']))
  })
})
