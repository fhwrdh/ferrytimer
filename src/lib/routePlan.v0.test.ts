import { describe, it, expect } from 'vitest'
import { planRoutesV0 } from './routePlan.v0'
import type { FerryInputs, PlanInputs } from './planInputs'

const NOW = '2026-09-14T17:00:00.000Z'
const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString()

function ferry(overrides: Partial<FerryInputs> = {}): FerryInputs {
  return {
    driveToTerminalMinutes: 20,
    schedule: [
      { departure: at(40), arrival: at(75), vesselName: 'Wenatchee' },
      { departure: at(90), arrival: at(125), vesselName: 'Tacoma' },
    ],
    spaces: [],
    homeLegs: [{ departAt: null, minutes: 30 }],
    ...overrides,
  }
}

function inputs(ferries: Partial<PlanInputs['ferries']> = {}, overrides: Partial<PlanInputs> = {}): PlanInputs {
  return {
    now: NOW,
    drive: { minutes: 100, summary: 'I-5 S and WA-16 W' },
    vessels: [],
    ferries: {
      BAINBRIDGE: ferry(),
      KINGSTON: ferry({ driveToTerminalMinutes: 30 }),
      ...ferries,
    },
    ...overrides,
  }
}

const byName = (plan: ReturnType<typeof planRoutesV0>, name: string) =>
  plan.routes.find(r => r.name === name)!

describe('planRoutesV0', () => {
  it('sorts routes by total time', () => {
    const plan = planRoutesV0(inputs())
    expect(plan.routes.map(r => [r.name, r.totalTimeMinutes])).toEqual([
      ['DRIVE', 100],
      ['BAINBRIDGE', 105], // 20 drive + 20 wait + 35 crossing + 30 home
      ['KINGSTON', 150],   // 30 drive + 60 wait + 30 crossing + 30 home
    ])
    expect(plan.warnings).toEqual([])
  })

  it('describes the drive-around route', () => {
    const drive = byName(planRoutesV0(inputs()), 'DRIVE')
    expect(drive).toMatchObject({
      type: 'drive-around',
      driveFromTerminalMinutes: 100,
      driveSummary: 'I-5 S and WA-16 W',
      risks: { timingRisk: null, spaceRisk: null, overall: 'low' },
    })
  })

  it('records sailings inside the boarding buffer as missed', () => {
    // Kingston: arrive at +30, buffer to +40; the +40 sailing is not strictly after
    const kingston = byName(planRoutesV0(inputs()), 'KINGSTON')
    expect(kingston.missedSailings).toEqual([new Date(at(40))])
    expect(kingston.nextDeparture).toEqual(new Date(at(90)))
    expect(kingston.waitTimeMinutes).toBe(60)
  })

  it('rates 10-19 minutes at the dock as medium timing risk', () => {
    const plan = planRoutesV0(inputs({
      BAINBRIDGE: ferry({ schedule: [{ departure: at(35), arrival: at(70), vesselName: 'Wenatchee' }] }),
    }))
    expect(byName(plan, 'BAINBRIDGE').risks).toEqual({ timingRisk: 'medium', spaceRisk: null, overall: 'medium' })
  })

  it('matches sailing space within 5 minutes and rates under 10 spaces high risk', () => {
    const plan = planRoutesV0(inputs({
      BAINBRIDGE: ferry({ spaces: [{ departure: at(42), driveUpSpaceCount: 5, totalSpaces: 150 }] }),
    }))
    const bainbridge = byName(plan, 'BAINBRIDGE')
    expect(bainbridge.spacesAvailable).toBe(5)
    expect(bainbridge.canMakeNextFerry).toBe(true)
    expect(bainbridge.risks).toEqual({ timingRisk: 'low', spaceRisk: 'high', overall: 'high' })
  })

  it('makes a full next sailing unreachable instead of rolling forward', () => {
    const plan = planRoutesV0(inputs({
      BAINBRIDGE: ferry({ spaces: [{ departure: at(40), driveUpSpaceCount: 0, totalSpaces: 150 }] }),
    }))
    const bainbridge = byName(plan, 'BAINBRIDGE')
    expect(bainbridge.totalTimeMinutes).toBe(Infinity)
    expect(bainbridge.canMakeNextFerry).toBe(false)
    expect(bainbridge.nextDeparture).toEqual(new Date(at(40)))
  })

  it('pushes departure to vessel ETA plus 15 minutes when later than scheduled', () => {
    const plan = planRoutesV0(inputs({}, { vessels: [{ vesselName: 'WENATCHEE', eta: at(35) }] }))
    const bainbridge = byName(plan, 'BAINBRIDGE')
    expect(bainbridge.nextDeparture).toEqual(new Date(at(50)))
    expect(bainbridge.totalTimeMinutes).toBe(115)
  })

  it('ignores a vessel ETA that still makes the scheduled departure', () => {
    const plan = planRoutesV0(inputs({}, { vessels: [{ vesselName: 'Wenatchee', eta: at(10) }] }))
    expect(byName(plan, 'BAINBRIDGE').nextDeparture).toEqual(new Date(at(40)))
  })

  it('marks a route with no remaining sailings as unreachable and high risk', () => {
    const plan = planRoutesV0(inputs({ BAINBRIDGE: ferry({ schedule: [] }) }))
    const bainbridge = byName(plan, 'BAINBRIDGE')
    expect(bainbridge.totalTimeMinutes).toBe(Infinity)
    expect(bainbridge.nextDeparture).toBeNull()
    expect(bainbridge.risks.overall).toBe('high')
  })

  it('uses the live home leg and ignores timed ones', () => {
    const plan = planRoutesV0(inputs({
      BAINBRIDGE: ferry({ homeLegs: [{ departAt: at(75), minutes: 55 }, { departAt: null, minutes: 30 }] }),
    }))
    expect(byName(plan, 'BAINBRIDGE').driveFromTerminalMinutes).toBe(30)
  })

  it('drops a route and warns when required data is missing', () => {
    const plan = planRoutesV0(inputs(
      {
        BAINBRIDGE: ferry({ schedule: null }),
        KINGSTON: ferry({ homeLegs: [{ departAt: at(75), minutes: 55 }] }),
      },
      { drive: null },
    ))
    expect(plan.routes).toEqual([])
    expect(plan.warnings).toEqual([
      'Driving time unavailable',
      'Bainbridge route unavailable',
      'Kingston route unavailable',
    ])
  })
})
