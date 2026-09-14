import { describe, it, expect } from 'vitest'
import { isResolvable, normalizeVessel, resolveSample, type HistoryRow } from './resolver'
import { at, planInputs } from '../src/lib/fixtures'
import type { SampleRecord } from '../src/sampler/runSample'
import type { PlanInputs } from '../src/lib/planInputs'

// Fixture timeline (minutes after 17:00Z): Bainbridge drive 20 → terminal +20,
// board by +30. Sailings +40 Wenatchee, +90 Tacoma, +140 Wenatchee.
// Kingston drive 60 → terminal +60, board by +70. Sailings +45, +95, +145.

function sample(offsetMinutes: number, inputs: PlanInputs = planInputs(), schemaVersion = 2): SampleRecord {
  const now = at(offsetMinutes)
  return {
    sampleId: `downtown-${now}`,
    schemaVersion,
    origin: { id: 'downtown', label: 'Downtown', location: { lat: 0, lng: 0 } },
    destination: { lat: 1, lng: 1 },
    now,
    inputs: { ...inputs, now },
  }
}

const row = (vessel: string, scheduled: number, actual: number, arrival: number): HistoryRow => ({
  vessel,
  scheduledDepart: at(scheduled),
  actualDepart: at(actual),
  estArrival: at(arrival),
})

const history: HistoryRow[] = [
  row('Wenatchee', 40, 42, 75),
  row('Tacoma', 90, 91, 126),
  row('Wenatchee', 140, 140, 175),
  row('Puyallup', 45, 46, 66),
  row('Spokane', 95, 99, 121),
  row('Puyallup', 145, 146, 176),
]

// A later run supplies the live terminal→destination leg near landing.
// Scheduled sailings in these runs have shifted relative times, but the
// resolver only reads their homeLegs and spaces.
const later = (offset: number, bainbridgeLive: number, kingstonLive: number, spaces: PlanInputs['ferries']['BAINBRIDGE']['spaces'] = []) =>
  sample(offset, planInputs({
    bainbridge: { homeLegs: [{ departAt: null, minutes: bainbridgeLive }], spaces },
    kingston: { homeLegs: [{ departAt: null, minutes: kingstonLive }] },
  }))

describe('resolveSample', () => {
  const base = sample(0)
  const runs = [base, later(80, 31, 19), later(120, 33, 25)]

  it('resolves the drive-around from the sample itself', () => {
    const outcome = resolveSample(base, runs, history)
    expect(outcome.routes.DRIVE).toEqual({ arrivalAt: at(150), caughtSailing: null })
  })

  it('catches the first sailing that actually left after boarding time and uses the run nearest landing', () => {
    const outcome = resolveSample(base, runs, history)
    // Wenatchee +40 left at +42 (> +30 board-by), landed +75; nearest run +80 → 31 min
    expect(outcome.routes.BAINBRIDGE).toEqual({ arrivalAt: at(106), caughtSailing: at(40) })
    // Kingston board-by +70: Puyallup +45 left +46 (too early); Spokane +95 left +99, landed +121; run +120 → 25
    expect(outcome.routes.KINGSTON).toEqual({ arrivalAt: at(146), caughtSailing: at(95) })
    expect(outcome.observedBest).toBe('BAINBRIDGE')
  })

  it('skips a sailing the last reading before terminal arrival showed as full', () => {
    const fullReading = later(10, 30, 20, [{ departure: at(40), driveUpSpaceCount: 0, totalSpaces: 200 }])
    const outcome = resolveSample(base, [base, fullReading, later(120, 33, 25), later(140, 35, 26)], history)
    // Tacoma +90 left +91, landed +126; nearest run +120 → 33
    expect(outcome.routes.BAINBRIDGE).toEqual({ arrivalAt: at(159), caughtSailing: at(90) })
  })

  it('ignores space readings taken after terminal arrival', () => {
    const lateReading = later(25, 30, 20, [{ departure: at(40), driveUpSpaceCount: 0, totalSpaces: 200 }])
    const outcome = resolveSample(base, [base, lateReading, ...runs.slice(1)], history)
    expect(outcome.routes.BAINBRIDGE).toEqual({ arrivalAt: at(106), caughtSailing: at(40) })
  })

  it('is unresolved when no run is near the landing time', () => {
    const outcome = resolveSample(base, [base], history)
    expect(outcome.routes.BAINBRIDGE).toEqual({ unresolved: 'no sample run near arrival' })
    expect(outcome.observedBest).toBe('DRIVE')
  })

  it('is unresolved when a relevant sailing has no vessel history', () => {
    const outcome = resolveSample(base, runs, history.filter(h => h.vessel !== 'Wenatchee'))
    expect(outcome.routes.BAINBRIDGE).toEqual({ unresolved: `no vessel history for Wenatchee ${at(40)}` })
  })

  it('treats an unrecorded sailing before boarding time as missed, not unresolved', () => {
    const outcome = resolveSample(base, runs, history.filter(h => !(h.vessel === 'Puyallup' && h.scheduledDepart === at(45))))
    expect(outcome.routes.KINGSTON).toEqual({ arrivalAt: at(146), caughtSailing: at(95) })
  })

  it('matches vessel names ignoring spaces and case', () => {
    expect(normalizeVessel('Walla Walla')).toBe(normalizeVessel('WallaWalla'))
  })
})

describe('isResolvable', () => {
  it('requires schema version 2 and a settled trip', () => {
    const s = sample(0)
    expect(isResolvable(s, new Date(Date.parse(s.now) + 209 * 60_000))).toBe(false)
    expect(isResolvable(s, new Date(Date.parse(s.now) + 210 * 60_000))).toBe(true)
    expect(isResolvable(sample(0, planInputs(), 1), new Date(Date.parse(s.now) + 999 * 60_000))).toBe(false)
  })
})
