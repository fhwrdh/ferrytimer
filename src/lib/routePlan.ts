// Route algorithm v1. This is the file the tuning agent edits; routePlan.v0.ts
// stays frozen as the baseline. Pure: no fetching, no clock, no React.

import type { RiskLevel, RouteOption } from '../types'
import type { FerryInputs, FerryRouteName, HomeLeg, PlanInputs, RecordedVessel } from './planInputs'
import { TERMINALS } from '../api/ferries'

export interface RouteParams {
  vesselLoadingMinutes: number
  boardingBufferMinutes: number
  nearlyFullThreshold: number
  closeCallMinutes: number
  homeLegMatchMinutes: number
  crossingMinutes: Record<FerryRouteName, number>
}

export const PARAMS: RouteParams = {
  vesselLoadingMinutes: 15,
  boardingBufferMinutes: 10,
  nearlyFullThreshold: 10,
  closeCallMinutes: 15,
  homeLegMatchMinutes: 20,
  crossingMinutes: { BAINBRIDGE: 35, KINGSTON: 30 },
}

export type SpaceState = 'unknown' | 'nearly-full' | 'ok'

export interface PlannedRoute extends RouteOption {
  arrivalAt: string | null
  spaceState: SpaceState | null
  fallback: { departure: string; totalMinutes: number } | null
  // Time used for the close-call judgment: the fallback's total when the
  // primary sailing is nearly full, otherwise the route's own total.
  decisionMinutes: number
}

export interface RoutePlan {
  routes: PlannedRoute[]
  winner: PlannedRoute | null
  isCloseCall: boolean
  closeCallGap: number | null
  warnings: string[]
}

const MINUTE = 60_000
const SPACE_MATCH_MS = 5 * MINUTE
const FERRY_ROUTES: FerryRouteName[] = ['BAINBRIDGE', 'KINGSTON']
const LABELS: Record<FerryRouteName, string> = { BAINBRIDGE: 'Bainbridge', KINGSTON: 'Kingston' }
const DEPARTING_TERMINAL: Record<FerryRouteName, number> = {
  BAINBRIDGE: TERMINALS.SEATTLE,
  KINGSTON: TERMINALS.EDMONDS,
}

interface Sailing {
  scheduled: Date
  departure: Date
}

interface SailingChoice {
  arrivalAtTerminal: Date
  missed: Date[]
  skippedFull: number
  primary: Sailing | null
  fallback: Sailing | null
  spaces: number | null
}

const compare = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1)

function adjustedSchedule(name: FerryRouteName, ferry: FerryInputs, vessels: RecordedVessel[], params: RouteParams): Sailing[] {
  return (ferry.schedule ?? [])
    .map(sailing => {
      const scheduled = new Date(sailing.departure)
      const vessel = vessels.find(v => v.vesselName.toLowerCase() === sailing.vesselName.toLowerCase())
      // Records from before terminal fields existed have none; match by name only
      const headingHere = vessel?.arrivingTerminalId == null || vessel.arrivingTerminalId === DEPARTING_TERMINAL[name]
      let departure = scheduled
      if (vessel?.eta && headingHere) {
        const estimated = new Date(Date.parse(vessel.eta) + params.vesselLoadingMinutes * MINUTE)
        if (estimated > scheduled) departure = estimated
      }
      return { scheduled, departure }
    })
    .sort((a, b) => a.departure.getTime() - b.departure.getTime())
}

function spacesFor(ferry: FerryInputs, sailing: Sailing): number | null {
  const reading = ferry.spaces.find(
    s => Math.abs(Date.parse(s.departure) - sailing.scheduled.getTime()) < SPACE_MATCH_MS
  )
  return reading?.driveUpSpaceCount ?? null
}

function chooseSailings(
  name: FerryRouteName,
  now: Date,
  ferry: FerryInputs,
  vessels: RecordedVessel[],
  params: RouteParams
): SailingChoice {
  const arrivalAtTerminal = new Date(now.getTime() + (ferry.driveToTerminalMinutes as number) * MINUTE)
  const cutoff = arrivalAtTerminal.getTime() + params.boardingBufferMinutes * MINUTE
  const sailings = adjustedSchedule(name, ferry, vessels, params)

  const missed = sailings
    .filter(s => s.departure.getTime() <= cutoff && s.departure > now)
    .map(s => s.departure)
  const catchable = sailings.filter(s => s.departure.getTime() > cutoff)

  const openIndex = catchable.findIndex(s => spacesFor(ferry, s) !== 0)
  if (openIndex === -1) {
    return { arrivalAtTerminal, missed, skippedFull: catchable.length, primary: null, fallback: null, spaces: null }
  }

  const primary = catchable[openIndex]
  const spaces = spacesFor(ferry, primary)
  const nearlyFull = spaces !== null && spaces < params.nearlyFullThreshold
  const fallback = nearlyFull
    ? catchable.slice(openIndex + 1).find(s => spacesFor(ferry, s) !== 0) ?? null
    : null

  return { arrivalAtTerminal, missed, skippedFull: openIndex, primary, fallback, spaces }
}

function landing(name: FerryRouteName, sailing: Sailing, params: RouteParams): Date {
  return new Date(sailing.departure.getTime() + params.crossingMinutes[name] * MINUTE)
}

function matchHomeLeg(legs: HomeLeg[], start: Date, params: RouteParams): { minutes: number; timed: boolean } | null {
  const nearest = legs
    .filter(leg => leg.departAt !== null)
    .map(leg => ({ leg, diff: Math.abs(Date.parse(leg.departAt as string) - start.getTime()) }))
    .sort((a, b) => a.diff - b.diff)[0]
  if (nearest && nearest.diff <= params.homeLegMatchMinutes * MINUTE) {
    return { minutes: nearest.leg.minutes, timed: true }
  }
  const live = legs.find(leg => leg.departAt === null)
  return live ? { minutes: live.minutes, timed: false } : null
}

interface SailingTotal {
  total: number
  wait: number
  home: number
  timed: boolean
}

function sailingTotal(
  name: FerryRouteName,
  sailing: Sailing,
  choice: SailingChoice,
  ferry: FerryInputs,
  params: RouteParams
): SailingTotal | null {
  const wait = Math.max(0, Math.round((sailing.departure.getTime() - choice.arrivalAtTerminal.getTime()) / MINUTE))
  const leg = matchHomeLeg(ferry.homeLegs, landing(name, sailing, params), params)
  if (!leg) return null
  const total = (ferry.driveToTerminalMinutes as number) + wait + params.crossingMinutes[name] + leg.minutes
  return { total, wait, home: leg.minutes, timed: leg.timed }
}

// Copied from v0 so tuning here never moves the baseline
function assessTimingRisk(waitMinutes: number | null): RiskLevel | null {
  if (waitMinutes === null) return null
  if (waitMinutes < 10) return 'high'
  if (waitMinutes < 20) return 'medium'
  return 'low'
}

function assessSpaceRisk(spaces: number | null): RiskLevel | null {
  if (spaces === null) return null
  if (spaces < 10) return 'high'
  if (spaces < 30) return 'medium'
  return 'low'
}

function calculateOverallRisk(timing: RiskLevel | null, space: RiskLevel | null): RiskLevel {
  const risks = [timing, space].filter(Boolean) as RiskLevel[]
  if (risks.includes('high')) return 'high'
  if (risks.includes('medium')) return 'medium'
  return 'low'
}

function planFerryRoute(
  name: FerryRouteName,
  now: Date,
  ferry: FerryInputs,
  vessels: RecordedVessel[],
  params: RouteParams,
  warnings: string[]
): PlannedRoute | null {
  const choice = chooseSailings(name, now, ferry, vessels, params)
  const crossing = params.crossingMinutes[name]
  const driveToTerminal = ferry.driveToTerminalMinutes as number

  if (!choice.primary) {
    return {
      name,
      type: 'ferry',
      totalTimeMinutes: Infinity,
      driveToTerminalMinutes: driveToTerminal,
      waitTimeMinutes: null,
      ferryTimeMinutes: crossing,
      driveFromTerminalMinutes: ferry.homeLegs.find(leg => leg.departAt === null)?.minutes ?? null,
      nextDeparture: null,
      spacesAvailable: null,
      canMakeNextFerry: false,
      missedSailings: choice.missed,
      driveSummary: null,
      risks: { timingRisk: null, spaceRisk: null, overall: 'high' },
      arrivalAt: null,
      spaceState: null,
      fallback: null,
      decisionMinutes: Infinity,
    }
  }

  const primary = sailingTotal(name, choice.primary, choice, ferry, params)
  if (!primary) return null

  if (choice.skippedFull > 0) {
    warnings.push(`${LABELS[name]}: ${choice.skippedFull} full sailing${choice.skippedFull === 1 ? '' : 's'} skipped`)
  }
  if (!primary.timed) {
    warnings.push(`${LABELS[name]}: drive home priced with current traffic`)
  }

  const fallback = choice.fallback ? sailingTotal(name, choice.fallback, choice, ferry, params) : null
  const nearlyFull = choice.spaces !== null && choice.spaces < params.nearlyFullThreshold
  const timingRisk = assessTimingRisk(primary.wait)
  const spaceRisk = assessSpaceRisk(choice.spaces)

  return {
    name,
    type: 'ferry',
    totalTimeMinutes: primary.total,
    driveToTerminalMinutes: driveToTerminal,
    waitTimeMinutes: primary.wait,
    ferryTimeMinutes: crossing,
    driveFromTerminalMinutes: primary.home,
    nextDeparture: choice.primary.departure,
    spacesAvailable: choice.spaces,
    canMakeNextFerry: true,
    missedSailings: choice.missed,
    driveSummary: null,
    risks: { timingRisk, spaceRisk, overall: calculateOverallRisk(timingRisk, spaceRisk) },
    arrivalAt: new Date(now.getTime() + primary.total * MINUTE).toISOString(),
    spaceState: choice.spaces === null ? 'unknown' : nearlyFull ? 'nearly-full' : 'ok',
    fallback: choice.fallback && fallback
      ? { departure: choice.fallback.departure.toISOString(), totalMinutes: fallback.total }
      : null,
    decisionMinutes: nearlyFull ? (fallback?.total ?? Infinity) : primary.total,
  }
}

export function planRoutes(inputs: PlanInputs, params: RouteParams = PARAMS, bias = 0): RoutePlan {
  const now = new Date(inputs.now)
  const routes: PlannedRoute[] = []
  const warnings: string[] = []

  if (inputs.drive) {
    routes.push({
      name: 'DRIVE',
      type: 'drive-around',
      totalTimeMinutes: inputs.drive.minutes,
      driveToTerminalMinutes: null,
      waitTimeMinutes: null,
      ferryTimeMinutes: null,
      driveFromTerminalMinutes: inputs.drive.minutes,
      nextDeparture: null,
      spacesAvailable: null,
      canMakeNextFerry: null,
      missedSailings: [],
      driveSummary: inputs.drive.summary,
      risks: { timingRisk: null, spaceRisk: null, overall: 'low' },
      arrivalAt: new Date(now.getTime() + inputs.drive.minutes * MINUTE).toISOString(),
      spaceState: null,
      fallback: null,
      decisionMinutes: inputs.drive.minutes + bias,
    })
  } else {
    warnings.push('Driving time unavailable')
  }

  for (const name of FERRY_ROUTES) {
    const ferry = inputs.ferries[name]
    if (ferry.driveToTerminalMinutes !== null && ferry.schedule !== null) {
      const planned = planFerryRoute(name, now, ferry, inputs.vessels, params, warnings)
      if (planned) {
        routes.push(planned)
        continue
      }
    }
    warnings.push(`${LABELS[name]} route unavailable`)
  }

  const headline = (r: PlannedRoute) => (r.type === 'drive-around' ? r.totalTimeMinutes + bias : r.totalTimeMinutes)
  routes.sort((a, b) => compare(headline(a), headline(b)))

  const winner = routes[0] ?? null
  const byDecision = [...routes].sort((a, b) => compare(a.decisionMinutes, b.decisionMinutes))

  let isCloseCall = false
  let closeCallGap: number | null = null
  if (winner && byDecision.length >= 2 && Number.isFinite(headline(winner))) {
    const flipped = byDecision[0].name !== winner.name
    if (Number.isFinite(byDecision[1].decisionMinutes)) {
      closeCallGap = byDecision[1].decisionMinutes - byDecision[0].decisionMinutes
      isCloseCall = closeCallGap <= params.closeCallMinutes || flipped
    } else {
      isCloseCall = flipped
    }
  }

  return { routes, winner, isCloseCall, closeCallGap, warnings }
}

// Landing times the app should price the drive home at: primary sailing, plus
// the fallback when the primary is nearly full.
export function selectHomeLegTimes(inputs: PlanInputs, params: RouteParams = PARAMS): Record<FerryRouteName, string[]> {
  const now = new Date(inputs.now)
  const times: Record<FerryRouteName, string[]> = { BAINBRIDGE: [], KINGSTON: [] }
  for (const name of FERRY_ROUTES) {
    const ferry = inputs.ferries[name]
    if (ferry.driveToTerminalMinutes === null || ferry.schedule === null) continue
    const choice = chooseSailings(name, now, ferry, inputs.vessels, params)
    times[name] = [choice.primary, choice.fallback]
      .flatMap(s => (s ? [landing(name, s, params).toISOString()] : []))
  }
  return times
}
