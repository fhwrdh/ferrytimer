// Direct Google and WSDOT clients for the sampler. The browser fetchers in
// src/api go through this app's /api proxy, which the droplet cron job can't
// use (it's same-origin only), so these attach the keys themselves and reuse
// the same WSDOT parsers.

import type { Location } from '../types'
import type { RecordedSailing, RecordedSpace, RecordedVessel } from '../lib/planInputs'
import { parseSailingSpace, parseScheduleToday, parseVesselLocations } from '../api/ferries'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface DriveResult {
  minutes: number
  summary: string | null
}

export interface DriveRequest {
  avoidFerries?: boolean
  // Omit for live traffic now; Google rejects times in the past
  departAt?: Date
}

export interface Upstream {
  drive(origin: Location, destination: Location, request?: DriveRequest): Promise<DriveResult>
  schedule(departingId: number, arrivingId: number): Promise<RecordedSailing[]>
  spaces(departingId: number, arrivingId: number): Promise<RecordedSpace[]>
  vessels(): Promise<RecordedVessel[]>
}

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes'
const WSDOT_BASE = 'https://www.wsdot.wa.gov/ferries/api'

const latLng = (location: Location) => ({
  location: { latLng: { latitude: location.lat, longitude: location.lng } },
})

export function makeUpstream(
  keys: { wsdot: string; google: string },
  fetchImpl: FetchLike = fetch
): Upstream {
  async function getJson(label: string, url: string, init?: RequestInit): Promise<unknown> {
    const response = await fetchImpl(url, init)
    if (!response.ok) {
      throw new Error(`${label} failed: ${response.status} ${await response.text()}`)
    }
    return response.json()
  }

  const wsdot = (path: string) => `${WSDOT_BASE}/${path}?apiaccesscode=${keys.wsdot}`

  return {
    async drive(origin, destination, request = {}) {
      const body = {
        origin: latLng(origin),
        destination: latLng(destination),
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
        computeAlternativeRoutes: false,
        routeModifiers: { avoidFerries: request.avoidFerries ?? false },
        departureTime: request.departAt?.toISOString(),
        languageCode: 'en-US',
        units: 'IMPERIAL',
      }
      const data = await getJson('Google Routes', ROUTES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': keys.google,
          'X-Goog-FieldMask': 'routes.duration,routes.description',
        },
        body: JSON.stringify(body),
      }) as { routes?: Array<{ duration: string; description?: string }> }

      const route = data.routes?.[0]
      if (!route) throw new Error('No route found')
      const seconds = parseInt(route.duration.replace('s', ''), 10)
      return { minutes: Math.ceil(seconds / 60), summary: route.description ?? null }
    },

    async schedule(departingId, arrivingId) {
      const data = await getJson('WSDOT schedule', wsdot(`schedule/rest/scheduletoday/${departingId}/${arrivingId}/true`))
      return parseScheduleToday(data as Parameters<typeof parseScheduleToday>[0]).map(s => ({
        departure: s.departureTime.toISOString(),
        arrival: s.arrivalTime.toISOString(),
        vesselName: s.vesselName,
      }))
    },

    async spaces(departingId, arrivingId) {
      const data = await getJson('WSDOT sailing space', wsdot(`terminals/rest/terminalsailingspace/${departingId}`))
      return parseSailingSpace(data as Parameters<typeof parseSailingSpace>[0], arrivingId).map(s => ({
        departure: s.departureTime.toISOString(),
        driveUpSpaceCount: s.driveUpSpaceCount,
        totalSpaces: s.totalSpaces,
      }))
    },

    async vessels() {
      const data = await getJson('WSDOT vessels', wsdot('vessels/rest/vessellocations'))
      return parseVesselLocations(data).map(v => ({
        vesselName: v.vesselName,
        eta: v.eta ? v.eta.toISOString() : null,
      }))
    },
  }
}
