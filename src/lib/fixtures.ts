// Small, hand-checkable PlanInputs used by routePlan tests and the eval's
// handcrafted guardrail scenarios. Default outcome with PARAMS:
//   BAINBRIDGE 107 min (sails +40), KINGSTON 147 min (sails +95), DRIVE 150.

import type { FerryInputs, PlanInputs, RecordedVessel } from './planInputs'

export const FIXTURE_NOW = '2026-09-14T17:00:00.000Z'

export const at = (minutes: number): string =>
  new Date(Date.parse(FIXTURE_NOW) + minutes * 60_000).toISOString()

export function vessel(overrides: Partial<RecordedVessel> & { vesselName: string }): RecordedVessel {
  return {
    eta: null,
    departingTerminalId: null,
    arrivingTerminalId: null,
    scheduledDeparture: null,
    leftDock: null,
    atDock: false,
    inService: true,
    ...overrides,
  }
}

export function bainbridge(overrides: Partial<FerryInputs> = {}): FerryInputs {
  return {
    driveToTerminalMinutes: 20,
    schedule: [
      { departure: at(40), arrival: null, vesselName: 'Wenatchee' },
      { departure: at(90), arrival: null, vesselName: 'Tacoma' },
      { departure: at(140), arrival: null, vesselName: 'Wenatchee' },
    ],
    spaces: [],
    homeLegs: [
      { departAt: null, minutes: 30 },
      { departAt: at(75), minutes: 32 },
      { departAt: at(125), minutes: 34 },
      { departAt: at(175), minutes: 36 },
    ],
    ...overrides,
  }
}

export function kingston(overrides: Partial<FerryInputs> = {}): FerryInputs {
  return {
    driveToTerminalMinutes: 60,
    schedule: [
      { departure: at(45), arrival: null, vesselName: 'Puyallup' },
      { departure: at(95), arrival: null, vesselName: 'Spokane' },
      { departure: at(145), arrival: null, vesselName: 'Puyallup' },
    ],
    spaces: [],
    homeLegs: [
      { departAt: null, minutes: 20 },
      { departAt: at(75), minutes: 21 },
      { departAt: at(125), minutes: 22 },
      { departAt: at(175), minutes: 23 },
    ],
    ...overrides,
  }
}

export function planInputs(overrides: {
  bainbridge?: Partial<FerryInputs>
  kingston?: Partial<FerryInputs>
  drive?: PlanInputs['drive']
  vessels?: RecordedVessel[]
} = {}): PlanInputs {
  return {
    now: FIXTURE_NOW,
    drive: overrides.drive === undefined ? { minutes: 150, summary: 'I-5 S and WA-16 W' } : overrides.drive,
    vessels: overrides.vessels ?? [],
    ferries: {
      BAINBRIDGE: bainbridge(overrides.bainbridge),
      KINGSTON: kingston(overrides.kingston),
    },
  }
}
