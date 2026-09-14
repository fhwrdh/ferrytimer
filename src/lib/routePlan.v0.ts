// The route algorithm as it shipped before the eval harness, extracted
// verbatim so it can be scored as the baseline. Do not tune this file;
// improvements go in routePlan.ts.

import type { RiskLevel, RouteOption } from '../types'
import type { FerryInputs, FerryRouteName, PlanInputs, RecordedVessel } from './planInputs'
import { CROSSING_TIMES } from '../api/ferries'

// Loading time after vessel arrives at dock (minutes)
const VESSEL_LOADING_TIME = 15
// Arrive this many minutes before departure to count as making the boat
const BUFFER_MINUTES = 10

const CROSSING_MINUTES: Record<FerryRouteName, number> = {
  BAINBRIDGE: CROSSING_TIMES.SEATTLE_BAINBRIDGE,
  KINGSTON: CROSSING_TIMES.EDMONDS_KINGSTON,
}

const LABELS: Record<FerryRouteName, string> = {
  BAINBRIDGE: 'Bainbridge',
  KINGSTON: 'Kingston',
}

const FERRY_ROUTES: FerryRouteName[] = ['BAINBRIDGE', 'KINGSTON']

export function planRoutesV0(inputs: PlanInputs): { routes: RouteOption[]; warnings: string[] } {
  const now = new Date(inputs.now)
  const routes: RouteOption[] = []
  const warnings: string[] = []

  // Driving option - always low risk (predictable, no waiting)
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
    })
  } else {
    warnings.push('Driving time unavailable')
  }

  for (const name of FERRY_ROUTES) {
    const ferry = inputs.ferries[name]
    const liveHomeLeg = ferry.homeLegs.find(leg => leg.departAt === null)
    if (ferry.driveToTerminalMinutes !== null && ferry.schedule !== null && liveHomeLeg) {
      routes.push(calculateFerryRoute(name, now, ferry, liveHomeLeg.minutes, inputs.vessels))
    } else {
      warnings.push(`${LABELS[name]} route unavailable`)
    }
  }

  routes.sort((a, b) => a.totalTimeMinutes - b.totalTimeMinutes)

  return { routes, warnings }
}

function assessTimingRisk(waitMinutes: number | null): RiskLevel | null {
  if (waitMinutes === null) return null
  if (waitMinutes < 10) return 'high'      // Very tight
  if (waitMinutes < 20) return 'medium'    // Cutting it close
  return 'low'                              // Comfortable buffer
}

function assessSpaceRisk(spaces: number | null): RiskLevel | null {
  if (spaces === null) return null
  if (spaces < 10) return 'high'           // Might not get on
  if (spaces < 30) return 'medium'         // Getting tight
  return 'low'                              // Plenty of room
}

function calculateOverallRisk(timing: RiskLevel | null, space: RiskLevel | null): RiskLevel {
  const risks = [timing, space].filter(Boolean) as RiskLevel[]
  if (risks.includes('high')) return 'high'
  if (risks.includes('medium')) return 'medium'
  return 'low'
}

function calculateFerryRoute(
  name: FerryRouteName,
  now: Date,
  ferry: FerryInputs,
  driveFromTerminal: number,
  vessels: RecordedVessel[]
): RouteOption {
  const driveToTerminal = ferry.driveToTerminalMinutes as number
  const crossingTime = CROSSING_MINUTES[name]
  const arrivalAtTerminal = new Date(now.getTime() + driveToTerminal * 60 * 1000)
  const cutoffTime = new Date(arrivalAtTerminal.getTime() + BUFFER_MINUTES * 60 * 1000)

  // Adjust scheduled departures based on real-time vessel locations
  const adjustedSchedule = (ferry.schedule ?? []).map(sailing => {
    const departureTime = new Date(sailing.departure)
    const vessel = vessels.find(v => v.vesselName.toLowerCase() === sailing.vesselName.toLowerCase())

    // If vessel has an ETA (meaning it's not at the dock yet),
    // the actual departure will be delayed
    if (vessel?.eta) {
      const estimatedDeparture = new Date(new Date(vessel.eta).getTime() + VESSEL_LOADING_TIME * 60 * 1000)
      if (estimatedDeparture > departureTime) {
        return { departureTime: estimatedDeparture, isDelayed: true }
      }
    }

    return { departureTime, isDelayed: false }
  })

  const missedSailings = adjustedSchedule
    .filter(s => s.departureTime <= cutoffTime && s.departureTime > now)
    .map(s => s.departureTime)

  const nextSailing = adjustedSchedule.find(s => s.departureTime > cutoffTime)

  if (!nextSailing) {
    return {
      name,
      type: 'ferry',
      totalTimeMinutes: Infinity,
      driveToTerminalMinutes: driveToTerminal,
      waitTimeMinutes: null,
      ferryTimeMinutes: crossingTime,
      driveFromTerminalMinutes: driveFromTerminal,
      nextDeparture: null,
      spacesAvailable: null,
      canMakeNextFerry: false,
      missedSailings,
      driveSummary: null,
      risks: { timingRisk: null, spaceRisk: null, overall: 'high' },
    }
  }

  const spaceInfo = ferry.spaces.find(
    s => Math.abs(new Date(s.departure).getTime() - nextSailing.departureTime.getTime()) < 5 * 60 * 1000
  )

  const spacesAvailable = spaceInfo?.driveUpSpaceCount ?? null
  const canMakeIt = spacesAvailable === null || spacesAvailable > 0

  const waitTime = Math.max(
    0,
    Math.round((nextSailing.departureTime.getTime() - arrivalAtTerminal.getTime()) / 60000)
  )

  const totalTime = driveToTerminal + waitTime + crossingTime + driveFromTerminal

  const timingRisk = assessTimingRisk(waitTime)
  const spaceRisk = assessSpaceRisk(spacesAvailable)
  const overallRisk = calculateOverallRisk(timingRisk, spaceRisk)

  return {
    name,
    type: 'ferry',
    totalTimeMinutes: canMakeIt ? totalTime : Infinity,
    driveToTerminalMinutes: driveToTerminal,
    waitTimeMinutes: waitTime,
    ferryTimeMinutes: crossingTime,
    driveFromTerminalMinutes: driveFromTerminal,
    nextDeparture: nextSailing.departureTime,
    spacesAvailable,
    canMakeNextFerry: canMakeIt,
    missedSailings,
    driveSummary: null,
    risks: { timingRisk, spaceRisk, overall: overallRisk },
  }
}
