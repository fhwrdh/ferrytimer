import { describe, it, expect } from 'vitest'
import { makeUpstream, type FetchLike } from './upstream'

interface Call { url: string; init?: RequestInit }

function fakeFetch(body: unknown, status = 200): FetchLike & { calls: Call[] } {
  const calls: Call[] = []
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status })
  }) as FetchLike & { calls: Call[] }
  impl.calls = calls
  return impl
}

const keys = { wsdot: 'wsdot-key', google: 'google-key' }
const A = { lat: 47.6, lng: -122.3 }
const B = { lat: 47.7, lng: -122.6 }

describe('drive', () => {
  it('posts a traffic-aware route with the key and rounds seconds up to minutes', async () => {
    const fetch = fakeFetch({ routes: [{ duration: '1805s', description: 'WA-104 W' }] })
    const result = await makeUpstream(keys, fetch).drive(A, B)

    expect(result).toEqual({ minutes: 31, summary: 'WA-104 W' })
    const { url, init } = fetch.calls[0]
    expect(url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes')
    const headers = init?.headers as Record<string, string>
    expect(headers['X-Goog-Api-Key']).toBe('google-key')
    const body = JSON.parse(init?.body as string)
    expect(body.routingPreference).toBe('TRAFFIC_AWARE')
    expect(body.routeModifiers).toEqual({ avoidFerries: false })
    expect(body.departureTime).toBeUndefined()
  })

  it('sends departureTime and avoidFerries when asked', async () => {
    const fetch = fakeFetch({ routes: [{ duration: '600s' }] })
    await makeUpstream(keys, fetch).drive(A, B, {
      avoidFerries: true,
      departAt: new Date('2026-09-14T19:00:00.000Z'),
    })
    const body = JSON.parse(fetch.calls[0].init?.body as string)
    expect(body.departureTime).toBe('2026-09-14T19:00:00.000Z')
    expect(body.routeModifiers).toEqual({ avoidFerries: true })
  })

  it('throws on an HTTP error', async () => {
    await expect(makeUpstream(keys, fakeFetch({ error: 'quota' }, 429)).drive(A, B)).rejects.toThrow('429')
  })

  it('throws when no route comes back', async () => {
    await expect(makeUpstream(keys, fakeFetch({})).drive(A, B)).rejects.toThrow('No route')
  })
})

describe('WSDOT', () => {
  it('fetches the remaining schedule and records ISO times', async () => {
    const fetch = fakeFetch({
      ScheduleID: 1,
      TerminalCombos: [{
        DepartingTerminalID: 7, DepartingTerminalName: 'Seattle', ArrivingTerminalID: 3, ArrivingTerminalName: 'Bainbridge Island',
        Times: [{ DepartingTime: '/Date(1789407360000-0700)/', ArrivingTime: '/Date(1789409460000-0700)/', VesselID: 1, VesselName: 'Wenatchee' }],
      }],
    })
    const result = await makeUpstream(keys, fetch).schedule(7, 3)
    expect(fetch.calls[0].url).toBe('https://www.wsdot.wa.gov/ferries/api/schedule/rest/scheduletoday/7/3/true?apiaccesscode=wsdot-key')
    expect(result).toEqual([{
      departure: new Date(1789407360000).toISOString(),
      arrival: new Date(1789409460000).toISOString(),
      vesselName: 'Wenatchee',
    }])
  })

  it('records sailing space only for the arrival terminal', async () => {
    const fetch = fakeFetch({
      TerminalID: 7, TerminalName: 'Seattle',
      DepartingSpaces: [
        { Departure: '/Date(1789407360000-0700)/', IsCancelled: false, VesselID: 1, VesselName: 'Kaleetan', SpaceForArrivalTerminals: [{ TerminalID: 4, TerminalName: 'Bremerton', DriveUpSpaceCount: 90, MaxSpaceCount: 144 }] },
        { Departure: '/Date(1789409460000-0700)/', IsCancelled: false, VesselID: 2, VesselName: 'Wenatchee', SpaceForArrivalTerminals: [{ TerminalID: 3, TerminalName: 'Bainbridge Island', DriveUpSpaceCount: 8, MaxSpaceCount: 202 }] },
      ],
    })
    const result = await makeUpstream(keys, fetch).spaces(7, 3)
    expect(fetch.calls[0].url).toBe('https://www.wsdot.wa.gov/ferries/api/terminals/rest/terminalsailingspace/7?apiaccesscode=wsdot-key')
    expect(result).toEqual([{ departure: new Date(1789409460000).toISOString(), driveUpSpaceCount: 8, totalSpaces: 202 }])
  })

  it('records vessel ETAs as ISO strings', async () => {
    const fetch = fakeFetch([{
      VesselID: 1, VesselName: 'Yakima', Latitude: 0, Longitude: 0, Speed: 0, Heading: 0, InService: true,
      LeftDock: null, Eta: '/Date(1789407360000-0700)/', EtaToScheduledDepartingTerminal: null,
    }])
    const result = await makeUpstream(keys, fetch).vessels()
    expect(result).toEqual([{ vesselName: 'Yakima', eta: new Date(1789407360000).toISOString() }])
  })

  it('throws on an HTTP error', async () => {
    await expect(makeUpstream(keys, fakeFetch({}, 500)).vessels()).rejects.toThrow('500')
  })
})
