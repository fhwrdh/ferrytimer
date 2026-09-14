import { describe, it, expect } from 'vitest'
import { PARAMS, planRoutes, selectHomeLegTimes } from './routePlan'
import { at, planInputs, vessel } from './fixtures'
import type { RecordedVessel } from './planInputs'

const route = (plan: ReturnType<typeof planRoutes>, name: string) => plan.routes.find(r => r.name === name)!

describe('planRoutes', () => {
  it('prices each route with crossing minutes and the timed home leg nearest landing', () => {
    const plan = planRoutes(planInputs())
    expect(plan.routes.map(r => [r.name, r.totalTimeMinutes, r.arrivalAt])).toEqual([
      ['BAINBRIDGE', 107, at(107)], // 20 drive + 20 wait + 35 crossing + 32 home (leg at +75)
      ['KINGSTON', 147, at(147)],   // 60 drive + 35 wait + 30 crossing + 22 home (leg at +125)
      ['DRIVE', 150, at(150)],
    ])
    expect(plan.winner?.name).toBe('BAINBRIDGE')
    expect(plan.isCloseCall).toBe(false)
    expect(plan.closeCallGap).toBe(40)
    expect(plan.warnings).toEqual([])
  })

  it('records sailings inside the boarding buffer as missed', () => {
    const kingstonRoute = route(planRoutes(planInputs()), 'KINGSTON')
    expect(kingstonRoute.missedSailings).toEqual([new Date(at(45))])
    expect(kingstonRoute.nextDeparture).toEqual(new Date(at(95)))
  })

  it('rolls past a full sailing to the next one and warns', () => {
    const plan = planRoutes(planInputs({
      kingston: { spaces: [{ departure: at(95), driveUpSpaceCount: 0, totalSpaces: 200 }] },
    }))
    const kingstonRoute = route(plan, 'KINGSTON')
    expect(kingstonRoute.nextDeparture).toEqual(new Date(at(145)))
    expect(kingstonRoute.totalTimeMinutes).toBe(198) // 60 + 85 + 30 + 23
    expect(plan.warnings).toEqual(['Kingston: 1 full sailing skipped'])
  })

  it('keeps a nearly full sailing, adds the fallback, and judges the close call on it', () => {
    const plan = planRoutes(planInputs({
      bainbridge: { spaces: [{ departure: at(40), driveUpSpaceCount: 5, totalSpaces: 200 }] },
    }))
    const b = route(plan, 'BAINBRIDGE')
    expect(b.spaceState).toBe('nearly-full')
    expect(b.totalTimeMinutes).toBe(107)
    expect(b.fallback).toEqual({ departure: at(90), totalMinutes: 159 }) // 20 + 70 + 35 + 34
    expect(b.decisionMinutes).toBe(159)
    expect(plan.winner?.name).toBe('BAINBRIDGE')
    expect(plan.isCloseCall).toBe(true)
    expect(plan.closeCallGap).toBe(3) // KINGSTON 147 vs DRIVE 150 by decision time
  })

  it('makes decision time Infinity when a nearly full sailing has no fallback', () => {
    const plan = planRoutes(planInputs({
      bainbridge: {
        schedule: [{ departure: at(40), arrival: null, vesselName: 'Wenatchee' }],
        spaces: [{ departure: at(40), driveUpSpaceCount: 5, totalSpaces: 200 }],
      },
    }))
    expect(route(plan, 'BAINBRIDGE').decisionMinutes).toBe(Infinity)
    expect(plan.isCloseCall).toBe(true)
  })

  it('delays a sailing when its vessel is heading to the departing terminal', () => {
    const plan = planRoutes(planInputs({
      vessels: [vessel({ vesselName: 'Wenatchee', eta: at(40), arrivingTerminalId: 7 })],
    }))
    const b = route(plan, 'BAINBRIDGE')
    expect(b.nextDeparture).toEqual(new Date(at(55)))
    expect(b.totalTimeMinutes).toBe(122) // 20 + 35 + 35 + 32 (leg at +75 is 15 min from +90)
  })

  it('ignores an ETA for a vessel heading to a different terminal', () => {
    const plan = planRoutes(planInputs({
      vessels: [vessel({ vesselName: 'Wenatchee', eta: at(40), arrivingTerminalId: 3 })],
    }))
    expect(route(plan, 'BAINBRIDGE').nextDeparture).toEqual(new Date(at(40)))
  })

  it('falls back to name-only matching for vessels recorded without terminal fields', () => {
    const legacy = { vesselName: 'Wenatchee', eta: at(40) } as RecordedVessel
    const plan = planRoutes(planInputs({ vessels: [legacy] }))
    expect(route(plan, 'BAINBRIDGE').nextDeparture).toEqual(new Date(at(55)))
  })

  it('uses the live home leg and warns when no timed leg is close enough', () => {
    const plan = planRoutes(planInputs({
      bainbridge: { homeLegs: [{ departAt: null, minutes: 30 }, { departAt: at(200), minutes: 40 }] },
    }))
    expect(route(plan, 'BAINBRIDGE').totalTimeMinutes).toBe(105)
    expect(plan.warnings).toEqual(['Bainbridge: drive home priced with current traffic'])
  })

  it('applies the ferry bias to the drive-around route', () => {
    const inputs = planInputs({ drive: { minutes: 100, summary: null } })
    expect(planRoutes(inputs).winner?.name).toBe('DRIVE')
    const biased = planRoutes(inputs, PARAMS, 10)
    expect(biased.winner?.name).toBe('BAINBRIDGE')
    expect(route(biased, 'DRIVE').decisionMinutes).toBe(110)
    expect(biased.isCloseCall).toBe(true)
  })

  it('marks a route with no catchable sailings as unreachable', () => {
    const plan = planRoutes(planInputs({ bainbridge: { schedule: [] } }))
    const b = route(plan, 'BAINBRIDGE')
    expect(b.totalTimeMinutes).toBe(Infinity)
    expect(b.arrivalAt).toBeNull()
    expect(b.risks.overall).toBe('high')
    expect(plan.winner?.name).toBe('KINGSTON')
  })

  it('drops routes and warns when required data is missing', () => {
    const plan = planRoutes(planInputs({
      drive: null,
      bainbridge: { schedule: null },
      kingston: { homeLegs: [] },
    }))
    expect(plan.routes).toEqual([])
    expect(plan.winner).toBeNull()
    expect(plan.isCloseCall).toBe(false)
    expect(plan.warnings).toEqual([
      'Driving time unavailable',
      'Bainbridge route unavailable',
      'Kingston route unavailable',
    ])
  })

  it('lets parameters change the answer', () => {
    const plan = planRoutes(planInputs(), { ...PARAMS, crossingMinutes: { BAINBRIDGE: 40, KINGSTON: 30 } })
    expect(route(plan, 'BAINBRIDGE').totalTimeMinutes).toBe(112)
  })
})

describe('selectHomeLegTimes', () => {
  it('returns landing times for the primary sailing', () => {
    expect(selectHomeLegTimes(planInputs())).toEqual({ BAINBRIDGE: [at(75)], KINGSTON: [at(125)] })
  })

  it('adds the fallback landing time when nearly full', () => {
    const inputs = planInputs({
      bainbridge: { spaces: [{ departure: at(40), driveUpSpaceCount: 5, totalSpaces: 200 }] },
    })
    expect(selectHomeLegTimes(inputs).BAINBRIDGE).toEqual([at(75), at(125)])
  })

  it('returns only the primary landing when a nearly full primary has no later sailing', () => {
    const inputs = planInputs({
      bainbridge: {
        schedule: [{ departure: at(40), arrival: null, vesselName: 'Wenatchee' }],
        spaces: [{ departure: at(40), driveUpSpaceCount: 5, totalSpaces: 200 }],
      },
    })
    expect(selectHomeLegTimes(inputs).BAINBRIDGE).toEqual([at(75)])
  })

  it('returns nothing for a route with no catchable sailings', () => {
    expect(selectHomeLegTimes(planInputs({ bainbridge: { schedule: [] } })).BAINBRIDGE).toEqual([])
  })

  it('returns nothing for a route missing its schedule', () => {
    expect(selectHomeLegTimes(planInputs({ bainbridge: { schedule: null } })).BAINBRIDGE).toEqual([])
  })
})
