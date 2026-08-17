import { useState } from 'react'
import type { Config, Location } from '../types'
import { geocodeAddress } from '../api/routes'
import { CloseIcon } from './Icons'

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
      setError('Enter the address you\'re heading to.')
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
      setError(err instanceof Error ? err.message : 'That address didn\'t resolve. Try adding the city.')
    } finally {
      setIsGeocoding(false)
    }
  }

  const canSave = homeAddress && !isGeocoding

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">{isInitialSetup ? 'Set up' : 'Settings'}</h1>
        {!isInitialSetup && (
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        )}
      </div>

      <div className="page-body">
        {isInitialSetup && (
          <p className="notice">
            Ferry Timer compares Bainbridge, Kingston, and driving around to get you home.
            It needs to know where home is.
          </p>
        )}

        {error && <div className="error">{error}</div>}

        <div className="field">
          <label htmlFor="homeAddress">Home</label>
          <input
            id="homeAddress"
            type="text"
            value={homeAddress}
            onChange={(e) => setHomeAddress(e.target.value)}
            placeholder="123 Main St, Poulsbo, WA"
          />
          <span className="hint">Where you're heading. Used for every drive estimate.</span>
        </div>

        <div className="field">
          <label htmlFor="ferryBias">
            Ferry preference {ferryBias > 0 ? `· +${ferryBias}m` : '· neutral'}
          </label>
          <input
            id="ferryBias"
            type="range"
            min="0"
            max="30"
            step="5"
            value={ferryBias}
            onChange={(e) => setFerryBias(parseInt(e.target.value, 10))}
          />
          <span className="hint">
            Extra driving you'd accept to take the boat instead. Biases the recommendation
            only — the times stay honest.
          </span>
        </div>

        <button className="primary-button" onClick={handleSave} disabled={!canSave}>
          {isGeocoding ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
