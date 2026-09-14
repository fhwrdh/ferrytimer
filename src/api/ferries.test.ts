import { describe, it, expect } from 'vitest'
import {
  parseWsdotDate,
  parseScheduleToday,
  parseSailingSpace,
  parseVesselLocations,
} from './ferries'

const T1 = 1789407360000
const T2 = 1789409460000

describe('parseWsdotDate', () => {
  it('reads .NET date strings as epoch milliseconds', () => {
    expect(parseWsdotDate(`/Date(${T1}-0700)/`).getTime()).toBe(T1)
  })
})

describe('parseVesselLocations', () => {
  const vessel = {
    VesselID: 1,
    VesselName: 'Yakima',
    Latitude: 47.6,
    Longitude: -122.4,
    Speed: 14,
    Heading: 270,
    InService: true,
    LeftDock: `/Date(${T1}-0700)/`,
    Eta: `/Date(${T2}-0700)/`,
    EtaToScheduledDepartingTerminal: null,
  }

  it('parses Eta from the WSDOT .NET date format', () => {
    const [parsed] = parseVesselLocations([vessel])
    expect(parsed.eta?.getTime()).toBe(T2)
  })

  it('keeps a null Eta as null', () => {
    const [parsed] = parseVesselLocations([{ ...vessel, Eta: null }])
    expect(parsed.eta).toBeNull()
  })

  it('returns an empty list when the response is not an array', () => {
    expect(parseVesselLocations({ Message: 'error' })).toEqual([])
  })
})

describe('parseScheduleToday', () => {
  it('maps departure, arrival and vessel', () => {
    const result = parseScheduleToday({
      ScheduleID: 1,
      TerminalCombos: [{
        DepartingTerminalID: 7,
        DepartingTerminalName: 'Seattle',
        ArrivingTerminalID: 3,
        ArrivingTerminalName: 'Bainbridge Island',
        Times: [{ DepartingTime: `/Date(${T1}-0700)/`, ArrivingTime: `/Date(${T2}-0700)/`, VesselID: 1, VesselName: 'Wenatchee' }],
      }],
    })
    expect(result).toEqual([{ departureTime: new Date(T1), arrivalTime: new Date(T2), vesselName: 'Wenatchee' }])
  })

  it('uses departure as arrival when ArrivingTime is null', () => {
    const result = parseScheduleToday({
      ScheduleID: 1,
      TerminalCombos: [{
        DepartingTerminalID: 7,
        DepartingTerminalName: 'Seattle',
        ArrivingTerminalID: 3,
        ArrivingTerminalName: 'Bainbridge Island',
        Times: [{ DepartingTime: `/Date(${T1}-0700)/`, ArrivingTime: null, VesselID: 1, VesselName: 'Wenatchee' }],
      }],
    })
    expect(result[0].arrivalTime).toEqual(new Date(T1))
  })

  it('returns an empty list without Times', () => {
    expect(parseScheduleToday({ ScheduleID: 1, TerminalCombos: [] })).toEqual([])
  })
})

describe('parseSailingSpace', () => {
  const response = {
    TerminalID: 7,
    TerminalName: 'Seattle',
    DepartingSpaces: [
      {
        Departure: `/Date(${T1}-0700)/`,
        IsCancelled: false,
        VesselID: 1,
        VesselName: 'Kaleetan',
        SpaceForArrivalTerminals: [{ TerminalID: 4, TerminalName: 'Bremerton', DriveUpSpaceCount: 90, MaxSpaceCount: 144 }],
      },
      {
        Departure: `/Date(${T2}-0700)/`,
        IsCancelled: false,
        VesselID: 2,
        VesselName: 'Wenatchee',
        SpaceForArrivalTerminals: [{ TerminalID: 3, TerminalName: 'Bainbridge Island', DriveUpSpaceCount: 8, MaxSpaceCount: 202 }],
      },
      {
        Departure: `/Date(${T2}-0700)/`,
        IsCancelled: true,
        VesselID: 3,
        VesselName: 'Tacoma',
        SpaceForArrivalTerminals: [{ TerminalID: 3, TerminalName: 'Bainbridge Island', DriveUpSpaceCount: 0, MaxSpaceCount: 202 }],
      },
    ],
  }

  it('without an arrival terminal, keeps every non-cancelled sailing (app behavior)', () => {
    expect(parseSailingSpace(response).map(s => s.driveUpSpaceCount)).toEqual([90, 8])
  })

  it('with an arrival terminal, keeps only sailings to that terminal', () => {
    const result = parseSailingSpace(response, 3)
    expect(result).toEqual([{
      departureTime: new Date(T2),
      driveUpSpaceCount: 8,
      reservationSpaceCount: 0,
      totalSpaces: 202,
      estimatedWait: null,
    }])
  })

  it('returns an empty list without DepartingSpaces', () => {
    expect(parseSailingSpace({ TerminalID: 7, TerminalName: 'Seattle', DepartingSpaces: undefined as never })).toEqual([])
  })
})
