import { useState, useEffect, useCallback } from 'react'
import type { Location, RouteOption, SailingSpace } from '../types'
import {
  getTerminalSailingSpace,
  getScheduleToday,
  getVesselLocations,
  TERMINALS,
  TERMINAL_LOCATIONS,
} from '../api/ferries'
import { getDriveMinutesAndSummary, getDriveTimeMinutes } from '../api/routes'
import type { HomeLeg, PlanInputs, RecordedSailing, RecordedSpace } from '../lib/planInputs'
import { planRoutesV0 } from '../lib/routePlan.v0'

interface UseRouteCalculationProps {
  currentLocation: Location | null
  homeLocation: Location | null
}

interface UseRouteCalculationResult {
  routes: RouteOption[]
  bestRoute: RouteOption | null
  isLoading: boolean
  error: string | null
  warnings: string[]
  refresh: () => void
}

type Schedule = Awaited<ReturnType<typeof getScheduleToday>>

// A route is only dropped when data it can't be computed without is missing,
// so one flaky upstream service doesn't take out the whole comparison.
function fulfilled<T>(result: PromiseSettledResult<T>): result is PromiseFulfilledResult<T> {
  return result.status === 'fulfilled'
}

function valueOr<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return fulfilled(result) ? result.value : fallback
}

function minutesOrNull(result: PromiseSettledResult<number>): number | null {
  return fulfilled(result) ? result.value : null
}

function toSailings(result: PromiseSettledResult<Schedule>): RecordedSailing[] | null {
  if (!fulfilled(result)) return null
  return result.value.map(s => ({
    departure: s.departureTime.toISOString(),
    // getScheduleToday substitutes departure for a missing arrival; record
    // null instead so consumers can price the crossing correctly.
    arrival: s.arrivalTime.getTime() === s.departureTime.getTime() ? null : s.arrivalTime.toISOString(),
    vesselName: s.vesselName,
  }))
}

function toSpaces(result: PromiseSettledResult<SailingSpace[]>): RecordedSpace[] {
  return valueOr(result, []).map(s => ({
    departure: s.departureTime.toISOString(),
    driveUpSpaceCount: s.driveUpSpaceCount,
    totalSpaces: s.totalSpaces,
  }))
}

// The app prices the drive home with live traffic, hence departAt null
function liveHomeLeg(result: PromiseSettledResult<number>): HomeLeg[] {
  return fulfilled(result) ? [{ departAt: null, minutes: result.value }] : []
}

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
  const [warnings, setWarnings] = useState<string[]>([])

  const calculate = useCallback(async () => {
    if (!currentLocation || !homeLocation) {
      setRoutes([]) // Clear stale results when location is cleared
      setWarnings([])
      return
    }

    // Check if already at home
    if (isNearby(currentLocation, homeLocation)) {
      setRoutes([])
      setWarnings([])
      setError('You\'re already home.')
      return
    }

    setIsLoading(true)
    setError(null)
    setWarnings([])

    try {
      const now = new Date()

      const [
        driveToSeattle,
        driveToEdmonds,
        driveFromBainbridge,
        driveFromKingston,
        // Straight home without boarding a boat
        driveNoFerry,
        seattleSpaces,
        edmondsSpaces,
        seattleSchedule,
        edmondsSchedule,
        vesselLocations,
      ] = await Promise.allSettled([
        getDriveTimeMinutes(currentLocation, TERMINAL_LOCATIONS[TERMINALS.SEATTLE]),
        getDriveTimeMinutes(currentLocation, TERMINAL_LOCATIONS[TERMINALS.EDMONDS]),
        getDriveTimeMinutes(TERMINAL_LOCATIONS[TERMINALS.BAINBRIDGE], homeLocation),
        getDriveTimeMinutes(TERMINAL_LOCATIONS[TERMINALS.KINGSTON], homeLocation),
        getDriveMinutesAndSummary(currentLocation, homeLocation, { avoidFerries: true }),
        getTerminalSailingSpace(TERMINALS.SEATTLE),
        getTerminalSailingSpace(TERMINALS.EDMONDS),
        getScheduleToday(TERMINALS.SEATTLE, TERMINALS.BAINBRIDGE, true),
        getScheduleToday(TERMINALS.EDMONDS, TERMINALS.KINGSTON, true),
        getVesselLocations(),
      ])

      const inputs: PlanInputs = {
        now: now.toISOString(),
        drive: fulfilled(driveNoFerry) ? driveNoFerry.value : null,
        // Vessel positions and sailing space are refinements - degrade to empty
        vessels: valueOr(vesselLocations, []).map(v => ({
          vesselName: v.vesselName,
          eta: v.eta ? v.eta.toISOString() : null,
          departingTerminalId: v.departingTerminalId,
          arrivingTerminalId: v.arrivingTerminalId,
          scheduledDeparture: v.scheduledDeparture ? v.scheduledDeparture.toISOString() : null,
          leftDock: v.leftDock ? v.leftDock.toISOString() : null,
          atDock: v.atDock,
          inService: v.inService,
        })),
        ferries: {
          BAINBRIDGE: {
            driveToTerminalMinutes: minutesOrNull(driveToSeattle),
            schedule: toSailings(seattleSchedule),
            spaces: toSpaces(seattleSpaces),
            homeLegs: liveHomeLeg(driveFromBainbridge),
          },
          KINGSTON: {
            driveToTerminalMinutes: minutesOrNull(driveToEdmonds),
            schedule: toSailings(edmondsSchedule),
            spaces: toSpaces(edmondsSpaces),
            homeLegs: liveHomeLeg(driveFromKingston),
          },
        },
      }

      const plan = planRoutesV0(inputs)

      if (plan.routes.length === 0) {
        setRoutes([])
        setError('Could not reach the routing services. Try again in a moment.')
        return
      }

      setRoutes(plan.routes)
      setWarnings(plan.warnings)
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
    warnings,
    refresh: calculate,
  }
}
