import { useState, useEffect, useCallback } from 'react'
import type { Location, RouteOption, RiskLevel } from '../types'
import {
  getTerminalSailingSpace,
  getScheduleToday,
  getVesselLocations,
  TERMINALS,
  TERMINAL_LOCATIONS,
  CROSSING_TIMES,
} from '../api/ferries'
import type { VesselLocation } from '../types'
import { getDriveTimeMinutes } from '../api/routes'

interface UseRouteCalculationProps {
  currentLocation: Location | null
  homeLocation: Location | null
}

interface UseRouteCalculationResult {
  routes: RouteOption[]
  bestRoute: RouteOption | null
  isLoading: boolean
  error: string | null
  refresh: () => void
}

// Poulsbo area - for drive-around routing via Tacoma
const TACOMA_NARROWS_WAYPOINT: Location = { lat: 47.2690, lng: -122.5515 }

// Check if two locations are very close (within ~500m)
function isNearby(loc1: Location, loc2: Location): boolean {
  const latDiff = Math.abs(loc1.lat - loc2.lat)
  const lngDiff = Math.abs(loc1.lng - loc2.lng)
  // ~0.005 degrees ≈ 500m at Seattle's latitude
  return latDiff < 0.005 && lngDiff < 0.005
}

export function useRouteCalculation({
  currentLocation,
  homeLocation,
}: UseRouteCalculationProps): UseRouteCalculationResult {
  const [routes, setRoutes] = useState<RouteOption[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const calculate = useCallback(async () => {
    if (!currentLocation || !homeLocation) {
      setRoutes([]) // Clear stale results when location is cleared
      return
    }

    // Check if already at home
    if (isNearby(currentLocation, homeLocation)) {
      setRoutes([])
      setError('You\'re already home! 🏠')
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      const now = new Date()
      const results: RouteOption[] = []

      // Calculate all routes in parallel
      const [
        // Drive times to terminals
        driveToSeattle,
        driveToEdmonds,
        // Drive times from terminals to home
        driveFromBainbridge,
        driveFromKingston,
        // Drive around (via Tacoma)
        driveAroundToTacoma,
        driveAroundFromTacoma,
        // Ferry schedules and spaces
        seattleSpaces,
        edmondsSpaces,
        seattleSchedule,
        edmondsSchedule,
        // Real-time vessel locations
        vesselLocations,
      ] = await Promise.all([
        getDriveTimeMinutes(currentLocation, TERMINAL_LOCATIONS[TERMINALS.SEATTLE]),
        getDriveTimeMinutes(currentLocation, TERMINAL_LOCATIONS[TERMINALS.EDMONDS]),
        getDriveTimeMinutes(TERMINAL_LOCATIONS[TERMINALS.BAINBRIDGE], homeLocation),
        getDriveTimeMinutes(TERMINAL_LOCATIONS[TERMINALS.KINGSTON], homeLocation),
        getDriveTimeMinutes(currentLocation, TACOMA_NARROWS_WAYPOINT),
        getDriveTimeMinutes(TACOMA_NARROWS_WAYPOINT, homeLocation),
        getTerminalSailingSpace(TERMINALS.SEATTLE),
        getTerminalSailingSpace(TERMINALS.EDMONDS),
        getScheduleToday(TERMINALS.SEATTLE, TERMINALS.BAINBRIDGE, true),
        getScheduleToday(TERMINALS.EDMONDS, TERMINALS.KINGSTON, true),
        getVesselLocations(),
      ])

      // Drive around option - always low risk (predictable, no waiting)
      const driveAroundTotal = driveAroundToTacoma + driveAroundFromTacoma
      results.push({
        name: 'DRIVE AROUND',
        type: 'drive-around',
        totalTimeMinutes: driveAroundTotal,
        driveToTerminalMinutes: null,
        waitTimeMinutes: null,
        ferryTimeMinutes: null,
        driveFromTerminalMinutes: driveAroundTotal,
        nextDeparture: null,
        spacesAvailable: null,
        canMakeNextFerry: null,
        missedSailings: [],
        risks: { timingRisk: null, spaceRisk: null, overall: 'low' },
      })

      // Bainbridge option
      const bainbridgeResult = calculateFerryRoute({
        name: 'BAINBRIDGE',
        now,
        driveToTerminal: driveToSeattle,
        driveFromTerminal: driveFromBainbridge,
        crossingTime: CROSSING_TIMES.SEATTLE_BAINBRIDGE,
        sailingSpaces: seattleSpaces,
        schedule: seattleSchedule,
        vesselLocations,
      })
      results.push(bainbridgeResult)

      // Kingston option
      const kingstonResult = calculateFerryRoute({
        name: 'KINGSTON',
        now,
        driveToTerminal: driveToEdmonds,
        driveFromTerminal: driveFromKingston,
        crossingTime: CROSSING_TIMES.EDMONDS_KINGSTON,
        sailingSpaces: edmondsSpaces,
        schedule: edmondsSchedule,
        vesselLocations,
      })
      results.push(kingstonResult)

      // Sort by total time
      results.sort((a, b) => a.totalTimeMinutes - b.totalTimeMinutes)

      setRoutes(results)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setIsLoading(false)
    }
  }, [currentLocation, homeLocation])

  useEffect(() => {
    calculate()
  }, [calculate])

  const bestRoute = routes.length > 0 ? routes[0] : null

  return {
    routes,
    bestRoute,
    isLoading,
    error,
    refresh: calculate,
  }
}

interface CalculateFerryRouteParams {
  name: string
  now: Date
  driveToTerminal: number
  driveFromTerminal: number
  crossingTime: number
  sailingSpaces: Awaited<ReturnType<typeof getTerminalSailingSpace>>
  schedule: Awaited<ReturnType<typeof getScheduleToday>>
  vesselLocations: VesselLocation[]
}

// Loading time after vessel arrives at dock (minutes)
const VESSEL_LOADING_TIME = 15

// Risk assessment thresholds
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

function calculateFerryRoute({
  name,
  now,
  driveToTerminal,
  driveFromTerminal,
  crossingTime,
  sailingSpaces,
  schedule,
  vesselLocations,
}: CalculateFerryRouteParams): RouteOption {
  // When would we arrive at the terminal?
  const arrivalAtTerminal = new Date(now.getTime() + driveToTerminal * 60 * 1000)

  // Find the next sailing we can make
  // We need some buffer time (let's say 10 minutes to get in line and board)
  const BUFFER_MINUTES = 10
  const cutoffTime = new Date(arrivalAtTerminal.getTime() + BUFFER_MINUTES * 60 * 1000)

  // Adjust scheduled departures based on real-time vessel locations
  const adjustedSchedule = schedule.map(sailing => {
    const vessel = vesselLocations.find(v =>
      v.vesselName.toLowerCase() === sailing.vesselName.toLowerCase()
    )

    // If vessel has an ETA (meaning it's not at the dock yet),
    // the actual departure will be delayed
    if (vessel?.eta) {
      const vesselArrival = vessel.eta
      const estimatedDeparture = new Date(vesselArrival.getTime() + VESSEL_LOADING_TIME * 60 * 1000)

      // Use the later of scheduled or estimated departure
      if (estimatedDeparture > sailing.departureTime) {
        return {
          ...sailing,
          departureTime: estimatedDeparture,
          isDelayed: true,
        }
      }
    }

    return { ...sailing, isDelayed: false }
  })

  // Find missed sailings (depart before we can make it) and next catchable
  const missedSailings = adjustedSchedule
    .filter(s => s.departureTime <= cutoffTime && s.departureTime > now)
    .map(s => s.departureTime)

  const nextSailing = adjustedSchedule.find(s => s.departureTime > cutoffTime)

  if (!nextSailing) {
    // No more sailings today
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
      risks: { timingRisk: null, spaceRisk: null, overall: 'high' },
    }
  }

  // Find space info for this sailing
  const spaceInfo = sailingSpaces.find(
    s => Math.abs(s.departureTime.getTime() - nextSailing.departureTime.getTime()) < 5 * 60 * 1000
  )

  const spacesAvailable = spaceInfo?.driveUpSpaceCount ?? null
  const canMakeIt = spacesAvailable === null || spacesAvailable > 0

  // Calculate wait time at terminal
  const waitTime = Math.max(
    0,
    Math.round((nextSailing.departureTime.getTime() - arrivalAtTerminal.getTime()) / 60000)
  )

  const totalTime = driveToTerminal + waitTime + crossingTime + driveFromTerminal

  // Calculate risks
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
    risks: { timingRisk, spaceRisk, overall: overallRisk },
  }
}
