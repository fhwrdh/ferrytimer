import type { RouteOption } from '../types'

interface RouteDetailsProps {
  routes: RouteOption[]
  onClose: () => void
  onRefresh: () => void
}

export function RouteDetails({ routes, onClose, onRefresh }: RouteDetailsProps) {
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

          {route.type === 'ferry' && (
            <div className="route-card-breakdown">
              {route.missedSailings.length > 0 && (
                <div className="breakdown-row missed-sailings">
                  <span>Missed</span>
                  <span>{route.missedSailings.map(d => formatClockTime(d)).join(', ')}</span>
                </div>
              )}
              <div className="breakdown-row">
                <span>Arrive at terminal</span>
                <span>{formatDurationWithArrival(route.driveToTerminalMinutes)}</span>
              </div>
              <div className="breakdown-row">
                <span>Ferry departs</span>
                <span>{formatClockTime(route.nextDeparture)}</span>
              </div>
              <div className="breakdown-row">
                <span>Wait at terminal</span>
                <span>{formatTime(route.waitTimeMinutes)}</span>
              </div>
              <div className="breakdown-row">
                <span>Ferry crossing</span>
                <span>{formatTime(route.ferryTimeMinutes)}</span>
              </div>
              <div className="breakdown-row">
                <span>Drive home from ferry</span>
                <span>{formatTime(route.driveFromTerminalMinutes)}</span>
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
          )}

          {route.type === 'drive-around' && (
            <div className="route-card-breakdown">
              <div className="breakdown-row">
                <span>Via Tacoma / Narrows Bridge</span>
                <span>{formatTime(route.totalTimeMinutes)}</span>
              </div>
            </div>
          )}
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
