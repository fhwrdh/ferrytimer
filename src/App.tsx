import { useState, useEffect, useRef } from 'react'
import type { Location, RouteOption } from './types'
import { useRouteCalculation } from './hooks/useRouteCalculation'
import { reverseGeocode } from './api/routes'
import { Settings } from './components/Settings'
import { RouteDetails } from './components/RouteDetails'
import { CarIcon, FerryIcon, GearIcon } from './components/Icons'
import './App.css'

// Test locations - dev builds only, never shipped to production
const IS_DEV = import.meta.env.DEV

const TEST_LOCATIONS: { name: string; location: Location }[] = [
  { name: 'Northgate', location: { lat: 47.7063, lng: -122.3255 } },
  { name: 'SeaTac Airport', location: { lat: 47.4502, lng: -122.3088 } },
  { name: 'Downtown Seattle', location: { lat: 47.6062, lng: -122.3321 } },
  { name: 'University District', location: { lat: 47.6614, lng: -122.3131 } },
  { name: 'Bellevue', location: { lat: 47.6101, lng: -122.2015 } },
]

// Where each ferry route boards
const DEPARTS_FROM: Record<string, string> = {
  BAINBRIDGE: 'Colman Dock',
  KINGSTON: 'Edmonds',
}

function displayName(route: RouteOption) {
  if (route.type === 'drive-around') return 'Drive around'
  return route.name.charAt(0) + route.name.slice(1).toLowerCase()
}

function formatDuration(minutes: number | null) {
  if (minutes === null || minutes === Infinity) return '—'
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`
}

function formatClock(date: Date | null) {
  if (!date) return '—'
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function App() {
  const [showSettings, setShowSettings] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [showLocationPicker, setShowLocationPicker] = useState(false)
  const [currentLocation, setCurrentLocation] = useState<Location | null>(null)
  const [locationError, setLocationError] = useState<string | null>(null)
  const [usingTestLocation, setUsingTestLocation] = useState<string | null>(null)
  const [friendlyLocationName, setFriendlyLocationName] = useState<string | null>(null)
  const usingTestLocationRef = useRef<boolean>(false)

  // Load config from localStorage
  const [config, setConfig] = useState(() => {
    const saved = localStorage.getItem('ferrytimer-config')
    if (saved) {
      const parsed = JSON.parse(saved)
      return {
        homeAddress: parsed.homeAddress || '',
        homeLocation: parsed.homeLocation,
        ferryPreferenceBias: parsed.ferryPreferenceBias ?? 0,
      }
    }
    return {
      homeAddress: '',
      homeLocation: null,
      ferryPreferenceBias: 0,
    }
  })

  // Get current location
  useEffect(() => {
    if (!navigator.geolocation) {
      setLocationError('This device can\'t report a location.')
      return
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        // Don't overwrite test location with GPS
        if (usingTestLocationRef.current) return

        setCurrentLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        })
        setLocationError(null)
      },
      (error) => {
        // Don't show GPS errors when using test location
        if (usingTestLocationRef.current) return

        setLocationError(error.message)
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 30000,
      }
    )

    return () => navigator.geolocation.clearWatch(watchId)
  }, [])

  // Reverse geocode GPS location to get a friendly name
  useEffect(() => {
    if (!currentLocation || usingTestLocation) {
      setFriendlyLocationName(null)
      return
    }

    reverseGeocode(currentLocation)
      .then(name => setFriendlyLocationName(name))
      .catch(() => setFriendlyLocationName(null))
  }, [currentLocation, usingTestLocation])

  const { routes, bestRoute, isLoading, error, warnings, refresh } = useRouteCalculation({
    currentLocation,
    homeLocation: config.homeLocation,
  })

  const saveConfig = (newConfig: typeof config) => {
    setConfig(newConfig)
    localStorage.setItem('ferrytimer-config', JSON.stringify(newConfig))
  }

  const setTestLocation = (name: string, location: Location) => {
    usingTestLocationRef.current = true
    setCurrentLocation(location)
    setUsingTestLocation(name)
    setLocationError(null)
  }

  const clearTestLocation = () => {
    usingTestLocationRef.current = false
    setCurrentLocation(null)
    setUsingTestLocation(null)
    setLocationError(null)

    // Try to get fresh GPS position
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setCurrentLocation({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          })
          setLocationError(null)
        },
        (err) => {
          setLocationError(err.message)
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0,
        }
      )
    }
  }

  // Check if we need to show settings
  const needsSetup = !config.homeLocation

  if (showSettings || needsSetup) {
    return (
      <Settings
        config={config}
        onSave={saveConfig}
        onClose={() => setShowSettings(false)}
        isInitialSetup={needsSetup}
      />
    )
  }

  if (showDetails && currentLocation && config.homeLocation) {
    return (
      <RouteDetails
        routes={routes}
        currentLocation={currentLocation}
        homeLocation={config.homeLocation}
        onClose={() => setShowDetails(false)}
        onRefresh={refresh}
      />
    )
  }

  const hasRoutes = !isLoading && !error && !!bestRoute

  return (
    <div className="app">
      <div className="topbar">
        <div className="origin">
          {currentLocation && (
            <>
              <span className="origin-label">From</span>
              <span className="origin-value">
                {usingTestLocation || friendlyLocationName ||
                  `${currentLocation.lat.toFixed(3)}, ${currentLocation.lng.toFixed(3)}`}
              </span>
            </>
          )}
        </div>
        <button className="icon-button" onClick={() => setShowSettings(true)} aria-label="Settings">
          <GearIcon />
        </button>
      </div>

      <main className="main">
        <div className="sheet">
          {locationError && !usingTestLocation && (
            <>
              <div className="error">{locationError}</div>
              <button className="quiet-button" onClick={clearTestLocation}>
                Try again
              </button>
              {IS_DEV && (
                <div className="test-locations">
                  <p>Test locations</p>
                  <div className="test-location-buttons">
                    {TEST_LOCATIONS.map((loc) => (
                      <button
                        key={loc.name}
                        className="quiet-button"
                        onClick={() => setTestLocation(loc.name, loc.location)}
                      >
                        {loc.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {error && <div className="error">{error}</div>}

          {isLoading && (
            <div className="pending" aria-label="Calculating routes">
              <div className="pending-bar" />
              <div className="pending-bar" />
              <div className="pending-bar" />
            </div>
          )}

          {hasRoutes && (
            <Recommendation allRoutes={routes} ferryBias={config.ferryPreferenceBias} />
          )}

          {!isLoading && !error && !bestRoute && !locationError && !usingTestLocation && (
            <p className="waiting">Finding you…</p>
          )}

          {hasRoutes && warnings.length > 0 && (
            <div className="warnings">
              {warnings.map((w) => (
                <div key={w} className="warning">{w}</div>
              ))}
            </div>
          )}
        </div>
      </main>

      {IS_DEV && showLocationPicker && (
        <div className="picker-overlay" onClick={() => setShowLocationPicker(false)}>
          <div className="picker" onClick={(e) => e.stopPropagation()}>
            <p className="picker-title">Starting point</p>
            <button
              className={`picker-option ${!usingTestLocation ? 'is-active' : ''}`}
              onClick={() => {
                clearTestLocation()
                setShowLocationPicker(false)
              }}
            >
              GPS
            </button>
            {TEST_LOCATIONS.map((loc) => (
              <button
                key={loc.name}
                className={`picker-option ${usingTestLocation === loc.name ? 'is-active' : ''}`}
                onClick={() => {
                  setTestLocation(loc.name, loc.location)
                  setShowLocationPicker(false)
                }}
              >
                {loc.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {currentLocation && (
        <footer className="footer">
          <div className="bias">
            <CarIcon size={14} />
            <input
              type="range"
              min="0"
              max="30"
              step="5"
              value={config.ferryPreferenceBias}
              aria-label={`Ferry preference, plus ${config.ferryPreferenceBias} minutes`}
              onChange={(e) => saveConfig({ ...config, ferryPreferenceBias: parseInt(e.target.value, 10) })}
            />
            <FerryIcon size={14} />
          </div>
          {hasRoutes && (
            <button className="text-button" onClick={() => setShowDetails(true)}>
              Details
            </button>
          )}
          {IS_DEV && (
            <button className="text-button" onClick={() => setShowLocationPicker(true)}>
              {usingTestLocation || 'GPS'}
            </button>
          )}
          <button className="text-button" onClick={refresh} disabled={isLoading}>
            Refresh
          </button>
        </footer>
      )}
    </div>
  )
}

interface Leg {
  time: Date
  what: string
  duration: number | null
  kind?: 'sail' | 'end'
  note?: string
  noteIsAlert?: boolean
}

// Break a route into the legs shown on the rail, in real time order
function buildLegs(route: RouteOption, now: Date): Leg[] {
  const legs: Leg[] = []
  const at = (minutes: number) => new Date(now.getTime() + minutes * 60 * 1000)

  if (route.type === 'drive-around') {
    legs.push({ time: now, what: 'Drive via the Narrows', duration: route.totalTimeMinutes })
    legs.push({ time: at(route.totalTimeMinutes), what: 'Home', duration: null, kind: 'end' })
    return legs
  }

  const drive = route.driveToTerminalMinutes ?? 0
  const wait = route.waitTimeMinutes ?? 0
  const crossing = route.ferryTimeMinutes ?? 0
  const fromTerminal = route.driveFromTerminalMinutes ?? 0

  legs.push({
    time: now,
    what: `Drive to ${DEPARTS_FROM[route.name] ?? 'the terminal'}`,
    duration: drive,
  })

  if (wait > 0) {
    legs.push({ time: at(drive), what: 'Wait at terminal', duration: wait })
  }

  const spaces = route.spacesAvailable
  legs.push({
    time: route.nextDeparture ?? at(drive + wait),
    what: `Sail to ${displayName(route)}`,
    duration: crossing,
    kind: 'sail',
    note: spaces === null ? undefined : spaces > 0 ? `${spaces} spaces` : 'Boat is full',
    noteIsAlert: spaces !== null && spaces < 10,
  })

  legs.push({ time: at(drive + wait + crossing), what: 'Drive home', duration: fromTerminal })
  legs.push({ time: at(route.totalTimeMinutes), what: 'Home', duration: null, kind: 'end' })

  return legs
}

function Rail({ route, now }: { route: RouteOption; now: Date }) {
  return (
    <ol className="rail">
      {buildLegs(route, now).map((leg, i) => (
        <li
          key={i}
          className={`leg ${leg.kind === 'sail' ? 'is-sail' : ''} ${leg.kind === 'end' ? 'is-end' : ''}`}
          style={{ '--span': leg.duration ?? 0 } as React.CSSProperties}
        >
          <div className="leg-head">
            <span className="leg-time">{formatClock(leg.time)}</span>
            <span className="leg-what">{leg.what}</span>
            {leg.duration !== null && (
              <span className="leg-dur">{formatDuration(leg.duration)}</span>
            )}
          </div>
          {leg.note && (
            <div className={`leg-note ${leg.noteIsAlert ? 'is-alert' : ''}`}>{leg.note}</div>
          )}
        </li>
      ))}
    </ol>
  )
}

function Recommendation({ allRoutes, ferryBias }: { allRoutes: RouteOption[]; ferryBias: number }) {
  const now = new Date()

  // Apply ferry bias to determine effective winner
  const adjustedRoutes = allRoutes.map(r => ({
    ...r,
    adjustedTime: r.type === 'drive-around'
      ? r.totalTimeMinutes + ferryBias
      : r.totalTimeMinutes
  })).sort((a, b) => a.adjustedTime - b.adjustedTime)

  const winner = adjustedRoutes[0]
  const secondBest = adjustedRoutes[1]

  const timeDiff = secondBest ? Math.abs(winner.adjustedTime - secondBest.adjustedTime) : Infinity
  const isCloseCall = timeDiff <= 15 && !!secondBest && winner.totalTimeMinutes !== Infinity

  if (isCloseCall) {
    return (
      <div className="enter">
        <div className="closecall-head">
          <p className="verdict-eyebrow">Too close to call</p>
          <h1 className="verdict-name">{Math.round(timeDiff)} minutes apart</h1>
          <p className="closecall-note">Either works. Pick on the trade-offs.</p>
        </div>

        <div>
          {adjustedRoutes.slice(0, 2).map((r) => (
            <Option key={r.name} route={r} now={now} />
          ))}
        </div>
      </div>
    )
  }

  const arriveHome = winner.totalTimeMinutes === Infinity
    ? null
    : new Date(now.getTime() + winner.totalTimeMinutes * 60 * 1000)

  return (
    <div className="enter">
      <div>
        <p className="verdict-eyebrow">
          {winner.type === 'drive-around' ? 'Skip the boat' : 'Take the'}
        </p>
        <h1 className="verdict-name">{displayName(winner)}</h1>
        <div className="verdict-meta">
          <span>{formatDuration(winner.totalTimeMinutes)}</span>
          <span>·</span>
          <span>home by {formatClock(arriveHome)}</span>
          {winner.risks.overall === 'high' && (
            <span className="verdict-flag is-alert">tight</span>
          )}
        </div>
      </div>

      <Rail route={winner} now={now} />

      <div className="alts">
        {adjustedRoutes.slice(1).map((r) => (
          <div key={r.name} className="alt">
            <span className="alt-icon">
              {r.type === 'drive-around' ? <CarIcon /> : <FerryIcon />}
            </span>
            <span className="alt-name">{displayName(r)}</span>
            <span className="alt-delta">
              {r.totalTimeMinutes === Infinity
                ? 'no sailings'
                : `+${Math.round(r.adjustedTime - winner.adjustedTime)}m`}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Option({ route, now }: { route: RouteOption; now: Date }) {
  const arriveHome = route.totalTimeMinutes === Infinity
    ? null
    : new Date(now.getTime() + route.totalTimeMinutes * 60 * 1000)

  const detail = route.type === 'drive-around'
    ? `No waiting · home by ${formatClock(arriveHome)}`
    : `Sails ${formatClock(route.nextDeparture)} · home by ${formatClock(arriveHome)}`

  const caution = route.type === 'ferry' && route.risks.spaceRisk === 'high'
    ? `Only ${route.spacesAvailable} spaces left`
    : route.type === 'ferry' && route.risks.timingRisk === 'high'
      ? `Tight — ${route.waitTimeMinutes}m to spare at the dock`
      : null

  return (
    <div className="option">
      <div className="option-head">
        <span className="option-icon">
          {route.type === 'drive-around' ? <CarIcon size={16} /> : <FerryIcon size={16} />}
        </span>
        <span className="option-name">{displayName(route)}</span>
        <span className="option-total">{formatDuration(route.totalTimeMinutes)}</span>
      </div>
      <div className="option-line">{detail}</div>
      {caution && <div className="option-line is-alert">{caution}</div>}
    </div>
  )
}

export default App
