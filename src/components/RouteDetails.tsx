import type { Location, RouteOption } from '../types'
import { TERMINALS, TERMINAL_LOCATIONS } from '../api/ferries'
import { CarIcon, FerryIcon, CloseIcon } from './Icons'

// Where each ferry route boards
const DEPARTS_FROM: Record<string, Location> = {
  BAINBRIDGE: TERMINAL_LOCATIONS[TERMINALS.SEATTLE],
  KINGSTON: TERMINAL_LOCATIONS[TERMINALS.EDMONDS],
}

interface RouteDetailsProps {
  routes: RouteOption[]
  currentLocation: Location
  homeLocation: Location
  onClose: () => void
  onRefresh: () => void
}

function coord(location: Location): string {
  return `${location.lat},${location.lng}`
}

function buildGoogleMapsUrl(
  origin: Location,
  destination: Location,
  options: { avoidFerries?: boolean; via?: Location } = {}
): string {
  const params = new URLSearchParams({
    api: '1',
    origin: coord(origin),
    destination: coord(destination),
    travelmode: 'driving',
  })
  if (options.via) {
    params.set('waypoints', coord(options.via))
  }
  if (options.avoidFerries) {
    params.set('avoid', 'ferries')
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`
}

// Every link covers the whole trip home, so Maps shows the same journey the
// estimate describes rather than just its first leg.
function getGoogleMapsUrl(
  routeName: string,
  routeType: 'ferry' | 'drive-around',
  currentLocation: Location,
  homeLocation: Location
): string {
  if (routeType === 'drive-around') {
    return buildGoogleMapsUrl(currentLocation, homeLocation, { avoidFerries: true })
  }

  // Route through the departure terminal so Maps picks this crossing and not
  // whichever one it likes best
  const departsFrom = DEPARTS_FROM[routeName]
  return buildGoogleMapsUrl(currentLocation, homeLocation, { via: departsFrom })
}

function displayName(route: RouteOption) {
  if (route.type === 'drive-around') return 'Drive home'
  return route.name.charAt(0) + route.name.slice(1).toLowerCase()
}

export function RouteDetails({ routes, currentLocation, homeLocation, onClose, onRefresh }: RouteDetailsProps) {
  const now = new Date()

  const formatTime = (minutes: number | null) => {
    if (minutes === null || minutes === Infinity) return '—'
    const hours = Math.floor(minutes / 60)
    const mins = minutes % 60
    if (hours > 0) {
      return `${hours}h ${mins}m`
    }
    return `${mins}m`
  }

  const formatClockTime = (date: Date | null) => {
    if (!date) return '—'
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  const winner = routes[0]

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Every option</h1>
        <button className="icon-button" onClick={onClose} aria-label="Close">
          <CloseIcon />
        </button>
      </div>

      <div className="page-body">
        {routes.map((route) => (
          <div
            key={route.name}
            className={`detail-route ${route.name === winner.name ? 'is-best' : ''}`}
          >
            <div className="detail-head">
              <span className="detail-icon">
                {route.type === 'drive-around' ? <CarIcon size={16} /> : <FerryIcon size={16} />}
              </span>
              <span className="detail-name">{displayName(route)}</span>
              <span className="detail-total">{formatTime(route.totalTimeMinutes)}</span>
            </div>

            {route.type === 'ferry' && (() => {
              // Calculate cumulative times
              const arriveTerminal = route.driveToTerminalMinutes
                ? new Date(now.getTime() + route.driveToTerminalMinutes * 60 * 1000)
                : null
              const ferryDeparts = route.nextDeparture
              const ferryArrives = ferryDeparts && route.ferryTimeMinutes
                ? new Date(ferryDeparts.getTime() + route.ferryTimeMinutes * 60 * 1000)
                : null
              const arriveHome = ferryArrives && route.driveFromTerminalMinutes
                ? new Date(ferryArrives.getTime() + route.driveFromTerminalMinutes * 60 * 1000)
                : null

              return (
                <div className="detail-rows">
                  {route.missedSailings.length > 0 && (
                    <div className="detail-row is-missed">
                      <span>Just missed</span>
                      <span>{route.missedSailings.map(d => formatClockTime(d)).join(', ')}</span>
                    </div>
                  )}
                  <div className="detail-row">
                    <span>At the terminal</span>
                    <span>{formatClockTime(arriveTerminal)} · {formatTime(route.driveToTerminalMinutes)} drive</span>
                  </div>
                  <div className="detail-row">
                    <span>Waiting</span>
                    <span>{formatTime(route.waitTimeMinutes)}</span>
                  </div>
                  <div className="detail-row">
                    <span>Sails</span>
                    <span>{formatClockTime(ferryDeparts)}</span>
                  </div>
                  <div className="detail-row">
                    <span>Lands</span>
                    <span>{formatClockTime(ferryArrives)} · {formatTime(route.ferryTimeMinutes)} crossing</span>
                  </div>
                  <div className="detail-row">
                    <span>Home</span>
                    <span>{formatClockTime(arriveHome)} · {formatTime(route.driveFromTerminalMinutes)} drive</span>
                  </div>
                  {route.spacesAvailable !== null && (
                    <div className="detail-row">
                      <span>Car deck</span>
                      <span>
                        {route.spacesAvailable > 0 ? `${route.spacesAvailable} spaces` : 'Full'}
                      </span>
                    </div>
                  )}
                </div>
              )
            })()}

            {route.type === 'drive-around' && (() => {
              const arriveHome = route.totalTimeMinutes !== Infinity
                ? new Date(now.getTime() + route.totalTimeMinutes * 60 * 1000)
                : null

              return (
                <div className="detail-rows">
                  <div className="detail-row">
                    <span>{route.driveSummary ? `Via ${route.driveSummary}` : 'Straight through, no ferry'}</span>
                    <span>{formatClockTime(arriveHome)} · {formatTime(route.totalTimeMinutes)}</span>
                  </div>
                </div>
              )
            })()}

            <a
              href={getGoogleMapsUrl(route.name, route.type, currentLocation, homeLocation)}
              target="_blank"
              rel="noopener noreferrer"
              className="detail-link"
            >
              Open in Maps
            </a>
          </div>
        ))}

        <div className="footer" style={{ borderTop: 'none', padding: '20px 0 0' }}>
          <button className="text-button" onClick={onRefresh}>Refresh</button>
        </div>
      </div>
    </div>
  )
}
