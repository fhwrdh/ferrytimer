import type { Location } from '../types'

// Simple API endpoints - serverless functions handle CORS and API keys
const ROUTES_API_URL = '/api/routes'
const GEOCODE_API_URL = '/api/geocode'

interface RouteResponse {
  routes: Array<{
    duration: string // e.g., "1234s"
    // Google's summary of the roads taken, e.g. "I-5 S and WA-16 W"
    description?: string
  }>
}

export interface DriveRoute {
  seconds: number
  // null when Google didn't summarize the roads for this route
  summary: string | null
}

export interface DriveOptions {
  // Keep the route on pavement. Google's driving directions happily route
  // through a WSF sailing otherwise, which would double-count the boat.
  avoidFerries?: boolean
}

export async function getDriveRoute(
  origin: Location,
  destination: Location,
  options: DriveOptions = {}
): Promise<DriveRoute> {
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
    routeModifiers: {
      avoidFerries: options.avoidFerries ?? false,
    },
    languageCode: 'en-US',
    units: 'IMPERIAL',
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-FieldMask': 'routes.duration,routes.description',
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
  const route = data.routes[0]
  const seconds = parseInt(route.duration.replace('s', ''), 10)

  return { seconds, summary: route.description ?? null }
}

export async function getDriveTimeMinutes(
  origin: Location,
  destination: Location,
  options: DriveOptions = {}
): Promise<number> {
  const { seconds } = await getDriveRoute(origin, destination, options)
  return Math.ceil(seconds / 60)
}

export async function getDriveMinutesAndSummary(
  origin: Location,
  destination: Location,
  options: DriveOptions = {}
): Promise<{ minutes: number; summary: string | null }> {
  const { seconds, summary } = await getDriveRoute(origin, destination, options)
  return { minutes: Math.ceil(seconds / 60), summary }
}

export interface GeocodeResult {
  location: Location
  // The formatted address Google matched, for showing back to the user
  formattedAddress: string
  // True when the match is a city, zip, or county rather than a building.
  // Those land on a centroid that can sit miles from the actual door.
  isApproximate: boolean
}

// Result types that mean "somewhere in this area", not "this address"
const AREA_LEVEL_TYPES = [
  'locality',
  'sublocality',
  'neighborhood',
  'postal_code',
  'administrative_area_level_1',
  'administrative_area_level_2',
  'administrative_area_level_3',
  'country',
]

// Get drive time from address string (uses geocoding)
export async function geocodeAddress(address: string): Promise<GeocodeResult> {
  const url = `${GEOCODE_API_URL}?address=${encodeURIComponent(address)}`

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to geocode address: ${response.statusText}`)
  }

  const data = await response.json()

  if (data.status !== 'OK' || !data.results || data.results.length === 0) {
    throw new Error(`Could not geocode address: ${data.status}`)
  }

  const result = data.results[0]
  const location = result.geometry.location
  const types: string[] = result.types || []

  return {
    location: {
      lat: location.lat,
      lng: location.lng,
    },
    formattedAddress: result.formatted_address ?? address,
    isApproximate:
      result.geometry.location_type === 'APPROXIMATE' ||
      types.some((t) => AREA_LEVEL_TYPES.includes(t)),
  }
}

// Reverse geocode - turn coordinates into a friendly address
export async function reverseGeocode(location: Location): Promise<string> {
  const url = `${GEOCODE_API_URL}?latlng=${location.lat},${location.lng}`

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
