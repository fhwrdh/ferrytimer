import { describe, it, expect } from 'vitest'
import { runSample, maxRoutesCalls, SAMPLE_SCHEMA_VERSION, ORIGINS, type Origin } from './runSample'
import { RoutesBudget, type BudgetState } from './budget'
import type { DriveRequest, Upstream } from './upstream'
import type { Location } from '../types'
import { TERMINALS, TERMINAL_LOCATIONS } from '../api/ferries'

const NOW = new Date('2026-09-14T19:00:00.000Z')
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString()
const HOME = { lat: 47.65, lng: -122.69 }

const same = (a: Location, b: Location) => a.lat === b.lat && a.lng === b.lng

interface DriveCall { origin: Location; destination: Location; request?: DriveRequest }

function fakeUpstream(overrides: Partial<Upstream> = {}): Upstream & { driveCalls: DriveCall[] } {
  const driveCalls: DriveCall[] = []
  const sailings = (offsets: number[], crossing: number) =>
    offsets.map(o => ({ departure: at(o), arrival: at(o + crossing), vesselName: 'Wenatchee' }))

  return {
    driveCalls,
    async drive(origin, destination, request) {
      driveCalls.push({ origin, destination, request })
      if (request?.departAt) return { minutes: 45, summary: null }
      if (same(destination, TERMINAL_LOCATIONS[TERMINALS.SEATTLE])) {
        return { minutes: same(origin, ORIGINS[0].location) ? 10 : 25, summary: null }
      }
      if (same(destination, TERMINAL_LOCATIONS[TERMINALS.EDMONDS])) return { minutes: 30, summary: null }
      if (request?.avoidFerries) return { minutes: 110, summary: 'I-5 S and WA-16 W' }
      return { minutes: 35, summary: null }
    },
    async schedule(departingId) {
      return departingId === TERMINALS.SEATTLE
        ? sailings([5, 20, 60, 100, 140], 35)
        : sailings([40, 80, 120, 160], 30)
    },
    async spaces() {
      return [{ departure: at(20), driveUpSpaceCount: 8, totalSpaces: 202 }]
    },
    async vessels() {
      return [{
        vesselName: 'Wenatchee',
        eta: at(12),
        departingTerminalId: TERMINALS.SEATTLE,
        arrivingTerminalId: TERMINALS.BAINBRIDGE,
        scheduledDeparture: at(5),
        leftDock: null,
        atDock: true,
        inService: true,
      }]
    },
    ...overrides,
  }
}

function budget(state: BudgetState | null = null) {
  let saved = state
  return new RoutesBudget({ load: () => saved, save: s => { saved = s } }, '2026-09-14')
}

describe('runSample', () => {
  it('writes one record per origin with shared ferry data', async () => {
    const result = await runSample({ upstream: fakeUpstream(), home: HOME, now: NOW, budget: budget() })

    expect(result.skipped).toBeNull()
    expect(result.records.map(r => r.sampleId)).toEqual([
      `downtown-${NOW.toISOString()}`,
      `northgate-${NOW.toISOString()}`,
      `ai2-${NOW.toISOString()}`,
    ])
    const [downtown, northgate] = result.records
    expect(downtown.schemaVersion).toBe(SAMPLE_SCHEMA_VERSION)
    expect(downtown.destination).toEqual(HOME)
    expect(northgate.destination).toEqual(HOME)
    expect(downtown.inputs.now).toBe(NOW.toISOString())
    expect(downtown.inputs.drive).toEqual({ minutes: 110, summary: 'I-5 S and WA-16 W' })
    expect(downtown.inputs.ferries.BAINBRIDGE.driveToTerminalMinutes).toBe(10)
    expect(northgate.inputs.ferries.BAINBRIDGE.driveToTerminalMinutes).toBe(25)
    expect(downtown.inputs.vessels).toEqual([{
      vesselName: 'Wenatchee',
      eta: at(12),
      departingTerminalId: TERMINALS.SEATTLE,
      arrivingTerminalId: TERMINALS.BAINBRIDGE,
      scheduledDeparture: at(5),
      leftDock: null,
      atDock: true,
      inService: true,
    }])
    expect(downtown.inputs.ferries.BAINBRIDGE.spaces).toEqual(northgate.inputs.ferries.BAINBRIDGE.spaces)
  })

  it('prices the home leg live and for three candidate sailings after the shortest drive', async () => {
    const upstream = fakeUpstream()
    const result = await runSample({ upstream, home: HOME, now: NOW, budget: budget() })

    // Shortest drive to Colman is 10 min, so candidates depart after +10: +20, +60, +100
    expect(result.records[0].inputs.ferries.BAINBRIDGE.homeLegs).toEqual([
      { departAt: null, minutes: 35 },
      { departAt: at(55), minutes: 45 },
      { departAt: at(95), minutes: 45 },
      { departAt: at(135), minutes: 45 },
    ])
    // Kingston: shortest drive 30 min, candidates +40, +80, +120
    expect(result.records[1].inputs.ferries.KINGSTON.homeLegs.map(l => l.departAt)).toEqual([
      null, at(70), at(110), at(150),
    ])
    const timed = upstream.driveCalls.filter(c => c.request?.departAt)
    expect(timed.every(c => same(c.destination, HOME))).toBe(true)
  })

  it('prices arrival-less sailings at departure plus the route crossing time', async () => {
    const upstream = fakeUpstream({
      async schedule(departingId) {
        return departingId === TERMINALS.SEATTLE
          ? [5, 20, 60].map(o => ({ departure: at(o), arrival: null, vesselName: 'Wenatchee' }))
          : [40, 80, 120].map(o => ({ departure: at(o), arrival: null, vesselName: 'Puyallup' }))
      },
    })
    const result = await runSample({ upstream, home: HOME, now: NOW, budget: budget() })

    // Bainbridge crossing is 35 min; candidates depart after +10: +20, +60
    expect(result.records[0].inputs.ferries.BAINBRIDGE.homeLegs.map(l => l.departAt)).toEqual([
      null, at(20 + 35), at(60 + 35),
    ])
    // Kingston crossing is 30 min; candidates depart after +30: +40, +80, +120
    expect(result.records[1].inputs.ferries.KINGSTON.homeLegs.map(l => l.departAt)).toEqual([
      null, at(40 + 30), at(80 + 30), at(120 + 30),
    ])
  })

  it('counts every Routes call it makes and spends it from the budget', async () => {
    const b = budget()
    const result = await runSample({ upstream: fakeUpstream(), home: HOME, now: NOW, budget: b })
    // 3 origins x 3 + 2 terminal-home + 6 timed
    expect(result.routesCalls).toBe(17)
    expect(b.used).toBe(17)
    expect(maxRoutesCalls(ORIGINS.length)).toBe(17)
  })

  it('skips without calling anything when the budget cannot cover a full run', async () => {
    const upstream = fakeUpstream()
    const result = await runSample({ upstream, home: HOME, now: NOW, budget: budget({ day: '2026-09-14', used: 640 }) })
    expect(result).toEqual({ records: [], routesCalls: 0, skipped: 'budget' })
    expect(upstream.driveCalls).toEqual([])
  })

  it('records a missing schedule as null and prices no timed legs for it', async () => {
    const upstream = fakeUpstream({
      async schedule(departingId) {
        if (departingId === TERMINALS.SEATTLE) throw new Error('WSDOT schedule failed: 500')
        return [{ departure: at(40), arrival: at(70), vesselName: 'Puyallup' }]
      },
    })
    const result = await runSample({ upstream, home: HOME, now: NOW, budget: budget() })
    const bainbridge = result.records[0].inputs.ferries.BAINBRIDGE
    expect(bainbridge.schedule).toBeNull()
    expect(bainbridge.homeLegs).toEqual([{ departAt: null, minutes: 35 }])
    expect(result.routesCalls).toBe(12) // 9 + 2 + 1 Kingston candidate
  })

  it('degrades failed drives and refinements instead of dropping the record', async () => {
    const base = fakeUpstream()
    const upstream = fakeUpstream({
      async drive(origin, destination, request) {
        if (request?.avoidFerries) throw new Error('Google Routes failed: 429')
        return base.drive(origin, destination, request)
      },
      async spaces() { throw new Error('WSDOT sailing space failed: 500') },
      async vessels() { throw new Error('WSDOT vessels failed: 500') },
    })
    const origins: Origin[] = [ORIGINS[0]]
    const result = await runSample({ upstream, home: HOME, now: NOW, budget: budget(), origins })
    const [record] = result.records
    expect(record.inputs.drive).toBeNull()
    expect(record.inputs.vessels).toEqual([])
    expect(record.inputs.ferries.KINGSTON.spaces).toEqual([])
    expect(record.inputs.ferries.KINGSTON.schedule).not.toBeNull()
  })
})
