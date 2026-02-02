import { useState, useEffect, useRef } from 'react'
import type { Location, RouteOption } from './types'
import { useRouteCalculation } from './hooks/useRouteCalculation'
import { reverseGeocode } from './api/routes'
import { Settings } from './components/Settings'
import { RouteDetails } from './components/RouteDetails'
import './App.css'

// Test locations for development
const TEST_LOCATIONS: { name: string; location: Location }[] = [
  { name: 'Lake City', location: { lat: 47.7194, lng: -122.2930 } },
  { name: 'SeaTac Airport', location: { lat: 47.4502, lng: -122.3088 } },
  { name: 'Downtown Seattle', location: { lat: 47.6062, lng: -122.3321 } },
  { name: 'University District', location: { lat: 47.6614, lng: -122.3131 } },
  { name: 'Bellevue', location: { lat: 47.6101, lng: -122.2015 } },
]

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
      setLocationError('Geolocation not supported')
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

        setLocationError(`Location error: ${error.message}`)
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

  const { routes, bestRoute, isLoading, error, refresh } = useRouteCalculation({
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
          setLocationError(`Location error: ${err.message}`)
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

  return (
    <div className="app">
      <button
        className="settings-button"
        onClick={() => setShowSettings(true)}
        aria-label="Settings"
      >
        ⚙️
      </button>

      <main className="main" onClick={() => !isLoading && routes.length > 0 && setShowDetails(true)}>
        {currentLocation && (
          <div className="current-location-banner">
            <span className="location-label">From:</span>
            <span className="location-value">
              {usingTestLocation || friendlyLocationName || `${currentLocation.lat.toFixed(4)}, ${currentLocation.lng.toFixed(4)}`}
            </span>
          </div>
        )}

        {locationError && !usingTestLocation && (
          <div className="location-error-container">
            <div className="error location-error">{locationError}</div>
            <div className="test-locations">
              <p>Use a test location:</p>
              <div className="test-location-buttons">
                {TEST_LOCATIONS.map((loc) => (
                  <button
                    key={loc.name}
                    className="test-location-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      setTestLocation(loc.name, loc.location)
                    }}
                  >
                    {loc.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="error">{error}</div>
        )}

        {isLoading && (
          <div className="loading">
            <div className="spinner" />
            <p>Calculating routes...</p>
          </div>
        )}

        {!isLoading && !error && bestRoute && (
          <Recommendation allRoutes={routes} ferryBias={config.ferryPreferenceBias} />
        )}

        {!isLoading && !error && !bestRoute && !locationError && !usingTestLocation && (
          <div className="waiting">
            <p>Waiting for location...</p>
          </div>
        )}
      </main>

      {showLocationPicker && (
        <div className="location-picker-overlay" onClick={() => setShowLocationPicker(false)}>
          <div className="location-picker" onClick={(e) => e.stopPropagation()}>
            <h3>Change Starting Point</h3>
            <button
              className="location-option"
              onClick={() => {
                clearTestLocation()
                setShowLocationPicker(false)
              }}
            >
              📍 Use GPS Location
            </button>
            {TEST_LOCATIONS.map((loc) => (
              <button
                key={loc.name}
                className={`location-option ${usingTestLocation === loc.name ? 'active' : ''}`}
                onClick={() => {
                  setTestLocation(loc.name, loc.location)
                  setShowLocationPicker(false)
                }}
              >
                🧪 {loc.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {currentLocation && (
        <footer className="footer">
          <div className="footer-slider">
            <span className="slider-icon">⛴️</span>
            <input
              type="range"
              min="0"
              max="30"
              step="5"
              value={config.ferryPreferenceBias}
              onChange={(e) => saveConfig({ ...config, ferryPreferenceBias: parseInt(e.target.value, 10) })}
            />
            <span className="slider-icon">🚗</span>
            <span className="slider-value">
              {config.ferryPreferenceBias > 0 ? `+${config.ferryPreferenceBias}` : '0'}
            </span>
          </div>
          <div className="footer-buttons">
            <button className="refresh-button" onClick={refresh} disabled={isLoading}>
              {isLoading ? '...' : 'Refresh'}
            </button>
            <button
              className="location-button"
              onClick={() => setShowLocationPicker(true)}
            >
              📍 {usingTestLocation || 'GPS'}
            </button>
          </div>
        </footer>
      )}
    </div>
  )
}

function Recommendation({ allRoutes, ferryBias }: { allRoutes: RouteOption[]; ferryBias: number }) {
  const now = new Date()

  const formatTime = (minutes: number) => {
    if (minutes === Infinity) return '—'
    const hours = Math.floor(minutes / 60)
    const mins = minutes % 60
    if (hours > 0) {
      return `${hours}h ${mins}m`
    }
    return `${mins}m`
  }

  const formatClockTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  const getArrivalTime = (minutes: number) => {
    if (minutes === Infinity) return '—'
    return formatClockTime(new Date(now.getTime() + minutes * 60 * 1000))
  }

  // Apply ferry bias to determine effective winner
  const adjustedRoutes = allRoutes.map(r => ({
    ...r,
    adjustedTime: r.type === 'drive-around'
      ? r.totalTimeMinutes + ferryBias
      : r.totalTimeMinutes
  })).sort((a, b) => a.adjustedTime - b.adjustedTime)

  const effectiveWinner = adjustedRoutes[0]
  const secondBest = adjustedRoutes[1]

  // Check if it's a close call (within 15 minutes)
  const timeDiff = secondBest ? Math.abs(effectiveWinner.adjustedTime - secondBest.adjustedTime) : Infinity
  const isCloseCall = timeDiff <= 15 && secondBest

  // Get trade-offs for display
  const getTradeoffs = (r: RouteOption) => {
    const pros: string[] = []
    const cons: string[] = []

    if (r.type === 'drive-around') {
      pros.push('Predictable timing')
      pros.push('No waiting')
      cons.push('All driving, no break')
      cons.push('Less scenic')
    } else {
      // Ferry route
      pros.push('Scenic, can relax')
      pros.push('Break from driving')

      // Timing risk
      if (r.risks.timingRisk === 'high') {
        cons.push(`Tight timing (${r.waitTimeMinutes}min buffer)`)
      } else if (r.risks.timingRisk === 'medium') {
        cons.push(`Close timing (${r.waitTimeMinutes}min buffer)`)
      }

      // Space risk
      if (r.risks.spaceRisk === 'high') {
        cons.push(`Only ${r.spacesAvailable} spaces left`)
      } else if (r.risks.spaceRisk === 'medium') {
        cons.push(`${r.spacesAvailable} spaces available`)
      }

      if (r.risks.overall === 'low' && cons.length === 0) {
        pros.push('Good buffer time')
        pros.push('Plenty of space')
      }
    }

    return { pros, cons }
  }

  if (isCloseCall) {
    return (
      <div className="recommendation close-call">
        <div className="close-call-header">
          <span className="close-call-icon">⚖️</span>
          <h1 className="close-call-title">CLOSE CALL</h1>
          <p className="close-call-subtitle">Within {Math.round(timeDiff)} min - your choice</p>
        </div>

        <div className="close-call-options">
          {adjustedRoutes.slice(0, 2).map((r) => {
            const { pros, cons } = getTradeoffs(r)
            const riskColor = r.risks.overall === 'high' ? 'var(--accent)'
              : r.risks.overall === 'medium' ? '#f59e0b'
              : 'var(--winner-color)'

            return (
              <div key={r.name} className="close-call-option">
                <div className="option-header">
                  <span className="option-icon">{r.type === 'drive-around' ? '🚗' : '⛴️'}</span>
                  <span className="option-name">{r.name}</span>
                  <span className="option-duration">{formatTime(r.totalTimeMinutes)}</span>
                </div>
                <div className="option-times">
                  {r.type === 'ferry' && r.nextDeparture && (
                    <div className="option-row">
                      <span className="option-label">Sailing</span>
                      <span className="option-value">{formatClockTime(r.nextDeparture)}</span>
                    </div>
                  )}
                  <div className="option-row">
                    <span className="option-label">Home</span>
                    <span className="option-value">{getArrivalTime(r.totalTimeMinutes)}</span>
                  </div>
                </div>
                <div className="option-risk" style={{ color: riskColor }}>
                  {r.risks.overall === 'low' ? '✓ Low risk' : r.risks.overall === 'medium' ? '⚠ Some risk' : '⚠ Higher risk'}
                </div>
                <div className="option-tradeoffs">
                  {pros.map((p, i) => (
                    <div key={i} className="tradeoff pro">✓ {p}</div>
                  ))}
                  {cons.map((c, i) => (
                    <div key={i} className="tradeoff con">⚠ {c}</div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // Clear winner
  return (
    <div className="recommendation">
      <div className="winner clear-winner">
        <div className="winner-header">
          <span className="winner-icon">
            {effectiveWinner.type === 'drive-around' ? '🚗' : '⛴️'}
          </span>
          <h1 className="winner-name">{effectiveWinner.name}</h1>
          <span className="winner-duration">{formatTime(effectiveWinner.totalTimeMinutes)}</span>
        </div>
        <div className="winner-times">
          {effectiveWinner.type === 'ferry' && effectiveWinner.nextDeparture && (
            <div className="winner-row">
              <span className="winner-label">Sailing</span>
              <span className="winner-value">{formatClockTime(effectiveWinner.nextDeparture)}</span>
            </div>
          )}
          <div className="winner-row">
            <span className="winner-label">Home</span>
            <span className="winner-value">{getArrivalTime(effectiveWinner.totalTimeMinutes)}</span>
          </div>
        </div>
        {effectiveWinner.risks.overall !== 'low' && (
          <p className="winner-risk" style={{ color: effectiveWinner.risks.overall === 'high' ? 'var(--accent)' : '#f59e0b' }}>
            {effectiveWinner.risks.overall === 'high' ? '⚠ Higher risk' : '⚠ Some risk'}
          </p>
        )}
      </div>

      <div className="comparison">
        {allRoutes.map((r) => (
          <div
            key={r.name}
            className={`route-summary ${r.name === effectiveWinner.name ? 'winner' : ''}`}
          >
            <span className="route-name">{r.name}</span>
            <span className="route-time">{formatTime(r.totalTimeMinutes)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default App
