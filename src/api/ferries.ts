import type { SailingSpace, VesselLocation } from '../types'

// Terminal IDs for our routes
export const TERMINALS = {
  SEATTLE: 7,      // Colman Dock
  BAINBRIDGE: 3,
  EDMONDS: 8,
  KINGSTON: 12,
} as const

// Route IDs
export const ROUTES = {
  SEATTLE_BAINBRIDGE: 15,  // Sea/BI
  EDMONDS_KINGSTON: 6,     // Edm/King
} as const

// Terminal locations (for distance calculations)
export const TERMINAL_LOCATIONS = {
  [TERMINALS.SEATTLE]: { lat: 47.6023, lng: -122.3384 },
  [TERMINALS.BAINBRIDGE]: { lat: 47.6227, lng: -122.5109 },
  [TERMINALS.EDMONDS]: { lat: 47.8137, lng: -122.3835 },
  [TERMINALS.KINGSTON]: { lat: 47.7967, lng: -122.4943 },
} as const

// Ferry crossing times in minutes (approximate). Used to price the home leg
// for sailings WSDOT gives no arrival time for.
export const CROSSING_TIMES = {
  SEATTLE_BAINBRIDGE: 35,
  EDMONDS_KINGSTON: 30,
} as const

// Parse .NET JSON date format: /Date(1234567890000-0800)/
export function parseWsdotDate(dateStr: string): Date {
  const match = dateStr.match(/\/Date\((\d+)([+-]\d{4})?\)\//)
  if (!match) {
    console.warn('Could not parse date:', dateStr)
    return new Date(dateStr)
  }
  return new Date(parseInt(match[1], 10))
}

export interface TerminalSailingSpaceResponse {
  TerminalID: number
  TerminalName: string
  DepartingSpaces: Array<{
    Departure: string
    IsCancelled: boolean
    VesselID: number
    VesselName: string
    SpaceForArrivalTerminals: Array<{
      TerminalID: number
      TerminalName: string
      DriveUpSpaceCount: number
      MaxSpaceCount: number
    }>
  }>
}

export interface VesselLocationResponse {
  VesselID: number
  VesselName: string
  Latitude: number
  Longitude: number
  Speed: number
  Heading: number
  InService: boolean
  LeftDock: string | null
  Eta: string | null
  EtaToScheduledDepartingTerminal: string | null
  DepartingTerminalID: number | null
  ArrivingTerminalID: number | null
  ScheduledDeparture: string | null
  AtDock: boolean
}

export function parseSailingSpace(
  data: TerminalSailingSpaceResponse,
  arrivalTerminalId?: number
): SailingSpace[] {
  if (!data?.DepartingSpaces) {
    console.warn('No DepartingSpaces in response:', data)
    return []
  }

  return data.DepartingSpaces
    .filter(s => !s.IsCancelled)
    .flatMap(sailing => {
      // Colman Dock also sails to Bremerton, so a caller that knows its
      // arrival terminal filters to it. The app still takes the first entry.
      const spaces = arrivalTerminalId === undefined
        ? sailing.SpaceForArrivalTerminals?.[0]
        : sailing.SpaceForArrivalTerminals?.find(t => t.TerminalID === arrivalTerminalId)
      if (arrivalTerminalId !== undefined && !spaces) return []
      return [{
        departureTime: parseWsdotDate(sailing.Departure),
        driveUpSpaceCount: spaces?.DriveUpSpaceCount ?? 0,
        reservationSpaceCount: 0, // Not provided in this endpoint
        totalSpaces: spaces?.MaxSpaceCount ?? 0,
        estimatedWait: null,
      }]
    })
}

export function parseVesselLocations(data: unknown): VesselLocation[] {
  if (!Array.isArray(data)) {
    console.warn('Vessel locations response is not an array:', data)
    return []
  }

  return (data as VesselLocationResponse[]).map(vessel => ({
    vesselId: vessel.VesselID,
    vesselName: vessel.VesselName,
    latitude: vessel.Latitude,
    longitude: vessel.Longitude,
    speed: vessel.Speed,
    heading: vessel.Heading,
    inService: vessel.InService,
    // Eta arrives as /Date(ms-0700)/ like every other WSDOT timestamp.
    // new Date() on that string is Invalid Date, which silently disabled
    // the delay adjustment.
    eta: vessel.Eta ? parseWsdotDate(vessel.Eta) : null,
    departingTerminalId: vessel.DepartingTerminalID ?? null,
    arrivingTerminalId: vessel.ArrivingTerminalID ?? null,
    scheduledDeparture: vessel.ScheduledDeparture ? parseWsdotDate(vessel.ScheduledDeparture) : null,
    leftDock: vessel.LeftDock ? parseWsdotDate(vessel.LeftDock) : null,
    atDock: vessel.AtDock ?? false,
  }))
}

export function parseScheduleToday(
  data: ScheduleTodayResponse
): Array<{ departureTime: Date; arrivalTime: Date; vesselName: string }> {
  const combo = data.TerminalCombos?.[0]
  if (!combo?.Times) {
    console.warn('No Times in schedule response:', data)
    return []
  }

  return combo.Times.map(time => ({
    departureTime: parseWsdotDate(time.DepartingTime),
    arrivalTime: time.ArrivingTime ? parseWsdotDate(time.ArrivingTime) : parseWsdotDate(time.DepartingTime),
    vesselName: time.VesselName,
  }))
}

export async function getTerminalSailingSpace(
  terminalId: number
): Promise<SailingSpace[]> {
  const url = `/api/wsdot-sailingspace?terminalId=${terminalId}`

  try {
    const response = await fetch(url)
    if (!response.ok) {
      // Sailing space data is optional - don't fail if unavailable
      console.warn(`Sailing space unavailable for terminal ${terminalId}: ${response.status}`)
      return []
    }

    const data: TerminalSailingSpaceResponse = await response.json()
    return parseSailingSpace(data)
  } catch (err) {
    // Network or parsing errors - sailing space is optional
    console.warn(`Failed to fetch sailing space for terminal ${terminalId}:`, err)
    return []
  }
}

export async function getVesselLocations(): Promise<VesselLocation[]> {
  const url = `/api/wsdot-vessels`

  let data: unknown
  try {
    const response = await fetch(url)
    if (!response.ok) {
      // Vessel positions only refine the schedule - don't fail without them
      console.warn(`Vessel locations unavailable: ${response.status}`)
      return []
    }
    data = await response.json()
  } catch (err) {
    console.warn('Failed to fetch vessel locations:', err)
    return []
  }

  return parseVesselLocations(data)
}

export interface ScheduleTodayResponse {
  ScheduleID: number
  TerminalCombos: Array<{
    DepartingTerminalID: number
    DepartingTerminalName: string
    ArrivingTerminalID: number
    ArrivingTerminalName: string
    Times: Array<{
      DepartingTime: string
      ArrivingTime: string | null
      VesselID: number
      VesselName: string
    }>
  }>
}

export async function getScheduleToday(
  departingTerminalId: number,
  arrivingTerminalId: number,
  onlyRemaining: boolean = true
): Promise<Array<{ departureTime: Date; arrivalTime: Date; vesselName: string }>> {
  const url = `/api/wsdot-schedule?departingId=${departingTerminalId}&arrivingId=${arrivingTerminalId}&onlyRemaining=${onlyRemaining}`

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch schedule: ${response.statusText}`)
  }

  const data: ScheduleTodayResponse = await response.json()
  return parseScheduleToday(data)
}
