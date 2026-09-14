import { describe, it, expect } from 'vitest'
import { planRoutes } from '../src/lib/routePlan'
import { planRoutesV0 } from '../src/lib/routePlan.v0'
import { at, FIXTURE_NOW, planInputs } from '../src/lib/fixtures'
import { HANDCRAFTED, HANDCRAFTED_PARAMS } from './scenarios/handcrafted'
import {
  checkHandcrafted,
  gateAgainstBaseline,
  isHoldout,
  predictionFromPlan,
  predictionFromV0,
  scoreSet,
  worstMisses,
  type Outcome,
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

describe('split and gates', () => {
  it('assigns holdout deterministically at roughly one in five', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `downtown-2026-09-14T${String(i).padStart(4, '0')}`)
    const holdout = ids.filter(isHoldout).length
    expect(isHoldout(ids[0])).toBe(isHoldout(ids[0]))
    expect(holdout).toBeGreaterThan(150)
    expect(holdout).toBeLessThan(250)
  })

  const set = (mae: number | null, rate: number | null) => ({
    samples: 10,
    unresolved: 0,
    overall: { n: 10, meanAbsError: mae, meanSignedError: 0, p90AbsError: mae },
    routes: {
      DRIVE: { n: 0, meanAbsError: null, meanSignedError: null, p90AbsError: null },
      BAINBRIDGE: { n: 0, meanAbsError: null, meanSignedError: null, p90AbsError: null },
      KINGSTON: { n: 0, meanAbsError: null, meanSignedError: null, p90AbsError: null },
    },
    winner: { n: 10, agree: 0, rate },
  })
  const baseline = { generatedAt: 'x', tune: set(8, 0.5), holdout: set(8, 0.5) }

  it('passes within tolerance and equal agreement', () => {
    expect(gateAgainstBaseline(set(10, 0.5), baseline)).toEqual([])
  })

  it('fails on worse error or lower agreement', () => {
    expect(gateAgainstBaseline(set(10.5, 0.4), baseline)).toEqual([
      'holdout mean absolute error 10.5m is worse than baseline 8.0m by more than 2m',
      'holdout winner agreement 40% is lower than baseline 50%',
    ])
  })
})
