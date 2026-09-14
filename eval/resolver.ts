// Turns a recorded sample into observed ("proxy truth") arrivals per route,
// using only data recorded by the sampler and WSDOT vessel history. No
// Google calls: Google can't price the past, so later sampler runs stand in.
// These constants define the truth, not the algorithm: the tuning agent must
// not edit this file.

import type { SampleRecord } from '../src/sampler/runSample'
import type { FerryRouteName } from '../src/lib/planInputs'
import type { Outcome, RouteName, RouteOutcome } from './score'

export interface HistoryRow {
  vessel: string
  scheduledDepart: string
  actualDepart: string | null
  estArrival: string | null
}

export const RESOLVER = {
  boardingBufferMinutes: 10,
  nearbyRunMinutes: 10,
  spaceMatchMinutes: 5,
  historyMatchMinutes: 2,
  lookbackMinutes: 30,
  // Latest trips finish within about 3 hours; vessel history lags ~30 min
  settleMinutes: 210,
  fallbackCrossingMinutes: { BAINBRIDGE: 35, KINGSTON: 30 } as Record<FerryRouteName, number>,
} as const

const MINUTE = 60_000
const FERRY_ROUTES: FerryRouteName[] = ['BAINBRIDGE', 'KINGSTON']

export function normalizeVessel(name: string): string {
  return name.replace(/\s+/g, '').toLowerCase()
}

export function isResolvable(sample: SampleRecord, asOf: Date): boolean {
  return (sample.schemaVersion ?? 1) >= 2 &&
    Date.parse(sample.now) + RESOLVER.settleMinutes * MINUTE <= asOf.getTime()
}

function resolveDrive(sample: SampleRecord): RouteOutcome {
  const drive = sample.inputs.drive
  if (!drive) return { unresolved: 'no drive-around reading' }
  return { arrivalAt: new Date(Date.parse(sample.now) + drive.minutes * MINUTE).toISOString(), caughtSailing: null }
}

// Latest drive-up space count for a sailing, from runs taken before `before`
function lastSpaceReading(all: SampleRecord[], name: FerryRouteName, departure: string, before: number): number | null {
  const target = Date.parse(departure)
  const runs = all
    .filter(s => Date.parse(s.now) < before)
    .sort((a, b) => Date.parse(b.now) - Date.parse(a.now))
  for (const run of runs) {
    const reading = run.inputs.ferries[name].spaces.find(
      sp => Math.abs(Date.parse(sp.departure) - target) <= RESOLVER.spaceMatchMinutes * MINUTE
    )
    if (reading) return reading.driveUpSpaceCount
  }
  return null
}

function nearestRun(all: SampleRecord[], time: number): SampleRecord | null {
  let best: SampleRecord | null = null
  let bestDiff = RESOLVER.nearbyRunMinutes * MINUTE
  for (const run of all) {
    const diff = Math.abs(Date.parse(run.now) - time)
    if (diff <= bestDiff) {
      best = run
      bestDiff = diff
    }
  }
  return best
}

function resolveFerry(sample: SampleRecord, name: FerryRouteName, all: SampleRecord[], history: HistoryRow[]): RouteOutcome {
  const ferry = sample.inputs.ferries[name]
  if (ferry.driveToTerminalMinutes === null) return { unresolved: 'no drive to terminal' }
  if (!ferry.schedule) return { unresolved: 'no schedule' }

  const terminalArrival = Date.parse(sample.now) + ferry.driveToTerminalMinutes * MINUTE
  const boardBy = terminalArrival + RESOLVER.boardingBufferMinutes * MINUTE
  const sailings = [...ferry.schedule]
    .sort((a, b) => Date.parse(a.departure) - Date.parse(b.departure))
    .filter(s => Date.parse(s.departure) >= terminalArrival - RESOLVER.lookbackMinutes * MINUTE)

  for (const sailing of sailings) {
    const scheduled = Date.parse(sailing.departure)
    const row = history.find(h =>
      normalizeVessel(h.vessel) === normalizeVessel(sailing.vesselName) &&
      Math.abs(Date.parse(h.scheduledDepart) - scheduled) <= RESOLVER.historyMatchMinutes * MINUTE
    )
    if (!row?.actualDepart) {
      if (scheduled <= boardBy) continue // couldn't have caught it anyway
      return { unresolved: `no vessel history for ${sailing.vesselName} ${sailing.departure}` }
    }

    const actual = Date.parse(row.actualDepart)
    if (actual <= boardBy) continue
    if (lastSpaceReading(all, name, sailing.departure, terminalArrival) === 0) continue

    const crossing = row.estArrival
      ? Date.parse(row.estArrival) - actual
      : RESOLVER.fallbackCrossingMinutes[name] * MINUTE
    const landed = actual + crossing
    const homeLeg = nearestRun(all, landed)?.inputs.ferries[name].homeLegs.find(leg => leg.departAt === null)
    if (!homeLeg) return { unresolved: 'no sample run near arrival' }

    return {
      arrivalAt: new Date(landed + homeLeg.minutes * MINUTE).toISOString(),
      caughtSailing: sailing.departure,
    }
  }

  return { unresolved: 'no sailing caught' }
}

export function resolveSample(sample: SampleRecord, allSamples: SampleRecord[], history: HistoryRow[]): Outcome {
  const routes: Record<RouteName, RouteOutcome> = {
    DRIVE: resolveDrive(sample),
    BAINBRIDGE: resolveFerry(sample, 'BAINBRIDGE', allSamples, history),
    KINGSTON: resolveFerry(sample, 'KINGSTON', allSamples, history),
  }

  let observedBest: RouteName | null = null
  let bestTime = Infinity
  for (const name of ['DRIVE', ...FERRY_ROUTES] as RouteName[]) {
    const outcome = routes[name]
    if ('arrivalAt' in outcome && Date.parse(outcome.arrivalAt) < bestTime) {
      bestTime = Date.parse(outcome.arrivalAt)
      observedBest = name
    }
  }

  return { sampleId: sample.sampleId, routes, observedBest }
}
