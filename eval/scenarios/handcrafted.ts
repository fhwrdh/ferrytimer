// Guardrail scenarios: they pin the algorithm's RULES (roll past full boats,
// fallback close calls, which ETAs count). They run with parameters frozen
// here, so tuning PARAMS in routePlan.ts can't break them, but changing the
// logic can. The tuning agent must not edit this file.

import type { PlanInputs } from '../../src/lib/planInputs'
import type { RouteParams } from '../../src/lib/routePlan'
import { at, planInputs, vessel } from '../../src/lib/fixtures'
import type { HandcraftedExpect } from '../score'

export const HANDCRAFTED_PARAMS: RouteParams = {
  vesselLoadingMinutes: 15,
  boardingBufferMinutes: 10,
  nearlyFullThreshold: 10,
  closeCallMinutes: 15,
  homeLegMatchMinutes: 20,
  crossingMinutes: { BAINBRIDGE: 35, KINGSTON: 30 },
}

export interface HandcraftedScenario {
  name: string
  inputs: PlanInputs
  bias?: number
  expect: HandcraftedExpect
}

export const HANDCRAFTED: HandcraftedScenario[] = [
  {
    name: 'full next boat rolls forward to the following sailing',
    inputs: planInputs({
      kingston: { spaces: [{ departure: at(95), driveUpSpaceCount: 0, totalSpaces: 200 }] },
    }),
    expect: {
      winner: 'BAINBRIDGE',
      isCloseCall: false,
      routes: { KINGSTON: { departure: at(145), arrivalAt: at(198) } },
    },
  },
  {
    name: 'nearly full boat keeps the headline but makes it a close call',
    inputs: planInputs({
      bainbridge: { spaces: [{ departure: at(40), driveUpSpaceCount: 5, totalSpaces: 200 }] },
    }),
    expect: {
      winner: 'BAINBRIDGE',
      isCloseCall: true,
      routes: { BAINBRIDGE: { departure: at(40), fallbackDeparture: at(90), arrivalAt: at(107) } },
    },
  },
  {
    name: 'late vessel heading to the departing terminal delays the sailing',
    inputs: planInputs({
      vessels: [vessel({ vesselName: 'Wenatchee', eta: at(40), arrivingTerminalId: 7 })],
    }),
    expect: {
      winner: 'BAINBRIDGE',
      isCloseCall: false,
      routes: { BAINBRIDGE: { departure: at(55), arrivalAt: at(122) } },
    },
  },
  {
    name: 'ETA toward a different terminal is ignored',
    inputs: planInputs({
      vessels: [vessel({ vesselName: 'Wenatchee', eta: at(40), arrivingTerminalId: 3 })],
    }),
    expect: {
      winner: 'BAINBRIDGE',
      isCloseCall: false,
      routes: { BAINBRIDGE: { departure: at(40), arrivalAt: at(107) } },
    },
  },
]
