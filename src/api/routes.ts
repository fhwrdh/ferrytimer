import type { Location } from '../types'

// Use proxy in development to avoid CORS issues
const ROUTES_API_URL = import.meta.env.DEV
  ? '/api/google/routes/directions/v2:computeRoutes'
  : 'https://routes.googleapis.com/directions/v2:computeRoutes'

const GEOCODE_API_URL = import.meta.env.DEV
  ? '/api/google/geocode/json'
  : 'https://maps.googleapis.com/maps/api/geocode/json'

interface RouteResponse {
  routes: Array<{
    duration: string // e.g., "1234s"
    distanceMeters: number
    polyline: {
      encodedPolyline: string
    }
  }>
}

export async function getDriveTime(
  apiKey: string,
  origin: Location,
  destination: Location
): Promise<number> {
  const url = ROUTES_API_URL

  const body = {
    origin: {
      location: {
        latLng: {
          latitude: origin.lat,
          longitude: origin.lng,
        },
      },
    },
    destination: {
      location: {
        latLng: {
          latitude: destination.lat,
          longitude: destination.lng,
        },
      },
    },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
    computeAlternativeRoutes: false,
    languageCode: 'en-US',
    units: 'IMPERIAL',
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'routes.duration',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to get route: ${error}`)
  }

  const data: RouteResponse = await response.json()

  if (!data.routes || data.routes.length === 0) {
    throw new Error('No route found')
  }

  // Duration is returned as "1234s" - parse to seconds
  const durationStr = data.routes[0].duration
  const seconds = parseInt(durationStr.replace('s', ''), 10)

  return seconds
}

export async function getDriveTimeMinutes(
  apiKey: string,
  origin: Location,
  destination: Location
): Promise<number> {
  const seconds = await getDriveTime(apiKey, origin, destination)
  return Math.ceil(seconds / 60)
}

// Get drive time from address string (uses geocoding)
export async function geocodeAddress(
  apiKey: string,
  address: string
): Promise<Location> {
  const url = `${GEOCODE_API_URL}?address=${encodeURIComponent(address)}&key=${apiKey}`

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to geocode address: ${response.statusText}`)
  }

  const data = await response.json()

  if (data.status !== 'OK' || !data.results || data.results.length === 0) {
    throw new Error(`Could not geocode address: ${data.status}`)
  }

  const location = data.results[0].geometry.location
  return {
    lat: location.lat,
    lng: location.lng,
  }
}

// Reverse geocode - turn coordinates into a friendly address
export async function reverseGeocode(
  apiKey: string,
  location: Location
): Promise<string> {
  const url = `${GEOCODE_API_URL}?latlng=${location.lat},${location.lng}&key=${apiKey}`

  const response = await fetch(url)
  if (!response.ok) {
    return `${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}`
  }

  const data = await response.json()

  if (data.status !== 'OK' || !data.results || data.results.length === 0) {
    return `${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}`
  }

  // Try to find a neighborhood or locality name
  const result = data.results[0]

  // Look for neighborhood, sublocality, or locality in address components
  const components = result.address_components || []
  const neighborhood = components.find((c: any) =>
    c.types.includes('neighborhood') || c.types.includes('sublocality')
  )
  const locality = components.find((c: any) => c.types.includes('locality'))

  if (neighborhood) {
    return neighborhood.long_name
  }
  if (locality) {
    return locality.long_name
  }

  // Fall back to formatted address, but truncate it
  const formatted = result.formatted_address
  const parts = formatted.split(',')
  return parts.slice(0, 2).join(',').trim()
}
