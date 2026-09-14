import type { Location } from '../types'
import type { FerryInputs, FerryRouteName, HomeLeg, PlanInputs, RecordedSailing } from '../lib/planInputs'
import { TERMINALS, TERMINAL_LOCATIONS } from '../api/ferries'
import type { DriveRequest, DriveResult, Upstream } from './upstream'
import type { RoutesBudget } from './budget'
import { candidateSailings } from './candidates'

export interface Origin {
  id: string
  label: string
  location: Location
}

export const ORIGINS: Origin[] = [
  { id: 'downtown', label: 'Downtown (Westlake)', location: { lat: 47.6114, lng: -122.3374 } },
  { id: 'northgate', label: 'Northgate', location: { lat: 47.7063, lng: -122.3255 } },
]

export const CANDIDATES_PER_ROUTE = 3

// Per origin: to Colman, to Edmonds, drive around. Shared: two terminal-home
// legs live, plus timed home legs for each route's candidate sailings.
export function maxRoutesCalls(originCount: number): number {
  return originCount * 3 + 2 + 2 * CANDIDATES_PER_ROUTE
}

export interface SampleRecord {
  sampleId: string
  origin: Origin
  now: string
  inputs: PlanInputs
}

export interface SampleResult {
  records: SampleRecord[]
  routesCalls: number
  skipped: 'budget' | null
}

const FERRY_ROUTES: Array<{
  name: FerryRouteName
  departing: keyof typeof TERMINAL_LOCATIONS
  arriving: keyof typeof TERMINAL_LOCATIONS
}> = [
  { name: 'BAINBRIDGE', departing: TERMINALS.SEATTLE, arriving: TERMINALS.BAINBRIDGE },
  { name: 'KINGSTON', departing: TERMINALS.EDMONDS, arriving: TERMINALS.KINGSTON },
]

function valueOr<T, F>(result: PromiseSettledResult<T>, fallback: F): T | F {
  return result.status === 'fulfilled' ? result.value : fallback
}

export async function runSample({
  upstream,
  home,
  now,
  budget,
  origins = ORIGINS,
}: {
  upstream: Upstream
  home: Location
  now: Date
  budget: RoutesBudget
  origins?: Origin[]
}): Promise<SampleResult> {
  if (!budget.canSpend(maxRoutesCalls(origins.length))) {
    return { records: [], routesCalls: 0, skipped: 'budget' }
  }

  let routesCalls = 0
  const drive = (origin: Location, destination: Location, request?: DriveRequest): Promise<DriveResult> => {
    routesCalls++
    return upstream.drive(origin, destination, request)
  }

  // Live legs double as observations of traffic right now
  const originLegs = await Promise.all(origins.map(origin => Promise.allSettled([
    drive(origin.location, TERMINAL_LOCATIONS[TERMINALS.SEATTLE]),
    drive(origin.location, TERMINAL_LOCATIONS[TERMINALS.EDMONDS]),
    drive(origin.location, home, { avoidFerries: true }),
  ])))

  const perRoute = await Promise.all(FERRY_ROUTES.map(async (route, routeIndex) => {
    const [liveHome, schedule, spaces] = await Promise.allSettled([
      drive(TERMINAL_LOCATIONS[route.arriving], home),
      upstream.schedule(route.departing, route.arriving),
      upstream.spaces(route.departing, route.arriving),
    ])

    const homeLegs: HomeLeg[] = liveHome.status === 'fulfilled'
      ? [{ departAt: null, minutes: liveHome.value.minutes }]
      : []

    const driveMinutes = originLegs
      .map(legs => legs[routeIndex])
      .flatMap(leg => (leg.status === 'fulfilled' ? [leg.value.minutes] : []))

    if (schedule.status === 'fulfilled' && driveMinutes.length > 0) {
      const earliest = new Date(now.getTime() + Math.min(...driveMinutes) * 60_000)
      const picks: RecordedSailing[] = candidateSailings(schedule.value, earliest, CANDIDATES_PER_ROUTE)
      const timed = await Promise.allSettled(
        picks.map(s => drive(TERMINAL_LOCATIONS[route.arriving], home, { departAt: new Date(s.arrival) }))
      )
      timed.forEach((leg, i) => {
        if (leg.status === 'fulfilled') homeLegs.push({ departAt: picks[i].arrival, minutes: leg.value.minutes })
      })
    }

    return {
      schedule: valueOr(schedule, null),
      spaces: valueOr(spaces, []),
      homeLegs,
    }
  }))

  const vessels = valueOr(await Promise.allSettled([upstream.vessels()]).then(([v]) => v), [])

  budget.spend(routesCalls)

  const nowIso = now.toISOString()
  const records = origins.map((origin, originIndex): SampleRecord => {
    const [toSeattle, toEdmonds, around] = originLegs[originIndex]
    const ferry = (routeIndex: number, toTerminal: PromiseSettledResult<DriveResult>): FerryInputs => ({
      driveToTerminalMinutes: toTerminal.status === 'fulfilled' ? toTerminal.value.minutes : null,
      ...perRoute[routeIndex],
    })

    return {
      sampleId: `${origin.id}-${nowIso}`,
      origin,
      now: nowIso,
      inputs: {
        now: nowIso,
        drive: valueOr(around, null),
        vessels,
        ferries: {
          BAINBRIDGE: ferry(0, toSeattle),
          KINGSTON: ferry(1, toEdmonds),
        },
      },
    }
  })

  return { records, routesCalls, skipped: null }
}
