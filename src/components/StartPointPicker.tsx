import { useEffect, useState } from 'react'
import type { Location, StartPoint } from '../types'
import { geocodeAddress } from '../api/routes'

interface StartPointPickerProps {
  startPoint: StartPoint | null
  // Dev-only shortcuts, empty in production builds
  testLocations: { name: string; location: Location }[]
  onPick: (start: StartPoint | null) => void
  onClose: () => void
}

// "123 Main St, Poulsbo, WA 98370, USA" -> "123 Main St, Poulsbo"
function shortLabel(formattedAddress: string): string {
  return formattedAddress.split(',').slice(0, 2).join(',').trim()
}

export function StartPointPicker({
  startPoint,
  testLocations,
  onPick,
  onClose,
}: StartPointPickerProps) {
  const [address, setAddress] = useState('')
  const [isGeocoding, setIsGeocoding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const pickAddress = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!address.trim() || isGeocoding) return

    setError(null)
    setIsGeocoding(true)

    try {
      const geocoded = await geocodeAddress(address)
      onPick({ label: shortLabel(geocoded.formattedAddress), location: geocoded.location })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That address didn\'t resolve.')
    } finally {
      setIsGeocoding(false)
    }
  }

  return (
    <div className="picker-overlay" onClick={onClose}>
      <div className="picker" onClick={(e) => e.stopPropagation()}>
        <p className="picker-title">Starting point</p>

        <form className="picker-form" onSubmit={pickAddress}>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Anywhere — street, city"
            aria-label="Start from an address"
            autoFocus
          />
          <button type="submit" className="quiet-button" disabled={!address.trim() || isGeocoding}>
            {isGeocoding ? 'Finding…' : 'Start here'}
          </button>
        </form>

        {error && <div className="error">{error}</div>}

        <button
          className={`picker-option ${!startPoint ? 'is-active' : ''}`}
          onClick={() => onPick(null)}
        >
          Use my location
        </button>

        {testLocations.map((loc) => (
          <button
            key={loc.name}
            className={`picker-option ${startPoint?.label === loc.name ? 'is-active' : ''}`}
            onClick={() => onPick({ label: loc.name, location: loc.location })}
          >
            {loc.name}
          </button>
        ))}
      </div>
    </div>
  )
}
