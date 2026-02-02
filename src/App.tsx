import { useState, useEffect } from 'react'
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

  // Load config from localStorage, with env var fallbacks for development
  const [config, setConfig] = useState(() => {
    const saved = localStorage.getItem('ferrytimer-config')
    if (saved) {
      const parsed = JSON.parse(saved)
      // Use env vars as fallbacks if localStorage values are empty
      return {
        homeAddress: parsed.homeAddress || import.meta.env.VITE_HOME_ADDRESS || '',
        homeLocation: parsed.homeLocation,
        wsdotApiKey: parsed.wsdotApiKey || import.meta.env.VITE_WSDOT_API_KEY || '',
        googleMapsApiKey: parsed.googleMapsApiKey || import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '',
      }
    }
    // No saved config - use env vars if available
    return {
      homeAddress: import.meta.env.VITE_HOME_ADDRESS || '',
      homeLocation: null,
      wsdotApiKey: import.meta.env.VITE_WSDOT_API_KEY || '',
      googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '',
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
        setCurrentLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        })
        setLocationError(null)
      },
      (error) => {
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

    if (!config.googleMapsApiKey) {
      return
    }

    reverseGeocode(config.googleMapsApiKey, currentLocation)
      .then(name => setFriendlyLocationName(name))
      .catch(() => setFriendlyLocationName(null))
  }, [currentLocation, usingTestLocation, config.googleMapsApiKey])

  const { routes, bestRoute, isLoading, error, refresh } = useRouteCalculation({
    currentLocation,
    homeLocation: config.homeLocation,
    wsdotApiKey: config.wsdotApiKey,
    googleMapsApiKey: config.googleMapsApiKey,
  })

  const saveConfig = (newConfig: typeof config) => {
    setConfig(newConfig)
    localStorage.setItem('ferrytimer-config', JSON.stringify(newConfig))
  }

  const setTestLocation = (name: string, location: Location) => {
    setCurrentLocation(location)
    setUsingTestLocation(name)
    setLocationError(null)
  }

  const clearTestLocation = () => {
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
  const needsSetup = !config.homeLocation || !config.wsdotApiKey || !config.googleMapsApiKey

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

  if (showDetails && routes.length > 0) {
    return (
      <RouteDetails
        routes={routes}
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
          <Recommendation route={bestRoute} allRoutes={routes} />
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

      {!isLoading && routes.length > 0 && (
        <footer className="footer">
          <button className="refresh-button" onClick={refresh}>
            Refresh
          </button>
          <button
            className="location-button"
            onClick={() => setShowLocationPicker(true)}
          >
            📍 {usingTestLocation || 'GPS'}
          </button>
        </footer>
      )}
    </div>
  )
}

function Recommendation({ route, allRoutes }: { route: RouteOption; allRoutes: RouteOption[] }) {
  const formatTime = (minutes: number) => {
    if (minutes === Infinity) return '—'
    const hours = Math.floor(minutes / 60)
    const mins = minutes % 60
    if (hours > 0) {
      return `${hours}h ${mins}m`
    }
    return `${mins}m`
  }

  const getRouteColor = (r: RouteOption) => {
    if (r.name === route.name) return 'var(--winner-color)'
    return 'var(--text-muted)'
  }

  // Is the winner significantly better? (more than 10 minutes)
  const secondBest = allRoutes[1]
  const isClearWinner = secondBest && route.totalTimeMinutes < secondBest.totalTimeMinutes - 10

  return (
    <div className="recommendation">
      <div className={`winner ${isClearWinner ? 'clear-winner' : ''}`}>
        <span className="winner-label">
          {route.type === 'drive-around' ? '🚗' : '⛴️'}
        </span>
        <h1 className="winner-name">{route.name}</h1>
        <p className="winner-time">{formatTime(route.totalTimeMinutes)}</p>
      </div>

      <div className="comparison">
        {allRoutes.map((r) => (
          <div
            key={r.name}
            className={`route-summary ${r.name === route.name ? 'winner' : ''}`}
            style={{ color: getRouteColor(r) }}
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
