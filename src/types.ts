export interface Location {
  lat: number
  lng: number
}

export interface Terminal {
  id: number
  name: string
  location: Location
}

export interface FerryRoute {
  name: string
  departureTerminal: Terminal
  arrivalTerminal: Terminal
  driveTimeFromArrivalToHome: number | null // cached, in seconds
}

export interface SailingSpace {
  departureTime: Date
  driveUpSpaceCount: number
  reservationSpaceCount: number
  totalSpaces: number
  estimatedWait: number | null
}

export interface VesselLocation {
  vesselId: number
  vesselName: string
  latitude: number
  longitude: number
  speed: number
  heading: number
  inService: boolean
  eta: Date | null
}

export type RiskLevel = 'low' | 'medium' | 'high'

export interface RouteRisks {
  timingRisk: RiskLevel | null      // How tight is the timing to catch ferry?
  spaceRisk: RiskLevel | null       // How likely to get a spot?
  overall: RiskLevel
}

export interface RouteOption {
  name: string
  type: 'ferry' | 'drive-around'
  totalTimeMinutes: number
  driveToTerminalMinutes: number | null
  waitTimeMinutes: number | null
  ferryTimeMinutes: number | null
  driveFromTerminalMinutes: number | null
  nextDeparture: Date | null
  spacesAvailable: number | null
  canMakeNextFerry: boolean | null
  missedSailings: Date[] // Sailings that depart before you can arrive
  risks: RouteRisks
}

export interface Config {
  homeAddress: string
  homeLocation: Location | null
  ferryPreferenceBias: number // Minutes to add to drive-around (0 = neutral, 15 = prefer ferry)
}

// Close call threshold in minutes
export const CLOSE_CALL_THRESHOLD = 15
