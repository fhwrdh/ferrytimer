import { useState } from 'react'
import type { Config, Location } from '../types'
import { geocodeAddress } from '../api/routes'

interface SettingsProps {
  config: Config
  onSave: (config: Config) => void
  onClose: () => void
  isInitialSetup: boolean
}

export function Settings({ config, onSave, onClose, isInitialSetup }: SettingsProps) {
  const [homeAddress, setHomeAddress] = useState(config.homeAddress)
  const [wsdotApiKey, setWsdotApiKey] = useState(config.wsdotApiKey)
  const [googleMapsApiKey, setGoogleMapsApiKey] = useState(config.googleMapsApiKey)
  const [isGeocoding, setIsGeocoding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    setError(null)

    if (!homeAddress || !wsdotApiKey || !googleMapsApiKey) {
      setError('All fields are required')
      return
    }

    setIsGeocoding(true)

    try {
      // Geocode the home address if it changed or we don't have a location yet
      let homeLocation: Location | null = config.homeLocation

      if (homeAddress !== config.homeAddress || !homeLocation) {
        homeLocation = await geocodeAddress(googleMapsApiKey, homeAddress)
      }

      onSave({
        homeAddress,
        homeLocation,
        wsdotApiKey,
        googleMapsApiKey,
      })

      if (!isInitialSetup) {
        onClose()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings')
    } finally {
      setIsGeocoding(false)
    }
  }

  const canSave = homeAddress && wsdotApiKey && googleMapsApiKey && !isGeocoding

  return (
    <div className="settings">
      <header className="settings-header">
        <h1>{isInitialSetup ? 'Setup' : 'Settings'}</h1>
        {!isInitialSetup && (
          <button className="close-button" onClick={onClose}>
            ✕
          </button>
        )}
      </header>

      {error && <div className="error">{error}</div>}

      <div className="settings-form">
        <div className="form-group">
          <label htmlFor="homeAddress">Home Address</label>
          <input
            id="homeAddress"
            type="text"
            value={homeAddress}
            onChange={(e) => setHomeAddress(e.target.value)}
            placeholder="123 Main St, Poulsbo, WA"
          />
          <small>Your destination (usually home)</small>
        </div>

        <div className="form-group">
          <label htmlFor="wsdotApiKey">WSDOT API Key</label>
          <input
            id="wsdotApiKey"
            type="text"
            value={wsdotApiKey}
            onChange={(e) => setWsdotApiKey(e.target.value)}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          />
          <small>
            Get a free key at{' '}
            <a
              href="https://wsdot.wa.gov/traffic/api/"
              target="_blank"
              rel="noopener noreferrer"
            >
              wsdot.wa.gov/traffic/api
            </a>
          </small>
        </div>

        <div className="form-group">
          <label htmlFor="googleMapsApiKey">Google Maps API Key</label>
          <input
            id="googleMapsApiKey"
            type="text"
            value={googleMapsApiKey}
            onChange={(e) => setGoogleMapsApiKey(e.target.value)}
            placeholder="AIza..."
          />
          <small>
            Get a key at{' '}
            <a
              href="https://console.cloud.google.com/apis/credentials"
              target="_blank"
              rel="noopener noreferrer"
            >
              Google Cloud Console
            </a>
            . Enable Routes API and Geocoding API.
          </small>
        </div>

        <button
          className="save-button"
          onClick={handleSave}
          disabled={!canSave}
        >
          {isGeocoding ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  )
}
