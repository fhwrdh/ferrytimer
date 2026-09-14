# Plan 2: Route Plan v1, Eval Harness, Agent Loop, App Switch

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the v1 route algorithm, an eval harness that scores v1 against v0 on resolved real samples, a Claude Code skill that runs the tuning loop, and switch the app to v1 once it has been checked.

**Architecture:** `src/lib/routePlan.ts` is a pure function over `PlanInputs`, tested with shared fixtures. `eval/resolver.ts` (pure) turns recorded samples plus WSDOT vessel history into observed arrivals; `eval/score.ts` (pure) compares predictions to outcomes; `eval/run.ts` prints the scorecard and enforces gates against `eval/baseline.json`. Handcrafted guardrail scenarios run with frozen parameters so they guard logic, not tuned numbers. The hook gains a second fetch stage that prices the drive home at each chosen sailing's arrival.

**Tech Stack:** TypeScript, vitest 5, tsx (new dev dependency), Node 26 locally, WSDOT REST API, React 18.

**Spec:** `docs/superpowers/specs/2026-09-14-route-plan-eval-harness-design.md` (revision 2b304e8)

## Global Constraints

- No LLM calls in app, sampler, resolver, or eval code.
- `src/lib/routePlan.v0.ts` must not change.
- The resolver makes no Google calls. WSDOT only.
- Samples without `schemaVersion >= 2` are excluded from resolution and scoring.
- Default tunable parameters: `vesselLoadingMinutes` 15, `boardingBufferMinutes` 10, `nearlyFullThreshold` 10, `closeCallMinutes` 15, `homeLegMatchMinutes` 20, crossing minutes BAINBRIDGE 35, KINGSTON 30.
- Holdout = FNV-1a 32-bit hash of `sampleId` mod 5 === 0.
- Gates: any handcrafted failure; holdout overall mean absolute error worse than baseline by more than 2 minutes; holdout winner agreement rate lower than baseline.
- Eval data lives in gitignored `eval/data/`.
- The app deploy (Task 7) happens only after: all tests pass, `npm run eval` exits 0 against a baseline, a real browser check passes, and the user approves.
- Droplet host `fhwrdh@159.223.202.42`; never root.
- Commit messages end with exactly:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01TpNTLAPaGY8E3AoB3NZVyG
  ```

## File Map

| File | Status | Responsibility |
|---|---|---|
| `src/lib/fixtures.ts` | create | Shared PlanInputs builders for tests and guardrails |
| `src/lib/routePlan.ts` | create | v1 algorithm, `PARAMS`, `selectHomeLegTimes` |
| `src/lib/routePlan.test.ts` | create | v1 rule tests |
| `eval/score.ts` | create | Predictions, metrics, holdout split, gates, handcrafted checks |
| `eval/score.test.ts` | create | Scoring tests |
| `eval/scenarios/handcrafted.ts` | create | Guardrail scenarios + frozen params |
| `eval/resolver.ts` | create | Pure resolution of samples into outcomes |
| `eval/resolver.test.ts` | create | Resolver tests |
| `eval/resolve.ts` | create | CLI: fetch vessel history, write outcomes |
| `eval/fetchSamples.ts` | create | CLI: copy samples from droplet |
| `eval/run.ts` | create | CLI: scorecard, baseline, gates |
| `.claude/skills/tune-route-plan/SKILL.md` | create | Agent tuning loop |
| `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` | modify | tsx, scripts, include eval, commit skills |
| `src/api/routes.ts` | modify | `departAt` drive option |
| `src/hooks/useRouteCalculation.ts` | modify | Stage 2 fetch, call v1 |

---

### Task 1: Fixtures and v1 algorithm

**Files:**
- Create: `src/lib/fixtures.ts`, `src/lib/routePlan.ts`, `src/lib/routePlan.test.ts`

**Interfaces:**
- Consumes: `PlanInputs`, `FerryInputs`, `FerryRouteName`, `HomeLeg`, `RecordedVessel` from `src/lib/planInputs.ts`; `RouteOption`, `RiskLevel` from `src/types.ts`; `TERMINALS` from `src/api/ferries.ts`.
- Produces (`src/lib/fixtures.ts`): `FIXTURE_NOW: string`, `at(minutes: number): string`, `vessel(o: Partial<RecordedVessel> & { vesselName: string }): RecordedVessel`, `bainbridge(o?: Partial<FerryInputs>): FerryInputs`, `kingston(o?: Partial<FerryInputs>): FerryInputs`, `planInputs(o?: { bainbridge?: Partial<FerryInputs>; kingston?: Partial<FerryInputs>; drive?: PlanInputs['drive']; vessels?: RecordedVessel[] }): PlanInputs`
- Produces (`src/lib/routePlan.ts`):
  ```ts
  export interface RouteParams { vesselLoadingMinutes: number; boardingBufferMinutes: number; nearlyFullThreshold: number; closeCallMinutes: number; homeLegMatchMinutes: number; crossingMinutes: Record<FerryRouteName, number> }
  export const PARAMS: RouteParams
  export type SpaceState = 'unknown' | 'nearly-full' | 'ok'
  export interface PlannedRoute extends RouteOption { arrivalAt: string | null; spaceState: SpaceState | null; fallback: { departure: string; totalMinutes: number } | null; decisionMinutes: number }
  export interface RoutePlan { routes: PlannedRoute[]; winner: PlannedRoute | null; isCloseCall: boolean; closeCallGap: number | null; warnings: string[] }
  export function planRoutes(inputs: PlanInputs, params?: RouteParams, bias?: number): RoutePlan
  export function selectHomeLegTimes(inputs: PlanInputs, params?: RouteParams): Record<FerryRouteName, string[]>
  ```

- [ ] **Step 1: Create `src/lib/fixtures.ts`**

```ts
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
```

- [ ] **Step 2: Write failing tests `src/lib/routePlan.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { PARAMS, planRoutes, selectHomeLegTimes } from './routePlan'
import { at, planInputs, vessel } from './fixtures'
import type { RecordedVessel } from './planInputs'

const route = (plan: ReturnType<typeof planRoutes>, name: string) => plan.routes.find(r => r.name === name)!

describe('planRoutes', () => {
  it('prices each route with crossing minutes and the timed home leg nearest landing', () => {
    const plan = planRoutes(planInputs())
    expect(plan.routes.map(r => [r.name, r.totalTimeMinutes, r.arrivalAt])).toEqual([
      ['BAINBRIDGE', 107, at(107)], // 20 drive + 20 wait + 35 crossing + 32 home (leg at +75)
      ['KINGSTON', 147, at(147)],   // 60 drive + 35 wait + 30 crossing + 22 home (leg at +125)
      ['DRIVE', 150, at(150)],
    ])
    expect(plan.winner?.name).toBe('BAINBRIDGE')
    expect(plan.isCloseCall).toBe(false)
    expect(plan.closeCallGap).toBe(40)
    expect(plan.warnings).toEqual([])
  })

  it('records sailings inside the boarding buffer as missed', () => {
    const kingstonRoute = route(planRoutes(planInputs()), 'KINGSTON')
    expect(kingstonRoute.missedSailings).toEqual([new Date(at(45))])
    expect(kingstonRoute.nextDeparture).toEqual(new Date(at(95)))
  })

  it('rolls past a full sailing to the next one and warns', () => {
    const plan = planRoutes(planInputs({
      kingston: { spaces: [{ departure: at(95), driveUpSpaceCount: 0, totalSpaces: 200 }] },
    }))
    const kingstonRoute = route(plan, 'KINGSTON')
    expect(kingstonRoute.nextDeparture).toEqual(new Date(at(145)))
    expect(kingstonRoute.totalTimeMinutes).toBe(198) // 60 + 85 + 30 + 23
    expect(plan.warnings).toEqual(['Kingston: 1 full sailing skipped'])
  })

  it('keeps a nearly full sailing, adds the fallback, and judges the close call on it', () => {
    const plan = planRoutes(planInputs({
      bainbridge: { spaces: [{ departure: at(40), driveUpSpaceCount: 5, totalSpaces: 200 }] },
    }))
    const b = route(plan, 'BAINBRIDGE')
    expect(b.spaceState).toBe('nearly-full')
    expect(b.totalTimeMinutes).toBe(107)
    expect(b.fallback).toEqual({ departure: at(90), totalMinutes: 159 }) // 20 + 70 + 35 + 34
    expect(b.decisionMinutes).toBe(159)
    expect(plan.winner?.name).toBe('BAINBRIDGE')
    expect(plan.isCloseCall).toBe(true)
    expect(plan.closeCallGap).toBe(3) // KINGSTON 147 vs DRIVE 150 by decision time
  })

  it('makes decision time Infinity when a nearly full sailing has no fallback', () => {
    const plan = planRoutes(planInputs({
      bainbridge: {
        schedule: [{ departure: at(40), arrival: null, vesselName: 'Wenatchee' }],
        spaces: [{ departure: at(40), driveUpSpaceCount: 5, totalSpaces: 200 }],
      },
    }))
    expect(route(plan, 'BAINBRIDGE').decisionMinutes).toBe(Infinity)
    expect(plan.isCloseCall).toBe(true)
  })

  it('delays a sailing when its vessel is heading to the departing terminal', () => {
    const plan = planRoutes(planInputs({
      vessels: [vessel({ vesselName: 'Wenatchee', eta: at(40), arrivingTerminalId: 7 })],
    }))
    const b = route(plan, 'BAINBRIDGE')
    expect(b.nextDeparture).toEqual(new Date(at(55)))
    expect(b.totalTimeMinutes).toBe(122) // 20 + 35 + 35 + 32 (leg at +75 is 15 min from +90)
  })

  it('ignores an ETA for a vessel heading to a different terminal', () => {
    const plan = planRoutes(planInputs({
      vessels: [vessel({ vesselName: 'Wenatchee', eta: at(40), arrivingTerminalId: 3 })],
    }))
    expect(route(plan, 'BAINBRIDGE').nextDeparture).toEqual(new Date(at(40)))
  })

  it('falls back to name-only matching for vessels recorded without terminal fields', () => {
    const legacy = { vesselName: 'Wenatchee', eta: at(40) } as RecordedVessel
    const plan = planRoutes(planInputs({ vessels: [legacy] }))
    expect(route(plan, 'BAINBRIDGE').nextDeparture).toEqual(new Date(at(55)))
  })

  it('uses the live home leg and warns when no timed leg is close enough', () => {
    const plan = planRoutes(planInputs({
      bainbridge: { homeLegs: [{ departAt: null, minutes: 30 }, { departAt: at(200), minutes: 40 }] },
    }))
    expect(route(plan, 'BAINBRIDGE').totalTimeMinutes).toBe(105)
    expect(plan.warnings).toEqual(['Bainbridge: drive home priced with current traffic'])
  })

  it('applies the ferry bias to the drive-around route', () => {
    const inputs = planInputs({ drive: { minutes: 100, summary: null } })
    expect(planRoutes(inputs).winner?.name).toBe('DRIVE')
    const biased = planRoutes(inputs, PARAMS, 10)
    expect(biased.winner?.name).toBe('BAINBRIDGE')
    expect(route(biased, 'DRIVE').decisionMinutes).toBe(110)
    expect(biased.isCloseCall).toBe(true)
  })

  it('marks a route with no catchable sailings as unreachable', () => {
    const plan = planRoutes(planInputs({ bainbridge: { schedule: [] } }))
    const b = route(plan, 'BAINBRIDGE')
    expect(b.totalTimeMinutes).toBe(Infinity)
    expect(b.arrivalAt).toBeNull()
    expect(b.risks.overall).toBe('high')
    expect(plan.winner?.name).toBe('KINGSTON')
  })

  it('drops routes and warns when required data is missing', () => {
    const plan = planRoutes(planInputs({
      drive: null,
      bainbridge: { schedule: null },
      kingston: { homeLegs: [] },
    }))
    expect(plan.routes).toEqual([])
    expect(plan.winner).toBeNull()
    expect(plan.isCloseCall).toBe(false)
    expect(plan.warnings).toEqual([
      'Driving time unavailable',
      'Bainbridge route unavailable',
      'Kingston route unavailable',
    ])
  })

  it('lets parameters change the answer', () => {
    const plan = planRoutes(planInputs(), { ...PARAMS, crossingMinutes: { BAINBRIDGE: 40, KINGSTON: 30 } })
    expect(route(plan, 'BAINBRIDGE').totalTimeMinutes).toBe(112)
  })
})

describe('selectHomeLegTimes', () => {
  it('returns landing times for the primary sailing', () => {
    expect(selectHomeLegTimes(planInputs())).toEqual({ BAINBRIDGE: [at(75)], KINGSTON: [at(125)] })
  })

  it('adds the fallback landing time when nearly full', () => {
    const inputs = planInputs({
      bainbridge: { spaces: [{ departure: at(40), driveUpSpaceCount: 5, totalSpaces: 200 }] },
    })
    expect(selectHomeLegTimes(inputs).BAINBRIDGE).toEqual([at(75), at(125)])
  })

  it('returns nothing for a route missing its schedule', () => {
    expect(selectHomeLegTimes(planInputs({ bainbridge: { schedule: null } })).BAINBRIDGE).toEqual([])
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- src/lib/routePlan`
Expected: FAIL — cannot resolve `./routePlan`.

- [ ] **Step 4: Implement `src/lib/routePlan.ts`**

```ts
// Route algorithm v1. This is the file the tuning agent edits; routePlan.v0.ts
// stays frozen as the baseline. Pure: no fetching, no clock, no React.

import type { RiskLevel, RouteOption } from '../types'
import type { FerryInputs, FerryRouteName, HomeLeg, PlanInputs, RecordedVessel } from './planInputs'
import { TERMINALS } from '../api/ferries'

export interface RouteParams {
  vesselLoadingMinutes: number
  boardingBufferMinutes: number
  nearlyFullThreshold: number
  closeCallMinutes: number
  homeLegMatchMinutes: number
  crossingMinutes: Record<FerryRouteName, number>
}

export const PARAMS: RouteParams = {
  vesselLoadingMinutes: 15,
  boardingBufferMinutes: 10,
  nearlyFullThreshold: 10,
  closeCallMinutes: 15,
  homeLegMatchMinutes: 20,
  crossingMinutes: { BAINBRIDGE: 35, KINGSTON: 30 },
}

export type SpaceState = 'unknown' | 'nearly-full' | 'ok'

export interface PlannedRoute extends RouteOption {
  arrivalAt: string | null
  spaceState: SpaceState | null
  fallback: { departure: string; totalMinutes: number } | null
  // Time used for the close-call judgment: the fallback's total when the
  // primary sailing is nearly full, otherwise the route's own total.
  decisionMinutes: number
}

export interface RoutePlan {
  routes: PlannedRoute[]
  winner: PlannedRoute | null
  isCloseCall: boolean
  closeCallGap: number | null
  warnings: string[]
}

const MINUTE = 60_000
const SPACE_MATCH_MS = 5 * MINUTE
const FERRY_ROUTES: FerryRouteName[] = ['BAINBRIDGE', 'KINGSTON']
const LABELS: Record<FerryRouteName, string> = { BAINBRIDGE: 'Bainbridge', KINGSTON: 'Kingston' }
const DEPARTING_TERMINAL: Record<FerryRouteName, number> = {
  BAINBRIDGE: TERMINALS.SEATTLE,
  KINGSTON: TERMINALS.EDMONDS,
}

interface Sailing {
  scheduled: Date
  departure: Date
}

interface SailingChoice {
  arrivalAtTerminal: Date
  missed: Date[]
  skippedFull: number
  primary: Sailing | null
  fallback: Sailing | null
  spaces: number | null
}

const compare = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1)

function adjustedSchedule(name: FerryRouteName, ferry: FerryInputs, vessels: RecordedVessel[], params: RouteParams): Sailing[] {
  return (ferry.schedule ?? [])
    .map(sailing => {
      const scheduled = new Date(sailing.departure)
      const vessel = vessels.find(v => v.vesselName.toLowerCase() === sailing.vesselName.toLowerCase())
      // Records from before terminal fields existed have none; match by name only
      const headingHere = vessel?.arrivingTerminalId == null || vessel.arrivingTerminalId === DEPARTING_TERMINAL[name]
      let departure = scheduled
      if (vessel?.eta && headingHere) {
        const estimated = new Date(Date.parse(vessel.eta) + params.vesselLoadingMinutes * MINUTE)
        if (estimated > scheduled) departure = estimated
      }
      return { scheduled, departure }
    })
    .sort((a, b) => a.departure.getTime() - b.departure.getTime())
}

function spacesFor(ferry: FerryInputs, sailing: Sailing): number | null {
  const reading = ferry.spaces.find(
    s => Math.abs(Date.parse(s.departure) - sailing.scheduled.getTime()) < SPACE_MATCH_MS
  )
  return reading?.driveUpSpaceCount ?? null
}

function chooseSailings(
  name: FerryRouteName,
  now: Date,
  ferry: FerryInputs,
  vessels: RecordedVessel[],
  params: RouteParams
): SailingChoice {
  const arrivalAtTerminal = new Date(now.getTime() + (ferry.driveToTerminalMinutes as number) * MINUTE)
  const cutoff = arrivalAtTerminal.getTime() + params.boardingBufferMinutes * MINUTE
  const sailings = adjustedSchedule(name, ferry, vessels, params)

  const missed = sailings
    .filter(s => s.departure.getTime() <= cutoff && s.departure > now)
    .map(s => s.departure)
  const catchable = sailings.filter(s => s.departure.getTime() > cutoff)

  const openIndex = catchable.findIndex(s => spacesFor(ferry, s) !== 0)
  if (openIndex === -1) {
    return { arrivalAtTerminal, missed, skippedFull: catchable.length, primary: null, fallback: null, spaces: null }
  }

  const primary = catchable[openIndex]
  const spaces = spacesFor(ferry, primary)
  const nearlyFull = spaces !== null && spaces < params.nearlyFullThreshold
  const fallback = nearlyFull
    ? catchable.slice(openIndex + 1).find(s => spacesFor(ferry, s) !== 0) ?? null
    : null

  return { arrivalAtTerminal, missed, skippedFull: openIndex, primary, fallback, spaces }
}

function landing(name: FerryRouteName, sailing: Sailing, params: RouteParams): Date {
  return new Date(sailing.departure.getTime() + params.crossingMinutes[name] * MINUTE)
}

function matchHomeLeg(legs: HomeLeg[], start: Date, params: RouteParams): { minutes: number; timed: boolean } | null {
  const nearest = legs
    .filter(leg => leg.departAt !== null)
    .map(leg => ({ leg, diff: Math.abs(Date.parse(leg.departAt as string) - start.getTime()) }))
    .sort((a, b) => a.diff - b.diff)[0]
  if (nearest && nearest.diff <= params.homeLegMatchMinutes * MINUTE) {
    return { minutes: nearest.leg.minutes, timed: true }
  }
  const live = legs.find(leg => leg.departAt === null)
  return live ? { minutes: live.minutes, timed: false } : null
}

interface SailingTotal {
  total: number
  wait: number
  home: number
  timed: boolean
}

function sailingTotal(
  name: FerryRouteName,
  sailing: Sailing,
  choice: SailingChoice,
  ferry: FerryInputs,
  params: RouteParams
): SailingTotal | null {
  const wait = Math.max(0, Math.round((sailing.departure.getTime() - choice.arrivalAtTerminal.getTime()) / MINUTE))
  const leg = matchHomeLeg(ferry.homeLegs, landing(name, sailing, params), params)
  if (!leg) return null
  const total = (ferry.driveToTerminalMinutes as number) + wait + params.crossingMinutes[name] + leg.minutes
  return { total, wait, home: leg.minutes, timed: leg.timed }
}

// Copied from v0 so tuning here never moves the baseline
function assessTimingRisk(waitMinutes: number | null): RiskLevel | null {
  if (waitMinutes === null) return null
  if (waitMinutes < 10) return 'high'
  if (waitMinutes < 20) return 'medium'
  return 'low'
}

function assessSpaceRisk(spaces: number | null): RiskLevel | null {
  if (spaces === null) return null
  if (spaces < 10) return 'high'
  if (spaces < 30) return 'medium'
  return 'low'
}

function calculateOverallRisk(timing: RiskLevel | null, space: RiskLevel | null): RiskLevel {
  const risks = [timing, space].filter(Boolean) as RiskLevel[]
  if (risks.includes('high')) return 'high'
  if (risks.includes('medium')) return 'medium'
  return 'low'
}

function planFerryRoute(
  name: FerryRouteName,
  now: Date,
  ferry: FerryInputs,
  vessels: RecordedVessel[],
  params: RouteParams,
  warnings: string[]
): PlannedRoute | null {
  const choice = chooseSailings(name, now, ferry, vessels, params)
  const crossing = params.crossingMinutes[name]
  const driveToTerminal = ferry.driveToTerminalMinutes as number

  if (!choice.primary) {
    return {
      name,
      type: 'ferry',
      totalTimeMinutes: Infinity,
      driveToTerminalMinutes: driveToTerminal,
      waitTimeMinutes: null,
      ferryTimeMinutes: crossing,
      driveFromTerminalMinutes: ferry.homeLegs.find(leg => leg.departAt === null)?.minutes ?? null,
      nextDeparture: null,
      spacesAvailable: null,
      canMakeNextFerry: false,
      missedSailings: choice.missed,
      driveSummary: null,
      risks: { timingRisk: null, spaceRisk: null, overall: 'high' },
      arrivalAt: null,
      spaceState: null,
      fallback: null,
      decisionMinutes: Infinity,
    }
  }

  const primary = sailingTotal(name, choice.primary, choice, ferry, params)
  if (!primary) return null

  if (choice.skippedFull > 0) {
    warnings.push(`${LABELS[name]}: ${choice.skippedFull} full sailing${choice.skippedFull === 1 ? '' : 's'} skipped`)
  }
  if (!primary.timed) {
    warnings.push(`${LABELS[name]}: drive home priced with current traffic`)
  }

  const fallback = choice.fallback ? sailingTotal(name, choice.fallback, choice, ferry, params) : null
  const nearlyFull = choice.spaces !== null && choice.spaces < params.nearlyFullThreshold
  const timingRisk = assessTimingRisk(primary.wait)
  const spaceRisk = assessSpaceRisk(choice.spaces)

  return {
    name,
    type: 'ferry',
    totalTimeMinutes: primary.total,
    driveToTerminalMinutes: driveToTerminal,
    waitTimeMinutes: primary.wait,
    ferryTimeMinutes: crossing,
    driveFromTerminalMinutes: primary.home,
    nextDeparture: choice.primary.departure,
    spacesAvailable: choice.spaces,
    canMakeNextFerry: true,
    missedSailings: choice.missed,
    driveSummary: null,
    risks: { timingRisk, spaceRisk, overall: calculateOverallRisk(timingRisk, spaceRisk) },
    arrivalAt: new Date(now.getTime() + primary.total * MINUTE).toISOString(),
    spaceState: choice.spaces === null ? 'unknown' : nearlyFull ? 'nearly-full' : 'ok',
    fallback: choice.fallback && fallback
      ? { departure: choice.fallback.departure.toISOString(), totalMinutes: fallback.total }
      : null,
    decisionMinutes: nearlyFull ? (fallback?.total ?? Infinity) : primary.total,
  }
}

export function planRoutes(inputs: PlanInputs, params: RouteParams = PARAMS, bias = 0): RoutePlan {
  const now = new Date(inputs.now)
  const routes: PlannedRoute[] = []
  const warnings: string[] = []

  if (inputs.drive) {
    routes.push({
      name: 'DRIVE',
      type: 'drive-around',
      totalTimeMinutes: inputs.drive.minutes,
      driveToTerminalMinutes: null,
      waitTimeMinutes: null,
      ferryTimeMinutes: null,
      driveFromTerminalMinutes: inputs.drive.minutes,
      nextDeparture: null,
      spacesAvailable: null,
      canMakeNextFerry: null,
      missedSailings: [],
      driveSummary: inputs.drive.summary,
      risks: { timingRisk: null, spaceRisk: null, overall: 'low' },
      arrivalAt: new Date(now.getTime() + inputs.drive.minutes * MINUTE).toISOString(),
      spaceState: null,
      fallback: null,
      decisionMinutes: inputs.drive.minutes + bias,
    })
  } else {
    warnings.push('Driving time unavailable')
  }

  for (const name of FERRY_ROUTES) {
    const ferry = inputs.ferries[name]
    if (ferry.driveToTerminalMinutes !== null && ferry.schedule !== null) {
      const planned = planFerryRoute(name, now, ferry, inputs.vessels, params, warnings)
      if (planned) {
        routes.push(planned)
        continue
      }
    }
    warnings.push(`${LABELS[name]} route unavailable`)
  }

  const headline = (r: PlannedRoute) => (r.type === 'drive-around' ? r.totalTimeMinutes + bias : r.totalTimeMinutes)
  routes.sort((a, b) => compare(headline(a), headline(b)))

  const winner = routes[0] ?? null
  const byDecision = [...routes].sort((a, b) => compare(a.decisionMinutes, b.decisionMinutes))

  let isCloseCall = false
  let closeCallGap: number | null = null
  if (winner && byDecision.length >= 2 && Number.isFinite(headline(winner))) {
    const flipped = byDecision[0].name !== winner.name
    if (Number.isFinite(byDecision[1].decisionMinutes)) {
      closeCallGap = byDecision[1].decisionMinutes - byDecision[0].decisionMinutes
      isCloseCall = closeCallGap <= params.closeCallMinutes || flipped
    } else {
      isCloseCall = flipped
    }
  }

  return { routes, winner, isCloseCall, closeCallGap, warnings }
}

// Landing times the app should price the drive home at: primary sailing, plus
// the fallback when the primary is nearly full.
export function selectHomeLegTimes(inputs: PlanInputs, params: RouteParams = PARAMS): Record<FerryRouteName, string[]> {
  const now = new Date(inputs.now)
  const times: Record<FerryRouteName, string[]> = { BAINBRIDGE: [], KINGSTON: [] }
  for (const name of FERRY_ROUTES) {
    const ferry = inputs.ferries[name]
    if (ferry.driveToTerminalMinutes === null || ferry.schedule === null) continue
    const choice = chooseSailings(name, now, ferry, inputs.vessels, params)
    times[name] = [choice.primary, choice.fallback]
      .flatMap(s => (s ? [landing(name, s, params).toISOString()] : []))
  }
  return times
}
```

- [ ] **Step 5: Run tests and type check**

Run: `npm test && npx tsc --noEmit`
Expected: all tests PASS (existing 50 + new); tsc exits 0.

Note for the "nearly full with no fallback" test: headline winner is BAINBRIDGE (107) but by decision time KINGSTON (147) ranks first, so `isCloseCall` is true via the flip rule.

- [ ] **Step 6: Commit**

```bash
git add src/lib/fixtures.ts src/lib/routePlan.ts src/lib/routePlan.test.ts
git commit -m "feat: route plan v1 with fallback sailings and timed home legs

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TpNTLAPaGY8E3AoB3NZVyG"
```

---

### Task 2: Scoring and handcrafted guardrails

**Files:**
- Create: `eval/score.ts`, `eval/score.test.ts`, `eval/scenarios/handcrafted.ts`
- Modify: `package.json` (tsx), `tsconfig.json`, `vitest.config.ts`

**Interfaces:**
- Consumes: `planRoutes`, `PARAMS`, `RoutePlan`, `RouteParams` (Task 1); fixtures (Task 1); `RouteOption` from `src/types.ts`.
- Produces (`eval/score.ts`):
  ```ts
  export type RouteName = 'DRIVE' | 'BAINBRIDGE' | 'KINGSTON'
  export const ROUTE_NAMES: RouteName[]
  export type RouteOutcome = { arrivalAt: string; caughtSailing: string | null } | { unresolved: string }
  export interface Outcome { sampleId: string; routes: Record<RouteName, RouteOutcome>; observedBest: RouteName | null }
  export interface Prediction { arrivals: Record<RouteName, string | null>; winner: RouteName | null }
  export interface RouteMetrics { n: number; meanAbsError: number | null; meanSignedError: number | null; p90AbsError: number | null }
  export interface SetMetrics { samples: number; unresolved: number; overall: RouteMetrics; routes: Record<RouteName, RouteMetrics>; winner: { n: number; agree: number; rate: number | null } }
  export interface ScoredRow { prediction: Prediction; outcome: Outcome }
  export interface Miss { sampleId: string; route: RouteName; errorMinutes: number; predicted: string; observed: string; caughtSailing: string | null }
  export interface Baseline { generatedAt: string; tune: SetMetrics; holdout: SetMetrics }
  export interface HandcraftedExpect { winner: RouteName; isCloseCall: boolean; routes?: Partial<Record<RouteName, { departure?: string | null; fallbackDeparture?: string | null; arrivalAt?: string | null }>> }
  export const MAE_TOLERANCE_MINUTES = 2
  export function predictionFromPlan(plan: RoutePlan): Prediction
  export function predictionFromV0(routes: RouteOption[], now: string): Prediction
  export function scoreSet(rows: ScoredRow[]): SetMetrics
  export function worstMisses(rows: ScoredRow[], limit: number): Miss[]
  export function isHoldout(sampleId: string): boolean
  export function gateAgainstBaseline(holdout: SetMetrics, baseline: Baseline): string[]
  export function checkHandcrafted(plan: RoutePlan, expect: HandcraftedExpect): string[]
  ```
- Produces (`eval/scenarios/handcrafted.ts`): `HANDCRAFTED_PARAMS: RouteParams`, `interface HandcraftedScenario { name: string; inputs: PlanInputs; bias?: number; expect: HandcraftedExpect }`, `HANDCRAFTED: HandcraftedScenario[]`

- [ ] **Step 1: Tooling**

Run: `npm install -D tsx@4.23.13`

In `tsconfig.json`, change `"include": ["src"]` to `"include": ["src", "eval"]`.

In `vitest.config.ts`, change `include: ['src/**/*.test.ts']` to `include: ['src/**/*.test.ts', 'eval/**/*.test.ts']`.

- [ ] **Step 2: Create `eval/scenarios/handcrafted.ts`**

```ts
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
```

- [ ] **Step 3: Write failing tests `eval/score.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { planRoutes } from '../src/lib/routePlan'
import { planRoutesV0 } from '../src/lib/routePlan.v0'
import { at, FIXTURE_NOW, planInputs } from '../src/lib/fixtures'
import { HANDCRAFTED, HANDCRAFTED_PARAMS } from './scenarios/handcrafted'
import {
  checkHandcrafted,
  gateAgainstBaseline,
  isHoldout,
  predictionFromPlan,
  predictionFromV0,
  scoreSet,
  worstMisses,
  type Outcome,
  type ScoredRow,
} from './score'

function outcome(sampleId: string, arrivals: Partial<Record<'DRIVE' | 'BAINBRIDGE' | 'KINGSTON', string>>, best: Outcome['observedBest']): Outcome {
  const r = (a?: string) => (a ? { arrivalAt: a, caughtSailing: null } : { unresolved: 'no data' })
  return { sampleId, routes: { DRIVE: r(arrivals.DRIVE), BAINBRIDGE: r(arrivals.BAINBRIDGE), KINGSTON: r(arrivals.KINGSTON) }, observedBest: best }
}

describe('handcrafted guardrails', () => {
  for (const scenario of HANDCRAFTED) {
    it(`passes: ${scenario.name}`, () => {
      const plan = planRoutes(scenario.inputs, HANDCRAFTED_PARAMS, scenario.bias ?? 0)
      expect(checkHandcrafted(plan, scenario.expect)).toEqual([])
    })
  }

  it('reports each mismatch', () => {
    const plan = planRoutes(planInputs(), HANDCRAFTED_PARAMS)
    expect(checkHandcrafted(plan, {
      winner: 'KINGSTON',
      isCloseCall: true,
      routes: { BAINBRIDGE: { departure: at(90), arrivalAt: at(120) } },
    })).toEqual([
      'winner: expected KINGSTON, got BAINBRIDGE',
      'isCloseCall: expected true, got false',
      `BAINBRIDGE departure: expected ${at(90)}, got ${at(40)}`,
      `BAINBRIDGE arrivalAt: expected ${at(120)} ±2m, got ${at(107)}`,
    ])
  })
})

describe('predictions', () => {
  it('reads v1 arrivals and winner', () => {
    expect(predictionFromPlan(planRoutes(planInputs()))).toEqual({
      arrivals: { DRIVE: at(150), BAINBRIDGE: at(107), KINGSTON: at(147) },
      winner: 'BAINBRIDGE',
    })
  })

  it('derives v0 arrivals from now plus total minutes', () => {
    const prediction = predictionFromV0(planRoutesV0(planInputs()).routes, FIXTURE_NOW)
    expect(prediction.arrivals.DRIVE).toBe(at(150))
    expect(prediction.winner).toBe('BAINBRIDGE')
  })

  it('drops unreachable routes from v0 arrivals', () => {
    const prediction = predictionFromV0(planRoutesV0(planInputs({ bainbridge: { schedule: [] } })).routes, FIXTURE_NOW)
    expect(prediction.arrivals.BAINBRIDGE).toBeNull()
  })
})

describe('scoreSet', () => {
  const rows: ScoredRow[] = [
    {
      prediction: { arrivals: { DRIVE: at(100), BAINBRIDGE: at(90), KINGSTON: null }, winner: 'BAINBRIDGE' },
      outcome: outcome('a', { DRIVE: at(110), BAINBRIDGE: at(80) }, 'BAINBRIDGE'),
    },
    {
      prediction: { arrivals: { DRIVE: at(100), BAINBRIDGE: at(90), KINGSTON: at(95) }, winner: 'BAINBRIDGE' },
      outcome: outcome('b', { DRIVE: at(96), KINGSTON: at(95) }, 'KINGSTON'),
    },
  ]

  it('computes per-route and overall errors in minutes', () => {
    const m = scoreSet(rows)
    expect(m.samples).toBe(2)
    expect(m.routes.DRIVE).toEqual({ n: 2, meanAbsError: 7, meanSignedError: -3, p90AbsError: 10 })
    expect(m.routes.BAINBRIDGE).toEqual({ n: 1, meanAbsError: 10, meanSignedError: 10, p90AbsError: 10 })
    expect(m.routes.KINGSTON).toEqual({ n: 1, meanAbsError: 0, meanSignedError: 0, p90AbsError: 0 })
    expect(m.overall.n).toBe(4)
    expect(m.overall.meanAbsError).toBe(6)
    expect(m.unresolved).toBe(2)
    expect(m.winner).toEqual({ n: 2, agree: 1, rate: 0.5 })
  })

  it('returns null metrics for an empty set', () => {
    const m = scoreSet([])
    expect(m.overall).toEqual({ n: 0, meanAbsError: null, meanSignedError: null, p90AbsError: null })
    expect(m.winner.rate).toBeNull()
  })

  it('lists the largest misses first', () => {
    expect(worstMisses(rows, 2)).toEqual([
      { sampleId: 'a', route: 'DRIVE', errorMinutes: -10, predicted: at(100), observed: at(110), caughtSailing: null },
      { sampleId: 'a', route: 'BAINBRIDGE', errorMinutes: 10, predicted: at(90), observed: at(80), caughtSailing: null },
    ])
  })
})

describe('split and gates', () => {
  it('assigns holdout deterministically at roughly one in five', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `downtown-2026-09-14T${String(i).padStart(4, '0')}`)
    const holdout = ids.filter(isHoldout).length
    expect(isHoldout(ids[0])).toBe(isHoldout(ids[0]))
    expect(holdout).toBeGreaterThan(150)
    expect(holdout).toBeLessThan(250)
  })

  const set = (mae: number | null, rate: number | null) => ({
    samples: 10,
    unresolved: 0,
    overall: { n: 10, meanAbsError: mae, meanSignedError: 0, p90AbsError: mae },
    routes: {
      DRIVE: { n: 0, meanAbsError: null, meanSignedError: null, p90AbsError: null },
      BAINBRIDGE: { n: 0, meanAbsError: null, meanSignedError: null, p90AbsError: null },
      KINGSTON: { n: 0, meanAbsError: null, meanSignedError: null, p90AbsError: null },
    },
    winner: { n: 10, agree: 0, rate },
  })
  const baseline = { generatedAt: 'x', tune: set(8, 0.5), holdout: set(8, 0.5) }

  it('passes within tolerance and equal agreement', () => {
    expect(gateAgainstBaseline(set(10, 0.5), baseline)).toEqual([])
  })

  it('fails on worse error or lower agreement', () => {
    expect(gateAgainstBaseline(set(10.5, 0.4), baseline)).toEqual([
      'holdout mean absolute error 10.5m is worse than baseline 8.0m by more than 2m',
      'holdout winner agreement 40% is lower than baseline 50%',
    ])
  })
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm test -- eval`
Expected: FAIL — cannot resolve `./score`.

- [ ] **Step 5: Implement `eval/score.ts`**

```ts
// Pure scoring for the eval harness. Error sign: predicted minus observed, so
// positive means the algorithm said you'd arrive later than you did.

import type { RoutePlan } from '../src/lib/routePlan'
import type { RouteOption } from '../src/types'

export type RouteName = 'DRIVE' | 'BAINBRIDGE' | 'KINGSTON'
export const ROUTE_NAMES: RouteName[] = ['DRIVE', 'BAINBRIDGE', 'KINGSTON']

export type RouteOutcome = { arrivalAt: string; caughtSailing: string | null } | { unresolved: string }

export interface Outcome {
  sampleId: string
  routes: Record<RouteName, RouteOutcome>
  observedBest: RouteName | null
}

export interface Prediction {
  arrivals: Record<RouteName, string | null>
  winner: RouteName | null
}

export interface RouteMetrics {
  n: number
  meanAbsError: number | null
  meanSignedError: number | null
  p90AbsError: number | null
}

export interface SetMetrics {
  samples: number
  unresolved: number
  overall: RouteMetrics
  routes: Record<RouteName, RouteMetrics>
  winner: { n: number; agree: number; rate: number | null }
}

export interface ScoredRow {
  prediction: Prediction
  outcome: Outcome
}

export interface Miss {
  sampleId: string
  route: RouteName
  errorMinutes: number
  predicted: string
  observed: string
  caughtSailing: string | null
}

export interface Baseline {
  generatedAt: string
  tune: SetMetrics
  holdout: SetMetrics
}

export interface HandcraftedExpect {
  winner: RouteName
  isCloseCall: boolean
  routes?: Partial<Record<RouteName, {
    departure?: string | null
    fallbackDeparture?: string | null
    arrivalAt?: string | null
  }>>
}

export const MAE_TOLERANCE_MINUTES = 2
const ARRIVAL_TOLERANCE_MS = 2 * 60_000

const emptyArrivals = (): Record<RouteName, string | null> => ({ DRIVE: null, BAINBRIDGE: null, KINGSTON: null })

export function predictionFromPlan(plan: RoutePlan): Prediction {
  const arrivals = emptyArrivals()
  for (const route of plan.routes) arrivals[route.name as RouteName] = route.arrivalAt
  const winner = plan.winner && Number.isFinite(plan.winner.totalTimeMinutes) ? (plan.winner.name as RouteName) : null
  return { arrivals, winner }
}

export function predictionFromV0(routes: RouteOption[], now: string): Prediction {
  const arrivals = emptyArrivals()
  for (const route of routes) {
    if (Number.isFinite(route.totalTimeMinutes)) {
      arrivals[route.name as RouteName] = new Date(Date.parse(now) + route.totalTimeMinutes * 60_000).toISOString()
    }
  }
  const first = routes[0]
  const winner = first && Number.isFinite(first.totalTimeMinutes) ? (first.name as RouteName) : null
  return { arrivals, winner }
}

function metrics(errors: number[]): RouteMetrics {
  if (errors.length === 0) return { n: 0, meanAbsError: null, meanSignedError: null, p90AbsError: null }
  const abs = errors.map(Math.abs).sort((a, b) => a - b)
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
  return {
    n: errors.length,
    meanAbsError: sum(abs) / abs.length,
    meanSignedError: sum(errors) / errors.length,
    p90AbsError: abs[Math.ceil(0.9 * abs.length) - 1],
  }
}

function errorsFor(row: ScoredRow, name: RouteName): number | null {
  const observed = row.outcome.routes[name]
  const predicted = row.prediction.arrivals[name]
  if (!('arrivalAt' in observed) || predicted === null) return null
  return (Date.parse(predicted) - Date.parse(observed.arrivalAt)) / 60_000
}

export function scoreSet(rows: ScoredRow[]): SetMetrics {
  const perRoute: Record<RouteName, number[]> = { DRIVE: [], BAINBRIDGE: [], KINGSTON: [] }
  let unresolved = 0
  let winnerN = 0
  let agree = 0

  for (const row of rows) {
    for (const name of ROUTE_NAMES) {
      if ('unresolved' in row.outcome.routes[name]) unresolved++
      const error = errorsFor(row, name)
      if (error !== null) perRoute[name].push(error)
    }
    if (row.prediction.winner && row.outcome.observedBest) {
      winnerN++
      if (row.prediction.winner === row.outcome.observedBest) agree++
    }
  }

  return {
    samples: rows.length,
    unresolved,
    overall: metrics(ROUTE_NAMES.flatMap(name => perRoute[name])),
    routes: {
      DRIVE: metrics(perRoute.DRIVE),
      BAINBRIDGE: metrics(perRoute.BAINBRIDGE),
      KINGSTON: metrics(perRoute.KINGSTON),
    },
    winner: { n: winnerN, agree, rate: winnerN === 0 ? null : agree / winnerN },
  }
}

export function worstMisses(rows: ScoredRow[], limit: number): Miss[] {
  const misses: Miss[] = []
  for (const row of rows) {
    for (const name of ROUTE_NAMES) {
      const observed = row.outcome.routes[name]
      const predicted = row.prediction.arrivals[name]
      const error = errorsFor(row, name)
      if (error === null || !('arrivalAt' in observed) || predicted === null) continue
      misses.push({
        sampleId: row.outcome.sampleId,
        route: name,
        errorMinutes: error,
        predicted,
        observed: observed.arrivalAt,
        caughtSailing: observed.caughtSailing,
      })
    }
  }
  return misses
    .sort((a, b) => Math.abs(b.errorMinutes) - Math.abs(a.errorMinutes))
    .slice(0, limit)
}

// FNV-1a 32-bit; stable across runs and machines
export function isHoldout(sampleId: string): boolean {
  let hash = 0x811c9dc5
  for (let i = 0; i < sampleId.length; i++) {
    hash ^= sampleId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % 5 === 0
}

const pct = (rate: number) => `${Math.round(rate * 100)}%`

export function gateAgainstBaseline(holdout: SetMetrics, baseline: Baseline): string[] {
  const failures: string[] = []
  const mae = holdout.overall.meanAbsError
  const baseMae = baseline.holdout.overall.meanAbsError
  if (mae !== null && baseMae !== null && mae > baseMae + MAE_TOLERANCE_MINUTES) {
    failures.push(
      `holdout mean absolute error ${mae.toFixed(1)}m is worse than baseline ${baseMae.toFixed(1)}m by more than ${MAE_TOLERANCE_MINUTES}m`
    )
  }
  const rate = holdout.winner.rate
  const baseRate = baseline.holdout.winner.rate
  if (rate !== null && baseRate !== null && rate < baseRate) {
    failures.push(`holdout winner agreement ${pct(rate)} is lower than baseline ${pct(baseRate)}`)
  }
  return failures
}

export function checkHandcrafted(plan: RoutePlan, expect: HandcraftedExpect): string[] {
  const failures: string[] = []
  const winner = plan.winner?.name ?? null
  if (winner !== expect.winner) failures.push(`winner: expected ${expect.winner}, got ${winner}`)
  if (plan.isCloseCall !== expect.isCloseCall) {
    failures.push(`isCloseCall: expected ${expect.isCloseCall}, got ${plan.isCloseCall}`)
  }

  for (const name of ROUTE_NAMES) {
    const want = expect.routes?.[name]
    if (!want) continue
    const route = plan.routes.find(r => r.name === name)
    if (!route) {
      failures.push(`${name}: route missing from plan`)
      continue
    }
    if (want.departure !== undefined) {
      const got = route.nextDeparture ? route.nextDeparture.toISOString() : null
      if (got !== want.departure) failures.push(`${name} departure: expected ${want.departure}, got ${got}`)
    }
    if (want.fallbackDeparture !== undefined) {
      const got = route.fallback?.departure ?? null
      if (got !== want.fallbackDeparture) {
        failures.push(`${name} fallbackDeparture: expected ${want.fallbackDeparture}, got ${got}`)
      }
    }
    if (want.arrivalAt !== undefined) {
      const got = route.arrivalAt
      const ok = want.arrivalAt === null
        ? got === null
        : got !== null && Math.abs(Date.parse(got) - Date.parse(want.arrivalAt)) <= ARRIVAL_TOLERANCE_MS
      if (!ok) failures.push(`${name} arrivalAt: expected ${want.arrivalAt} ±2m, got ${got}`)
    }
  }

  return failures
}
```

- [ ] **Step 6: Run tests and type check**

Run: `npm test && npx tsc --noEmit`
Expected: PASS; tsc exits 0.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts eval/score.ts eval/score.test.ts eval/scenarios/handcrafted.ts
git commit -m "feat(eval): scoring, holdout split, gates and handcrafted guardrails

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TpNTLAPaGY8E3AoB3NZVyG"
```

---

### Task 3: Resolver

**Files:**
- Create: `eval/resolver.ts`, `eval/resolver.test.ts`, `eval/resolve.ts`, `eval/fetchSamples.ts`
- Modify: `.gitignore`, `package.json`

**Interfaces:**
- Consumes: `SampleRecord` from `src/sampler/runSample.ts`; `FerryRouteName`, `PlanInputs` from `src/lib/planInputs.ts`; `Outcome`, `RouteName`, `RouteOutcome` (Task 2); `parseWsdotDate` from `src/api/ferries.ts`; `pacificClock` from `src/sampler/window.ts`; fixtures (Task 1).
- Produces (`eval/resolver.ts`):
  ```ts
  export interface HistoryRow { vessel: string; scheduledDepart: string; actualDepart: string | null; estArrival: string | null }
  export const RESOLVER: { boardingBufferMinutes: 10; nearbyRunMinutes: 10; spaceMatchMinutes: 5; historyMatchMinutes: 2; lookbackMinutes: 30; settleMinutes: 210; fallbackCrossingMinutes: Record<FerryRouteName, number> }
  export function normalizeVessel(name: string): string
  export function isResolvable(sample: SampleRecord, asOf: Date): boolean
  export function resolveSample(sample: SampleRecord, allSamples: SampleRecord[], history: HistoryRow[]): Outcome
  ```
- Produces: `eval/data/samples.jsonl` (via `npm run eval:fetch`), `eval/data/outcomes.jsonl` (via `npm run eval:resolve`).

- [ ] **Step 1: Write failing tests `eval/resolver.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { isResolvable, normalizeVessel, resolveSample, type HistoryRow } from './resolver'
import { at, planInputs } from '../src/lib/fixtures'
import type { SampleRecord } from '../src/sampler/runSample'
import type { PlanInputs } from '../src/lib/planInputs'

// Fixture timeline (minutes after 17:00Z): Bainbridge drive 20 → terminal +20,
// board by +30. Sailings +40 Wenatchee, +90 Tacoma, +140 Wenatchee.
// Kingston drive 60 → terminal +60, board by +70. Sailings +45, +95, +145.

function sample(offsetMinutes: number, inputs: PlanInputs = planInputs(), schemaVersion = 2): SampleRecord {
  const now = at(offsetMinutes)
  return {
    sampleId: `downtown-${now}`,
    schemaVersion,
    origin: { id: 'downtown', label: 'Downtown', location: { lat: 0, lng: 0 } },
    destination: { lat: 1, lng: 1 },
    now,
    inputs: { ...inputs, now },
  }
}

const row = (vessel: string, scheduled: number, actual: number, arrival: number): HistoryRow => ({
  vessel,
  scheduledDepart: at(scheduled),
  actualDepart: at(actual),
  estArrival: at(arrival),
})

const history: HistoryRow[] = [
  row('Wenatchee', 40, 42, 75),
  row('Tacoma', 90, 91, 126),
  row('Wenatchee', 140, 140, 175),
  row('Puyallup', 45, 46, 66),
  row('Spokane', 95, 99, 121),
  row('Puyallup', 145, 146, 176),
]

// A later run supplies the live terminal→destination leg near landing.
// Scheduled sailings in these runs have shifted relative times, but the
// resolver only reads their homeLegs and spaces.
const later = (offset: number, bainbridgeLive: number, kingstonLive: number, spaces: PlanInputs['ferries']['BAINBRIDGE']['spaces'] = []) =>
  sample(offset, planInputs({
    bainbridge: { homeLegs: [{ departAt: null, minutes: bainbridgeLive }], spaces },
    kingston: { homeLegs: [{ departAt: null, minutes: kingstonLive }] },
  }))

describe('resolveSample', () => {
  const base = sample(0)
  const runs = [base, later(80, 31, 19), later(120, 33, 25)]

  it('resolves the drive-around from the sample itself', () => {
    const outcome = resolveSample(base, runs, history)
    expect(outcome.routes.DRIVE).toEqual({ arrivalAt: at(150), caughtSailing: null })
  })

  it('catches the first sailing that actually left after boarding time and uses the run nearest landing', () => {
    const outcome = resolveSample(base, runs, history)
    // Wenatchee +40 left at +42 (> +30 board-by), landed +75; nearest run +80 → 31 min
    expect(outcome.routes.BAINBRIDGE).toEqual({ arrivalAt: at(106), caughtSailing: at(40) })
    // Kingston board-by +70: Puyallup +45 left +46 (too early); Spokane +95 left +99, landed +121; run +120 → 25
    expect(outcome.routes.KINGSTON).toEqual({ arrivalAt: at(146), caughtSailing: at(95) })
    expect(outcome.observedBest).toBe('BAINBRIDGE')
  })

  it('skips a sailing the last reading before terminal arrival showed as full', () => {
    const fullReading = later(10, 30, 20, [{ departure: at(40), driveUpSpaceCount: 0, totalSpaces: 200 }])
    const outcome = resolveSample(base, [base, fullReading, later(120, 33, 25), later(140, 35, 26)], history)
    // Tacoma +90 left +91, landed +126; nearest run +120 → 33
    expect(outcome.routes.BAINBRIDGE).toEqual({ arrivalAt: at(159), caughtSailing: at(90) })
  })

  it('ignores space readings taken after terminal arrival', () => {
    const lateReading = later(25, 30, 20, [{ departure: at(40), driveUpSpaceCount: 0, totalSpaces: 200 }])
    const outcome = resolveSample(base, [base, lateReading, ...runs.slice(1)], history)
    expect(outcome.routes.BAINBRIDGE).toEqual({ arrivalAt: at(106), caughtSailing: at(40) })
  })

  it('is unresolved when no run is near the landing time', () => {
    const outcome = resolveSample(base, [base], history)
    expect(outcome.routes.BAINBRIDGE).toEqual({ unresolved: 'no sample run near arrival' })
    expect(outcome.observedBest).toBe('DRIVE')
  })

  it('is unresolved when a relevant sailing has no vessel history', () => {
    const outcome = resolveSample(base, runs, history.filter(h => h.vessel !== 'Wenatchee'))
    expect(outcome.routes.BAINBRIDGE).toEqual({ unresolved: `no vessel history for Wenatchee ${at(40)}` })
  })

  it('treats an unrecorded sailing before boarding time as missed, not unresolved', () => {
    const outcome = resolveSample(base, runs, history.filter(h => !(h.vessel === 'Puyallup' && h.scheduledDepart === at(45))))
    expect(outcome.routes.KINGSTON).toEqual({ arrivalAt: at(146), caughtSailing: at(95) })
  })

  it('matches vessel names ignoring spaces and case', () => {
    expect(normalizeVessel('Walla Walla')).toBe(normalizeVessel('WallaWalla'))
  })
})

describe('isResolvable', () => {
  it('requires schema version 2 and a settled trip', () => {
    const s = sample(0)
    expect(isResolvable(s, new Date(Date.parse(s.now) + 209 * 60_000))).toBe(false)
    expect(isResolvable(s, new Date(Date.parse(s.now) + 210 * 60_000))).toBe(true)
    expect(isResolvable(sample(0, planInputs(), 1), new Date(Date.parse(s.now) + 999 * 60_000))).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- eval/resolver`
Expected: FAIL — cannot resolve `./resolver`.

- [ ] **Step 3: Implement `eval/resolver.ts`**

```ts
// Turns a recorded sample into observed ("proxy truth") arrivals per route,
// using only data recorded by the sampler and WSDOT vessel history. No
// Google calls: Google can't price the past, so later sampler runs stand in.
// These constants define the truth, not the algorithm: the tuning agent must
// not edit this file.

import type { SampleRecord } from '../src/sampler/runSample'
import type { FerryRouteName } from '../src/lib/planInputs'
import type { Outcome, RouteName, RouteOutcome } from './score'

export interface HistoryRow {
  vessel: string
  scheduledDepart: string
  actualDepart: string | null
  estArrival: string | null
}

export const RESOLVER = {
  boardingBufferMinutes: 10,
  nearbyRunMinutes: 10,
  spaceMatchMinutes: 5,
  historyMatchMinutes: 2,
  lookbackMinutes: 30,
  // Latest trips finish within about 3 hours; vessel history lags ~30 min
  settleMinutes: 210,
  fallbackCrossingMinutes: { BAINBRIDGE: 35, KINGSTON: 30 } as Record<FerryRouteName, number>,
} as const

const MINUTE = 60_000
const FERRY_ROUTES: FerryRouteName[] = ['BAINBRIDGE', 'KINGSTON']

export function normalizeVessel(name: string): string {
  return name.replace(/\s+/g, '').toLowerCase()
}

export function isResolvable(sample: SampleRecord, asOf: Date): boolean {
  return (sample.schemaVersion ?? 1) >= 2 &&
    Date.parse(sample.now) + RESOLVER.settleMinutes * MINUTE <= asOf.getTime()
}

function resolveDrive(sample: SampleRecord): RouteOutcome {
  const drive = sample.inputs.drive
  if (!drive) return { unresolved: 'no drive-around reading' }
  return { arrivalAt: new Date(Date.parse(sample.now) + drive.minutes * MINUTE).toISOString(), caughtSailing: null }
}

// Latest drive-up space count for a sailing, from runs taken before `before`
function lastSpaceReading(all: SampleRecord[], name: FerryRouteName, departure: string, before: number): number | null {
  const target = Date.parse(departure)
  const runs = all
    .filter(s => Date.parse(s.now) < before)
    .sort((a, b) => Date.parse(b.now) - Date.parse(a.now))
  for (const run of runs) {
    const reading = run.inputs.ferries[name].spaces.find(
      sp => Math.abs(Date.parse(sp.departure) - target) <= RESOLVER.spaceMatchMinutes * MINUTE
    )
    if (reading) return reading.driveUpSpaceCount
  }
  return null
}

function nearestRun(all: SampleRecord[], time: number): SampleRecord | null {
  let best: SampleRecord | null = null
  let bestDiff = RESOLVER.nearbyRunMinutes * MINUTE
  for (const run of all) {
    const diff = Math.abs(Date.parse(run.now) - time)
    if (diff <= bestDiff) {
      best = run
      bestDiff = diff
    }
  }
  return best
}

function resolveFerry(sample: SampleRecord, name: FerryRouteName, all: SampleRecord[], history: HistoryRow[]): RouteOutcome {
  const ferry = sample.inputs.ferries[name]
  if (ferry.driveToTerminalMinutes === null) return { unresolved: 'no drive to terminal' }
  if (!ferry.schedule) return { unresolved: 'no schedule' }

  const terminalArrival = Date.parse(sample.now) + ferry.driveToTerminalMinutes * MINUTE
  const boardBy = terminalArrival + RESOLVER.boardingBufferMinutes * MINUTE
  const sailings = [...ferry.schedule]
    .sort((a, b) => Date.parse(a.departure) - Date.parse(b.departure))
    .filter(s => Date.parse(s.departure) >= terminalArrival - RESOLVER.lookbackMinutes * MINUTE)

  for (const sailing of sailings) {
    const scheduled = Date.parse(sailing.departure)
    const row = history.find(h =>
      normalizeVessel(h.vessel) === normalizeVessel(sailing.vesselName) &&
      Math.abs(Date.parse(h.scheduledDepart) - scheduled) <= RESOLVER.historyMatchMinutes * MINUTE
    )
    if (!row?.actualDepart) {
      if (scheduled <= boardBy) continue // couldn't have caught it anyway
      return { unresolved: `no vessel history for ${sailing.vesselName} ${sailing.departure}` }
    }

    const actual = Date.parse(row.actualDepart)
    if (actual <= boardBy) continue
    if (lastSpaceReading(all, name, sailing.departure, terminalArrival) === 0) continue

    const crossing = row.estArrival
      ? Date.parse(row.estArrival) - actual
      : RESOLVER.fallbackCrossingMinutes[name] * MINUTE
    const landed = actual + crossing
    const homeLeg = nearestRun(all, landed)?.inputs.ferries[name].homeLegs.find(leg => leg.departAt === null)
    if (!homeLeg) return { unresolved: 'no sample run near arrival' }

    return {
      arrivalAt: new Date(landed + homeLeg.minutes * MINUTE).toISOString(),
      caughtSailing: sailing.departure,
    }
  }

  return { unresolved: 'no sailing caught' }
}

export function resolveSample(sample: SampleRecord, allSamples: SampleRecord[], history: HistoryRow[]): Outcome {
  const routes: Record<RouteName, RouteOutcome> = {
    DRIVE: resolveDrive(sample),
    BAINBRIDGE: resolveFerry(sample, 'BAINBRIDGE', allSamples, history),
    KINGSTON: resolveFerry(sample, 'KINGSTON', allSamples, history),
  }

  let observedBest: RouteName | null = null
  let bestTime = Infinity
  for (const name of ['DRIVE', ...FERRY_ROUTES] as RouteName[]) {
    const outcome = routes[name]
    if ('arrivalAt' in outcome && Date.parse(outcome.arrivalAt) < bestTime) {
      bestTime = Date.parse(outcome.arrivalAt)
      observedBest = name
    }
  }

  return { sampleId: sample.sampleId, routes, observedBest }
}
```

- [ ] **Step 4: Run resolver tests**

Run: `npm test -- eval/resolver && npx tsc --noEmit`
Expected: PASS; tsc exits 0.

- [ ] **Step 5: Create `eval/fetchSamples.ts`**

```ts
// npm run eval:fetch — copy the sampler's samples.jsonl from the droplet
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'

const REMOTE = 'fhwrdh@159.223.202.42:ferrytimer/data/samples.jsonl'
const LOCAL = 'eval/data/samples.jsonl'

mkdirSync('eval/data', { recursive: true })
execFileSync('scp', ['-q', REMOTE, LOCAL], { stdio: 'inherit' })
const lines = readFileSync(LOCAL, 'utf8').trim().split('\n').filter(Boolean).length
console.log(`fetched ${lines} samples into ${LOCAL}`)
```

- [ ] **Step 6: Create `eval/resolve.ts`**

```ts
// npm run eval:resolve — resolve settled samples into eval/data/outcomes.jsonl
// using WSDOT vessel history (free; key from .env.local).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseWsdotDate } from '../src/api/ferries'
import type { SampleRecord } from '../src/sampler/runSample'
import { pacificClock } from '../src/sampler/window'
import { isResolvable, normalizeVessel, resolveSample, type HistoryRow } from './resolver'

const SAMPLES = 'eval/data/samples.jsonl'
const OUTCOMES = 'eval/data/outcomes.jsonl'

interface VesselHistoryResponse {
  Vessel: string
  ScheduledDepart: string | null
  ActualDepart: string | null
  EstArrival: string | null
}

const iso = (value: string | null) => (value ? parseWsdotDate(value).toISOString() : null)

async function fetchHistory(vessel: string, day: string, key: string): Promise<HistoryRow[]> {
  const name = vessel.replace(/\s+/g, '')
  const url = `https://www.wsdot.wa.gov/ferries/api/vessels/rest/vesselhistory/${encodeURIComponent(name)}/${day}/${day}?apiaccesscode=${key}`
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`vesselhistory ${name} ${day}: ${response.status}`)
  const rows = await response.json() as VesselHistoryResponse[]
  return rows.flatMap(r => (r.ScheduledDepart
    ? [{ vessel: r.Vessel, scheduledDepart: iso(r.ScheduledDepart) as string, actualDepart: iso(r.ActualDepart), estArrival: iso(r.EstArrival) }]
    : []))
}

async function main() {
  const key = process.env.WSDOT_API_KEY
  if (!key) throw new Error('WSDOT_API_KEY is not set (run via npm run eval:resolve)')
  if (!existsSync(SAMPLES)) throw new Error(`${SAMPLES} not found; run npm run eval:fetch first`)

  const samples = readFileSync(SAMPLES, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as SampleRecord)
  const asOf = new Date()
  const due = samples.filter(s => isResolvable(s, asOf))

  const vessels = new Map<string, string>()
  const days = new Set<string>()
  for (const s of due) {
    days.add(pacificClock(new Date(s.now)).day)
    for (const route of ['BAINBRIDGE', 'KINGSTON'] as const) {
      for (const sailing of s.inputs.ferries[route].schedule ?? []) {
        vessels.set(normalizeVessel(sailing.vesselName), sailing.vesselName)
      }
    }
  }

  const history: HistoryRow[] = []
  for (const vessel of vessels.values()) {
    for (const day of days) {
      try {
        history.push(...await fetchHistory(vessel, day, key))
      } catch (error) {
        console.log(`  skipped history: ${(error as Error).message}`)
      }
    }
  }

  const outcomes = due.map(s => resolveSample(s, samples, history))
  writeFileSync(OUTCOMES, outcomes.map(o => JSON.stringify(o)).join('\n') + (outcomes.length ? '\n' : ''))

  const reasons = new Map<string, number>()
  const resolved = { DRIVE: 0, BAINBRIDGE: 0, KINGSTON: 0 }
  for (const o of outcomes) {
    for (const name of ['DRIVE', 'BAINBRIDGE', 'KINGSTON'] as const) {
      const r = o.routes[name]
      if ('arrivalAt' in r) resolved[name]++
      else reasons.set(r.unresolved.replace(/ for .*/, ''), (reasons.get(r.unresolved.replace(/ for .*/, '')) ?? 0) + 1)
    }
  }
  const schema2 = samples.filter(s => (s.schemaVersion ?? 1) >= 2).length
  console.log(`samples ${samples.length} (schema v2: ${schema2}), settled and resolved: ${outcomes.length}`)
  console.log(`vessel history rows: ${history.length} for ${vessels.size} vessels`)
  console.log(`resolved routes — DRIVE ${resolved.DRIVE}, BAINBRIDGE ${resolved.BAINBRIDGE}, KINGSTON ${resolved.KINGSTON}`)
  for (const [reason, count] of reasons) console.log(`  unresolved: ${reason} × ${count}`)
  console.log(`wrote ${OUTCOMES}`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
```

- [ ] **Step 7: Scripts and ignore rules**

In `package.json` `scripts`, add:
```json
"eval": "tsx eval/run.ts",
"eval:baseline": "tsx eval/run.ts --baseline",
"eval:fetch": "tsx eval/fetchSamples.ts",
"eval:resolve": "tsx --env-file=.env.local eval/resolve.ts"
```

Append to `.gitignore`:
```
# Eval data pulled from the droplet and resolved locally
eval/data/
```

- [ ] **Step 8: Real run against live data (WSDOT only, no Google)**

```bash
npm run eval:fetch && npm run eval:resolve
```
Expected: `fetched N samples`, then counts. Samples settle 3.5 h after they are taken, so an afternoon run may resolve few or zero; that is acceptable. Paste the raw output into the report. If `eval:fetch` is blocked by permissions, report it and continue (it is a read-only copy; the controller will handle it).

Note: `eval/run.ts` does not exist yet, so `npm run eval` is not run in this task.

- [ ] **Step 9: Full tests, type check, commit**

Run: `npm test && npx tsc --noEmit`

```bash
git add eval/resolver.ts eval/resolver.test.ts eval/resolve.ts eval/fetchSamples.ts package.json .gitignore
git commit -m "feat(eval): resolve samples into observed arrivals from vessel history

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TpNTLAPaGY8E3AoB3NZVyG"
```

---

### Task 4: Scorecard runner and baseline

**Files:**
- Create: `eval/run.ts`

**Interfaces:**
- Consumes: `planRoutes` (Task 1); `planRoutesV0` (`src/lib/routePlan.v0.ts`); `SampleRecord`; `HANDCRAFTED`, `HANDCRAFTED_PARAMS`; everything from `eval/score.ts` (Task 2).
- Produces: `npm run eval` (exit 0 pass / 1 fail) and `npm run eval:baseline` writing `eval/baseline.json`.

- [ ] **Step 1: Create `eval/run.ts`**

```ts
// npm run eval            score v1: guardrails, tune detail, holdout totals, gates
// npm run eval:baseline   score frozen v0 and write eval/baseline.json (human step)

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { planRoutes } from '../src/lib/routePlan'
import { planRoutesV0 } from '../src/lib/routePlan.v0'
import type { SampleRecord } from '../src/sampler/runSample'
import { HANDCRAFTED, HANDCRAFTED_PARAMS } from './scenarios/handcrafted'
import {
  checkHandcrafted,
  gateAgainstBaseline,
  isHoldout,
  predictionFromPlan,
  predictionFromV0,
  ROUTE_NAMES,
  scoreSet,
  worstMisses,
  type Baseline,
  type Outcome,
  type Prediction,
  type ScoredRow,
  type SetMetrics,
} from './score'

const SAMPLES = 'eval/data/samples.jsonl'
const OUTCOMES = 'eval/data/outcomes.jsonl'
const BASELINE = 'eval/baseline.json'

// Files that define the truth or the guardrails. Changing them can make a
// score look better without the algorithm getting better.
const PROTECTED = [
  'eval/scenarios/handcrafted.ts',
  'eval/baseline.json',
  'eval/score.ts',
  'eval/resolver.ts',
  'src/lib/routePlan.v0.ts',
  'src/lib/fixtures.ts',
]

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as T)
}

function warnOnProtectedChanges() {
  try {
    const changed = execFileSync('git', ['status', '--porcelain', '--', ...PROTECTED], { encoding: 'utf8' }).trim()
    if (changed) {
      console.log('\n!!! WARNING: protected eval files have uncommitted changes:')
      console.log(changed)
      console.log('!!! Scores below are not trustworthy until a human reviews these changes.\n')
    }
  } catch {
    console.log('(could not run git status to check protected files)')
  }
}

const fmt = (n: number | null) => (n === null ? '—' : n.toFixed(1))
const pct = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`)
const clock = (iso: string) => iso.slice(11, 16) + 'Z'

function printSet(title: string, m: SetMetrics, base: SetMetrics | undefined, detail: boolean) {
  console.log(`\n${title}  (samples ${m.samples}, unresolved routes ${m.unresolved})`)
  if (detail) {
    for (const name of ROUTE_NAMES) {
      const r = m.routes[name]
      const b = base?.routes[name]
      console.log(
        `  ${name.padEnd(11)} n=${String(r.n).padStart(3)}  MAE ${fmt(r.meanAbsError)}m` +
        `${b ? ` (v0 ${fmt(b.meanAbsError)})` : ''}  bias ${fmt(r.meanSignedError)}m  p90 ${fmt(r.p90AbsError)}m`
      )
    }
  }
  const o = m.overall
  console.log(
    `  ${'OVERALL'.padEnd(11)} n=${String(o.n).padStart(3)}  MAE ${fmt(o.meanAbsError)}m` +
    `${base ? ` (v0 ${fmt(base.overall.meanAbsError)})` : ''}  bias ${fmt(o.meanSignedError)}m`
  )
  console.log(
    `  winner matches observed best: ${m.winner.agree}/${m.winner.n} (${pct(m.winner.rate)})` +
    `${base ? ` (v0 ${pct(base.winner.rate)})` : ''}`
  )
}

function scoreSamples(predict: (sample: SampleRecord) => Prediction) {
  const samples = readJsonl<SampleRecord>(SAMPLES)
  const outcomes = new Map(readJsonl<Outcome>(OUTCOMES).map(o => [o.sampleId, o]))
  const tune: ScoredRow[] = []
  const holdout: ScoredRow[] = []
  let errors = 0

  for (const sample of samples) {
    const outcome = outcomes.get(sample.sampleId)
    if (!outcome) continue
    try {
      const row = { prediction: predict(sample), outcome }
      ;(isHoldout(sample.sampleId) ? holdout : tune).push(row)
    } catch (error) {
      errors++
      console.log(`  error planning ${sample.sampleId}: ${(error as Error).message}`)
    }
  }

  return { tune, holdout, errors, samples: samples.length, outcomes: outcomes.size }
}

const predictV1 = (s: SampleRecord) => predictionFromPlan(planRoutes(s.inputs))
const predictV0 = (s: SampleRecord) => predictionFromV0(planRoutesV0(s.inputs).routes, s.inputs.now)

function writeBaseline() {
  const scored = scoreSamples(predictV0)
  const baseline: Baseline = {
    generatedAt: new Date().toISOString(),
    tune: scoreSet(scored.tune),
    holdout: scoreSet(scored.holdout),
  }
  writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + '\n')
  printSet('v0 baseline: tune', baseline.tune, undefined, true)
  printSet('v0 baseline: holdout', baseline.holdout, undefined, false)
  console.log(`\nwrote ${BASELINE}`)
}

function runEval() {
  warnOnProtectedChanges()
  let failed = false

  console.log('Handcrafted guardrails (frozen parameters)')
  for (const scenario of HANDCRAFTED) {
    const failures = checkHandcrafted(planRoutes(scenario.inputs, HANDCRAFTED_PARAMS, scenario.bias ?? 0), scenario.expect)
    console.log(`  ${failures.length ? 'FAIL' : 'pass'}  ${scenario.name}`)
    for (const failure of failures) console.log(`          ${failure}`)
    if (failures.length) failed = true
  }

  const baseline = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline) : null
  const scored = scoreSamples(predictV1)
  console.log(`\nSamples ${scored.samples}, resolved outcomes ${scored.outcomes}, planning errors ${scored.errors}`)
  if (scored.errors) failed = true

  const tune = scoreSet(scored.tune)
  const holdout = scoreSet(scored.holdout)
  printSet('v1 tune set (detail)', tune, baseline?.tune, true)

  const misses = worstMisses(scored.tune, 5)
  if (misses.length) {
    console.log('\n  largest tune misses (predicted − observed):')
    for (const miss of misses) {
      console.log(
        `    ${miss.errorMinutes >= 0 ? '+' : ''}${miss.errorMinutes.toFixed(0)}m  ${miss.route.padEnd(10)} ${miss.sampleId}` +
        `  predicted ${clock(miss.predicted)} observed ${clock(miss.observed)}` +
        `${miss.caughtSailing ? `  caught ${clock(miss.caughtSailing)}` : ''}`
      )
    }
  }

  printSet('v1 holdout set (totals only)', holdout, baseline?.holdout, false)

  if (baseline) {
    const gates = gateAgainstBaseline(holdout, baseline)
    for (const gate of gates) console.log(`GATE FAIL: ${gate}`)
    if (gates.length) failed = true
  } else {
    console.log('\nNo eval/baseline.json yet. A human runs: npm run eval:baseline')
  }

  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS')
  process.exitCode = failed ? 1 : 0
}

if (process.argv.includes('--baseline')) writeBaseline()
else runEval()
```

- [ ] **Step 2: Type check and run on whatever data exists**

Run: `npx tsc --noEmit && npm test`
Then run: `npm run eval`
Expected: guardrails all `pass`; sample sections may show `n=0` if nothing has settled yet; `No eval/baseline.json yet` message; `RESULT: PASS`; exit code 0.

Then run: `npm run eval:baseline && npm run eval`
Expected: baseline written; second eval shows `(v0 …)` columns and `RESULT: PASS` (v1 vs v0 may differ; gates may fail only if v1 is genuinely worse — if a gate fails, do NOT change code or data; report the numbers).

Do not commit `eval/baseline.json` in this task (it is regenerated tonight on the full data set by a human decision); leave it untracked.

- [ ] **Step 3: Commit**

```bash
git add eval/run.ts
git commit -m "feat(eval): scorecard runner with baseline, holdout gates and tamper warning

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TpNTLAPaGY8E3AoB3NZVyG"
```

---

### Task 5: Tuning skill

**Files:**
- Create: `.claude/skills/tune-route-plan/SKILL.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `npm run eval`, `npm test`, `src/lib/routePlan.ts` `PARAMS`, protected file list from `eval/run.ts`.
- Produces: a project skill named `tune-route-plan`.

- [ ] **Step 1: Let `.claude/skills/` be committed**

In `.gitignore`, replace the line `.claude` with:
```
.claude/*
!.claude/skills/
```
Run: `git check-ignore -q .claude/skills/tune-route-plan/SKILL.md; echo $?` — Expected: `1` (not ignored). Run: `git check-ignore -q .claude/settings.local.json; echo $?` — Expected: `0` (still ignored).

- [ ] **Step 2: Create `.claude/skills/tune-route-plan/SKILL.md`**

```markdown
---
name: tune-route-plan
description: Use when asked to improve Ferry Timer's route recommendations or arrival estimates against real sampled data. Runs the eval harness loop - measure, hypothesize, change routePlan.ts, re-measure - with guardrails against overfitting and against editing the tests.
---

# Tune the route plan against the eval

You are improving `src/lib/routePlan.ts` (algorithm v1) using an objective
scorecard built from real trips the sampler recorded. The score is only
meaningful if the truth and the guardrails stay fixed, so the rules below are
strict.

## What you may change

- `src/lib/routePlan.ts`, including `PARAMS` and the rule logic.
- `src/lib/routePlan.test.ts`, only to add tests for new behavior or update
  tests whose expected values follow directly from a PARAMS change you made
  and explained.

## What you must never change

- `eval/scenarios/handcrafted.ts`, `eval/score.ts`, `eval/resolver.ts`
- `eval/baseline.json`, anything in `eval/data/`
- `src/lib/routePlan.v0.ts`, `src/lib/fixtures.ts`

If a guardrail fails, the algorithm is wrong, not the guardrail. If you believe
a guardrail or the resolver itself is wrong, stop and tell the human why. Do
not work around it.

## The loop

1. **Measure.** Run `npm run eval`. Read:
   - the tune set per-route MAE and **bias** (predicted − observed; positive
     means we predict arriving later than reality),
   - the largest tune misses, including which sailing was actually caught,
   - the holdout totals and whether any gate failed.
   Note the numbers you start from.
2. **Hypothesize.** Before editing, write one sentence naming a systematic
   error and its likely cause, tied to the data. Examples:
   - "Kingston bias is −6m across 20 samples: crossings take longer than 30m."
   - "Misses cluster where the caught sailing is later than predicted: the
     boarding buffer is too short for Colman at rush hour."
   Prefer changes that explain many samples over ones that fix one miss.
3. **Change one thing.** Make the smallest change that tests the hypothesis.
4. **Verify.** Run `npm test` then `npm run eval`.
5. **Decide.**
   - Keep the change only if: all tests pass, every guardrail passes,
     `RESULT: PASS`, and holdout MAE or holdout winner agreement improved
     without the other getting worse.
   - Otherwise revert it (`git checkout -- src/lib/routePlan.ts`) and record
     what you learned.
6. **Commit kept changes** with a message stating the hypothesis and the
   before/after holdout numbers.
7. Repeat up to 5 hypotheses, then stop and summarize.

## Overfitting discipline

- Holdout detail is hidden on purpose. Do not try to infer individual holdout
  samples; tune on the tune set's evidence.
- With few samples, a 1-2 minute MAE change can be noise. Say so when it is.
- Never add special cases keyed to specific times, dates, or sample IDs.

## Report at the end

A short table: hypothesis, change, tune MAE before/after, holdout MAE
before/after, winner agreement before/after, kept or reverted. Then one
paragraph on what the data says about where the algorithm is still weak.
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore .claude/skills/tune-route-plan/SKILL.md
git commit -m "feat: tune-route-plan skill for the eval-driven agent loop

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TpNTLAPaGY8E3AoB3NZVyG"
```

---

### Task 6: App uses v1 with timed home legs

**Files:**
- Modify: `src/api/routes.ts`, `src/hooks/useRouteCalculation.ts`

**Interfaces:**
- Consumes: `planRoutes`, `selectHomeLegTimes` (Task 1).
- Produces: `DriveOptions.departAt?: Date`; hook returns v1 `PlannedRoute[]` (a superset of `RouteOption`), public hook interface unchanged.

- [ ] **Step 1: Add `departAt` to `src/api/routes.ts`**

In `interface DriveOptions`, add after `avoidFerries`:
```ts
  // Price the drive for a future start time; omit for traffic right now.
  // Google rejects times in the past.
  departAt?: Date
```
In `getDriveRoute`'s request `body`, add after `routeModifiers: {...},`:
```ts
    departureTime: options.departAt?.toISOString(),
```

- [ ] **Step 2: Switch the hook to v1 with a second fetch stage**

In `src/hooks/useRouteCalculation.ts`:

1. Replace `import { planRoutesV0 } from '../lib/routePlan.v0'` with:
```ts
import { planRoutes, selectHomeLegTimes } from '../lib/routePlan'
import type { FerryRouteName } from '../lib/planInputs'
```
2. Replace the comment above `liveHomeLeg` with:
```ts
// Live traffic right now (departAt null). The plan falls back to this leg when
// the timed price for a sailing's landing can't be fetched.
```
3. Replace `const plan = planRoutesV0(inputs)` with:
```ts
      // Stage 2: price the drive home at each chosen sailing's landing time
      const landings = selectHomeLegTimes(inputs)
      const arrivalTerminals: Record<FerryRouteName, Location> = {
        BAINBRIDGE: TERMINAL_LOCATIONS[TERMINALS.BAINBRIDGE],
        KINGSTON: TERMINAL_LOCATIONS[TERMINALS.KINGSTON],
      }
      const timedRequests = (['BAINBRIDGE', 'KINGSTON'] as const).flatMap(name =>
        landings[name].map(departAt => ({ name, departAt }))
      )
      const timedLegs = await Promise.allSettled(
        timedRequests.map(({ name, departAt }) =>
          getDriveTimeMinutes(arrivalTerminals[name], homeLocation, { departAt: new Date(departAt) })
        )
      )
      timedLegs.forEach((leg, i) => {
        if (fulfilled(leg)) {
          const { name, departAt } = timedRequests[i]
          inputs.ferries[name].homeLegs.push({ departAt, minutes: leg.value })
        }
      })

      const plan = planRoutes(inputs)
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: all pass; build exits 0.

Run: `npm run eval`
Expected: `RESULT: PASS` (the hook change does not affect the eval; this confirms nothing else moved).

- [ ] **Step 4: Commit**

```bash
git add src/api/routes.ts src/hooks/useRouteCalculation.ts
git commit -m "feat: app plans routes with v1 and prices the drive home at landing

The ferry routes now roll past full boats, keep a fallback sailing when the
next boat is nearly full, and price the drive home for when the boat lands.
The vessel ETA parsing fix also makes real-time delay adjustment take effect
for the first time, so recommendations can differ from before.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TpNTLAPaGY8E3AoB3NZVyG"
```

---

### Task 7: Browser check and gated app deploy (controller, not a subagent)

This task is run by the controller session with the user, because it needs a real browser and an explicit deploy approval.

- [ ] **Step 1:** `npm run dev` in the worktree; open it in a real browser (Playwright or Chrome tools). Pin a Seattle start point via the start point picker; confirm three routes render with sailing times and a "home by" time, no console errors, and the network panel shows the stage-2 `/api/routes` calls. This costs about 9 Google calls.
- [ ] **Step 2:** Confirm `npm test`, `npx tsc --noEmit`, `npm run build`, and `npm run eval` (with a baseline present) all pass on the branch head.
- [ ] **Step 3:** Ask the user for deploy approval, stating: what changes for users, rollback command (`git checkout 1310704 -- . && npm run deploy` from a clean checkout of main, or redeploy main), and that `deploy.sh` also re-syncs the sampler bundle.
- [ ] **Step 4:** On approval, `npm run deploy`; verify `https://ferry.fhwrdh.net/` returns 200, `/api/health` ok, and load the live app once in the browser.

---

## Rehearsal (after Task 7, not a plan task)

At about 21:30 PDT: `npm run eval:fetch && npm run eval:resolve && npm run eval:baseline`, commit `eval/baseline.json`, then invoke the `tune-route-plan` skill in a fresh session and let it run the loop.
