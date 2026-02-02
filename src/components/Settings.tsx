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
  const [ferryBias, setFerryBias] = useState(config.ferryPreferenceBias)
  const [isGeocoding, setIsGeocoding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    setError(null)

    if (!homeAddress) {
      setError('Home address is required')
      return
    }

    setIsGeocoding(true)

    try {
      // Geocode the home address if it changed or we don't have a location yet
      let homeLocation: Location | null = config.homeLocation

      if (homeAddress !== config.homeAddress || !homeLocation) {
        homeLocation = await geocodeAddress(homeAddress)
      }

      onSave({
        homeAddress,
        homeLocation,
        ferryPreferenceBias: ferryBias,
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

  const canSave = homeAddress && !isGeocoding

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
          <label htmlFor="ferryBias">Ferry Preference: {ferryBias > 0 ? `+${ferryBias}min` : 'Neutral'}</label>
          <input
            id="ferryBias"
            type="range"
            min="0"
            max="30"
            step="5"
            value={ferryBias}
            onChange={(e) => setFerryBias(parseInt(e.target.value, 10))}
          />
          <small>
            Adds minutes to drive-around when comparing. Higher = prefer ferry even if slower.
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
