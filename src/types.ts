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
}

export interface Config {
  homeAddress: string
  homeLocation: Location | null
  wsdotApiKey: string
  googleMapsApiKey: string
}
