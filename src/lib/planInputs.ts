// Everything the route algorithm needs, as plain JSON. The app builds this
// from live fetches; the sampler records it; the eval replays it. Times are
// ISO 8601 strings so a record survives JSON.stringify unchanged.

export type FerryRouteName = 'BAINBRIDGE' | 'KINGSTON'

export interface RecordedSailing {
  departure: string
  // null when WSDOT gave no arrival time (scheduletoday's ArrivingTime is
  // routinely null; see RecordedSailing consumers for how they price it).
  arrival: string | null
  vesselName: string
}

export interface RecordedSpace {
  departure: string
  driveUpSpaceCount: number
  totalSpaces: number
}

export interface RecordedVessel {
  vesselName: string
  eta: string | null
  departingTerminalId: number | null
  arrivingTerminalId: number | null
  scheduledDeparture: string | null
  leftDock: string | null
  atDock: boolean
  inService: boolean
}

// Drive from the arrival terminal to home. departAt null means it was priced
// with live traffic at `now`; otherwise it was priced for that departure time.
export interface HomeLeg {
  departAt: string | null
  minutes: number
}

export interface FerryInputs {
  driveToTerminalMinutes: number | null
  // null when the schedule couldn't be fetched
  schedule: RecordedSailing[] | null
  // empty when sailing space was unavailable
  spaces: RecordedSpace[]
  homeLegs: HomeLeg[]
}

export interface PlanInputs {
  now: string
  // Straight home without a boat; null when unavailable
  drive: { minutes: number; summary: string | null } | null
  vessels: RecordedVessel[]
  ferries: Record<FerryRouteName, FerryInputs>
}
