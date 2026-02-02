import type { Location, RouteOption } from '../types'

// Terminal locations for Google Maps links
const TERMINALS = {
  SEATTLE: { lat: 47.6023, lng: -122.3384 },
  BAINBRIDGE: { lat: 47.6227, lng: -122.5109 },
  EDMONDS: { lat: 47.8137, lng: -122.3835 },
  KINGSTON: { lat: 47.7967, lng: -122.4943 },
}

const TACOMA_NARROWS = { lat: 47.2690, lng: -122.5515 }

interface RouteDetailsProps {
  routes: RouteOption[]
  currentLocation: Location
  homeLocation: Location
  onClose: () => void
  onRefresh: () => void
}

function buildGoogleMapsUrl(
  origin: Location,
  destination: Location,
  waypoints?: Location[]
): string {
  let url = `https://www.google.com/maps/dir/?api=1`
  url += `&origin=${origin.lat},${origin.lng}`
  url += `&destination=${destination.lat},${destination.lng}`
  if (waypoints && waypoints.length > 0) {
    const waypointStr = waypoints.map(w => `${w.lat},${w.lng}`).join('|')
    url += `&waypoints=${waypointStr}`
  }
  url += `&travelmode=driving`
  return url
}

function getGoogleMapsUrl(
  routeName: string,
  routeType: 'ferry' | 'drive-around',
  currentLocation: Location,
  homeLocation: Location
): string {
  if (routeType === 'drive-around') {
    return buildGoogleMapsUrl(currentLocation, homeLocation, [TACOMA_NARROWS])
  }

  // Ferry routes: drive to terminal, then from other terminal to home
  // For now, just show drive to the departure terminal
  if (routeName === 'BAINBRIDGE') {
    return buildGoogleMapsUrl(currentLocation, TERMINALS.SEATTLE)
  }
  if (routeName === 'KINGSTON') {
    return buildGoogleMapsUrl(currentLocation, TERMINALS.EDMONDS)
  }

  return buildGoogleMapsUrl(currentLocation, homeLocation)
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

  const formatDurationWithArrival = (minutes: number | null) => {
    if (minutes === null || minutes === Infinity) return '—'
    const arrivalTime = new Date(now.getTime() + minutes * 60 * 1000)
    return `${formatTime(minutes)} (${formatClockTime(arrivalTime)})`
  }

  const winner = routes[0]

  return (
    <div className="details">
      <header className="details-header">
        <h1>Route Comparison</h1>
        <button className="close-button" onClick={onClose}>
          ✕
        </button>
      </header>

      {routes.map((route) => (
        <div
          key={route.name}
          className={`route-card ${route.name === winner.name ? 'winner' : ''}`}
        >
          <div className="route-card-header">
            <span className="route-card-name">
              {route.type === 'drive-around' ? '🚗 ' : '⛴️ '}
              {route.name}
            </span>
            <span className="route-card-total">{formatTime(route.totalTimeMinutes)}</span>
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
              <div className="route-card-breakdown">
                {route.missedSailings.length > 0 && (
                  <div className="breakdown-row missed-sailings">
                    <span>Missed</span>
                    <span>{route.missedSailings.map(d => formatClockTime(d)).join(', ')}</span>
                  </div>
                )}
                <div className="breakdown-row">
                  <span>Arrive at terminal</span>
                  <span>{formatTime(route.driveToTerminalMinutes)} → {formatClockTime(arriveTerminal)}</span>
                </div>
                <div className="breakdown-row">
                  <span>Wait at terminal</span>
                  <span>{formatTime(route.waitTimeMinutes)}</span>
                </div>
                <div className="breakdown-row">
                  <span>Ferry departs</span>
                  <span>{formatClockTime(ferryDeparts)}</span>
                </div>
                <div className="breakdown-row">
                  <span>Ferry arrives</span>
                  <span>{formatTime(route.ferryTimeMinutes)} → {formatClockTime(ferryArrives)}</span>
                </div>
                <div className="breakdown-row">
                  <span>Arrive home</span>
                  <span>{formatTime(route.driveFromTerminalMinutes)} → {formatClockTime(arriveHome)}</span>
                </div>
                {route.spacesAvailable !== null && (
                  <div className="breakdown-row" style={{ marginTop: 8 }}>
                    <span>Spaces available</span>
                    <span
                      className={`badge ${route.spacesAvailable > 0 ? 'spaces' : 'no-spaces'}`}
                    >
                      {route.spacesAvailable > 0 ? route.spacesAvailable : 'FULL'}
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
              <div className="route-card-breakdown">
                <div className="breakdown-row">
                  <span>Via Tacoma / Narrows Bridge</span>
                  <span>{formatTime(route.totalTimeMinutes)} → {formatClockTime(arriveHome)}</span>
                </div>
              </div>
            )
          })()}

          <a
            href={getGoogleMapsUrl(route.name, route.type, currentLocation, homeLocation)}
            target="_blank"
            rel="noopener noreferrer"
            className="maps-link"
            onClick={(e) => e.stopPropagation()}
          >
            🗺️ Open in Google Maps
          </a>
        </div>
      ))}

      <div className="refresh-bar">
        <button className="refresh-button" onClick={onRefresh}>
          Refresh
        </button>
      </div>
    </div>
  )
}
