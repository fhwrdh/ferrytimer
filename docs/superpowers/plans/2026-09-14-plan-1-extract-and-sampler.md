# Plan 1: Extract Route Plan v0 and Ship the Sampler

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull the current routing math out of the React hook into a pure, tested `planRoutesV0`, fix the vessel ETA parsing bug, and deploy a cron sampler on the droplet that records replayable inputs every 20 minutes.

**Architecture:** WSDOT response parsing becomes pure exported functions in `src/api/ferries.ts`. A JSON-serializable `PlanInputs` type captures everything the algorithm needs; `planRoutesV0(inputs)` reproduces today's behavior from it, and the hook just gathers inputs. The sampler lives in `src/sampler/` (type-checked with the app), is bundled by esbuild to `server/dist/sampler.mjs`, and runs from cron with the same env file as pm2.

**Tech Stack:** TypeScript, React 18, Vite 7, vitest 5, esbuild 0.28, Node 22 on the droplet, Debian cron, pm2.

**Spec:** `docs/superpowers/specs/2026-09-14-route-plan-eval-harness-design.md`

## Global Constraints

- No LLM calls anywhere in runtime or sampler code.
- App behavior must be unchanged by Tasks 2–3 except the ETA fix in Task 1.
- Sampler: two origins (Downtown, Northgate), cron every 20 min, runs only 06:00–21:00 America/Los_Angeles (inclusive).
- Sampler Google Routes hard stop: 650 calls per Pacific day.
- Candidate sailings per ferry route: 3.
- Server runtime stays dependency-free: only the bundled `server/dist/sampler.mjs` and plain `.mjs`/`.sh` files ship.
- Home coordinates never enter git: server env `HOME_LAT`, `HOME_LNG` only. `data/` is gitignored.
- Droplet host is `fhwrdh@159.223.202.42` (from `scripts/deploy.sh`). Never SSH as root.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01TpNTLAPaGY8E3AoB3NZVyG
  ```

## File Map

| File | Status | Responsibility |
|---|---|---|
| `vitest.config.ts` | create | Test runner config, node environment |
| `src/api/ferries.ts` | modify | Export pure parsers; fix ETA parsing |
| `src/api/ferries.test.ts` | create | Parser tests |
| `src/lib/planInputs.ts` | create | JSON-serializable algorithm inputs |
| `src/lib/routePlan.v0.ts` | create | Today's algorithm as a pure function |
| `src/lib/routePlan.v0.test.ts` | create | Characterization tests |
| `src/hooks/useRouteCalculation.ts` | modify | Fetch, build `PlanInputs`, call v0 |
| `src/sampler/window.ts` | create | Pacific clock and sampling window |
| `src/sampler/budget.ts` | create | Daily Routes call budget |
| `src/sampler/candidates.ts` | create | Candidate sailing selection |
| `src/sampler/sampler.test.ts` | create | Tests for window, budget, candidates |
| `src/sampler/upstream.ts` | create | Server-side Google/WSDOT clients |
| `src/sampler/upstream.test.ts` | create | Request shape and parsing tests |
| `src/sampler/runSample.ts` | create | One sampling run → records |
| `src/sampler/runSample.test.ts` | create | Orchestration tests with fake upstream |
| `src/sampler/main.ts` | create | Env, files, logging entry point |
| `server/run-sampler.sh` | create | Cron wrapper that loads `ferrytimer.env` |
| `scripts/deploy.sh` | modify | Build and ship the sampler |
| `package.json` | modify | `test`, `build:sampler` scripts; dev deps |
| `.gitignore` | modify | Ignore `data/` |

---

### Task 1: Test runner, pure WSDOT parsers, ETA fix

**Files:**
- Create: `vitest.config.ts`, `src/api/ferries.test.ts`
- Modify: `package.json`, `src/api/ferries.ts`

**Interfaces:**
- Produces:
  - `parseWsdotDate(value: string): Date`
  - `parseScheduleToday(data: ScheduleTodayResponse): Array<{ departureTime: Date; arrivalTime: Date; vesselName: string }>`
  - `parseSailingSpace(data: TerminalSailingSpaceResponse, arrivalTerminalId?: number): SailingSpace[]`
  - `parseVesselLocations(data: unknown): VesselLocation[]`
  - exported interfaces `ScheduleTodayResponse`, `TerminalSailingSpaceResponse`, `VesselLocationResponse`

- [ ] **Step 1: Install dev dependencies and add scripts**

Run:
```bash
npm install -D vitest@5.0.0 @types/node@22.20.2 esbuild@0.28.2
```

In `package.json` `scripts`, add:
```json
"test": "vitest run",
"build:sampler": "esbuild src/sampler/main.ts --bundle --platform=node --format=esm --target=node22 --outfile=server/dist/sampler.mjs"
```

Create `vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
```

- [ ] **Step 2: Write failing parser tests**

Create `src/api/ferries.test.ts`:
```ts
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `parseScheduleToday`, `parseSailingSpace`, `parseVesselLocations` are not exported (and `parseWsdotDate` is not exported).

- [ ] **Step 4: Implement the parsers in `src/api/ferries.ts`**

1. Change `function parseWsdotDate` to `export function parseWsdotDate`.
2. Add `export` to the three response interfaces: `TerminalSailingSpaceResponse`, `VesselLocationResponse`, `ScheduleTodayResponse`.
3. Add these functions (place them after `parseWsdotDate`'s interfaces, before the fetchers):

```ts
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
```

4. Make the fetchers use them. In `getTerminalSailingSpace`, replace everything from `const data: TerminalSailingSpaceResponse = await response.json()` through the end of the `.map(...)` return with:
```ts
    const data: TerminalSailingSpaceResponse = await response.json()
    return parseSailingSpace(data)
```
In `getVesselLocations`, replace the `if (!Array.isArray(data)) {...}` block and the final `return data.map(...)` with:
```ts
  return parseVesselLocations(data)
```
and change `let data: VesselLocationResponse[]` to `let data: unknown`.
In `getScheduleToday`, replace everything after `const data: ScheduleTodayResponse = await response.json()` with:
```ts
  return parseScheduleToday(data)
```

- [ ] **Step 5: Run tests and type check**

Run: `npm test && npx tsc --noEmit`
Expected: all `ferries.test.ts` tests PASS; tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/api/ferries.ts src/api/ferries.test.ts
git commit -m "fix: parse vessel ETA from WSDOT date format

new Date() on /Date(ms-0700)/ is Invalid Date, so the real-time delay
adjustment never applied. Parsers are now pure exported functions with
tests, and vitest is set up.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TpNTLAPaGY8E3AoB3NZVyG"
```

---

### Task 2: `PlanInputs` and `planRoutesV0` with characterization tests

**Files:**
- Create: `src/lib/planInputs.ts`, `src/lib/routePlan.v0.ts`, `src/lib/routePlan.v0.test.ts`

**Interfaces:**
- Consumes: `CROSSING_TIMES` from `src/api/ferries.ts`; `RouteOption`, `RiskLevel` from `src/types.ts`.
- Produces (`src/lib/planInputs.ts`):
  ```ts
  export type FerryRouteName = 'BAINBRIDGE' | 'KINGSTON'
  export interface RecordedSailing { departure: string; arrival: string; vesselName: string }
  export interface RecordedSpace { departure: string; driveUpSpaceCount: number; totalSpaces: number }
  export interface RecordedVessel { vesselName: string; eta: string | null }
  export interface HomeLeg { departAt: string | null; minutes: number }
  export interface FerryInputs {
    driveToTerminalMinutes: number | null
    schedule: RecordedSailing[] | null
    spaces: RecordedSpace[]
    homeLegs: HomeLeg[]
  }
  export interface PlanInputs {
    now: string
    drive: { minutes: number; summary: string | null } | null
    vessels: RecordedVessel[]
    ferries: Record<FerryRouteName, FerryInputs>
  }
  ```
  All times are ISO 8601 strings. `HomeLeg.departAt === null` means priced with live traffic at `now`.
- Produces (`src/lib/routePlan.v0.ts`):
  `export function planRoutesV0(inputs: PlanInputs): { routes: RouteOption[]; warnings: string[] }`

- [ ] **Step 1: Create `src/lib/planInputs.ts`**

```ts
// Everything the route algorithm needs, as plain JSON. The app builds this
// from live fetches; the sampler records it; the eval replays it. Times are
// ISO 8601 strings so a record survives JSON.stringify unchanged.

export type FerryRouteName = 'BAINBRIDGE' | 'KINGSTON'

export interface RecordedSailing {
  departure: string
  arrival: string
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
```

- [ ] **Step 2: Write failing characterization tests**

Create `src/lib/routePlan.v0.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { planRoutesV0 } from './routePlan.v0'
import type { FerryInputs, PlanInputs } from './planInputs'

const NOW = '2026-09-14T17:00:00.000Z'
const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString()

function ferry(overrides: Partial<FerryInputs> = {}): FerryInputs {
  return {
    driveToTerminalMinutes: 20,
    schedule: [
      { departure: at(40), arrival: at(75), vesselName: 'Wenatchee' },
      { departure: at(90), arrival: at(125), vesselName: 'Tacoma' },
    ],
    spaces: [],
    homeLegs: [{ departAt: null, minutes: 30 }],
    ...overrides,
  }
}

function inputs(ferries: Partial<PlanInputs['ferries']> = {}, overrides: Partial<PlanInputs> = {}): PlanInputs {
  return {
    now: NOW,
    drive: { minutes: 100, summary: 'I-5 S and WA-16 W' },
    vessels: [],
    ferries: {
      BAINBRIDGE: ferry(),
      KINGSTON: ferry({ driveToTerminalMinutes: 30 }),
      ...ferries,
    },
    ...overrides,
  }
}

const byName = (plan: ReturnType<typeof planRoutesV0>, name: string) =>
  plan.routes.find(r => r.name === name)!

describe('planRoutesV0', () => {
  it('sorts routes by total time', () => {
    const plan = planRoutesV0(inputs())
    expect(plan.routes.map(r => [r.name, r.totalTimeMinutes])).toEqual([
      ['DRIVE', 100],
      ['BAINBRIDGE', 105], // 20 drive + 20 wait + 35 crossing + 30 home
      ['KINGSTON', 150],   // 30 drive + 60 wait + 30 crossing + 30 home
    ])
    expect(plan.warnings).toEqual([])
  })

  it('describes the drive-around route', () => {
    const drive = byName(planRoutesV0(inputs()), 'DRIVE')
    expect(drive).toMatchObject({
      type: 'drive-around',
      driveFromTerminalMinutes: 100,
      driveSummary: 'I-5 S and WA-16 W',
      risks: { timingRisk: null, spaceRisk: null, overall: 'low' },
    })
  })

  it('records sailings inside the boarding buffer as missed', () => {
    // Kingston: arrive at +30, buffer to +40; the +40 sailing is not strictly after
    const kingston = byName(planRoutesV0(inputs()), 'KINGSTON')
    expect(kingston.missedSailings).toEqual([new Date(at(40))])
    expect(kingston.nextDeparture).toEqual(new Date(at(90)))
    expect(kingston.waitTimeMinutes).toBe(60)
  })

  it('rates 10-19 minutes at the dock as medium timing risk', () => {
    const plan = planRoutesV0(inputs({
      BAINBRIDGE: ferry({ schedule: [{ departure: at(35), arrival: at(70), vesselName: 'Wenatchee' }] }),
    }))
    expect(byName(plan, 'BAINBRIDGE').risks).toEqual({ timingRisk: 'medium', spaceRisk: null, overall: 'medium' })
  })

  it('matches sailing space within 5 minutes and rates under 10 spaces high risk', () => {
    const plan = planRoutesV0(inputs({
      BAINBRIDGE: ferry({ spaces: [{ departure: at(42), driveUpSpaceCount: 5, totalSpaces: 150 }] }),
    }))
    const bainbridge = byName(plan, 'BAINBRIDGE')
    expect(bainbridge.spacesAvailable).toBe(5)
    expect(bainbridge.canMakeNextFerry).toBe(true)
    expect(bainbridge.risks).toEqual({ timingRisk: 'low', spaceRisk: 'high', overall: 'high' })
  })

  it('makes a full next sailing unreachable instead of rolling forward', () => {
    const plan = planRoutesV0(inputs({
      BAINBRIDGE: ferry({ spaces: [{ departure: at(40), driveUpSpaceCount: 0, totalSpaces: 150 }] }),
    }))
    const bainbridge = byName(plan, 'BAINBRIDGE')
    expect(bainbridge.totalTimeMinutes).toBe(Infinity)
    expect(bainbridge.canMakeNextFerry).toBe(false)
    expect(bainbridge.nextDeparture).toEqual(new Date(at(40)))
  })

  it('pushes departure to vessel ETA plus 15 minutes when later than scheduled', () => {
    const plan = planRoutesV0(inputs({}, { vessels: [{ vesselName: 'WENATCHEE', eta: at(35) }] }))
    const bainbridge = byName(plan, 'BAINBRIDGE')
    expect(bainbridge.nextDeparture).toEqual(new Date(at(50)))
    expect(bainbridge.totalTimeMinutes).toBe(115)
  })

  it('ignores a vessel ETA that still makes the scheduled departure', () => {
    const plan = planRoutesV0(inputs({}, { vessels: [{ vesselName: 'Wenatchee', eta: at(10) }] }))
    expect(byName(plan, 'BAINBRIDGE').nextDeparture).toEqual(new Date(at(40)))
  })

  it('marks a route with no remaining sailings as unreachable and high risk', () => {
    const plan = planRoutesV0(inputs({ BAINBRIDGE: ferry({ schedule: [] }) }))
    const bainbridge = byName(plan, 'BAINBRIDGE')
    expect(bainbridge.totalTimeMinutes).toBe(Infinity)
    expect(bainbridge.nextDeparture).toBeNull()
    expect(bainbridge.risks.overall).toBe('high')
  })

  it('uses the live home leg and ignores timed ones', () => {
    const plan = planRoutesV0(inputs({
      BAINBRIDGE: ferry({ homeLegs: [{ departAt: at(75), minutes: 55 }, { departAt: null, minutes: 30 }] }),
    }))
    expect(byName(plan, 'BAINBRIDGE').driveFromTerminalMinutes).toBe(30)
  })

  it('drops a route and warns when required data is missing', () => {
    const plan = planRoutesV0(inputs(
      {
        BAINBRIDGE: ferry({ schedule: null }),
        KINGSTON: ferry({ homeLegs: [{ departAt: at(75), minutes: 55 }] }),
      },
      { drive: null },
    ))
    expect(plan.routes).toEqual([])
    expect(plan.warnings).toEqual([
      'Driving time unavailable',
      'Bainbridge route unavailable',
      'Kingston route unavailable',
    ])
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- src/lib`
Expected: FAIL — cannot resolve `./routePlan.v0`.

- [ ] **Step 4: Implement `src/lib/routePlan.v0.ts`**

```ts
// The route algorithm as it shipped before the eval harness, extracted
// verbatim so it can be scored as the baseline. Do not tune this file;
// improvements go in routePlan.ts.

import type { RiskLevel, RouteOption } from '../types'
import type { FerryInputs, FerryRouteName, PlanInputs, RecordedVessel } from './planInputs'
import { CROSSING_TIMES } from '../api/ferries'

// Loading time after vessel arrives at dock (minutes)
const VESSEL_LOADING_TIME = 15
// Arrive this many minutes before departure to count as making the boat
const BUFFER_MINUTES = 10

const CROSSING_MINUTES: Record<FerryRouteName, number> = {
  BAINBRIDGE: CROSSING_TIMES.SEATTLE_BAINBRIDGE,
  KINGSTON: CROSSING_TIMES.EDMONDS_KINGSTON,
}

const LABELS: Record<FerryRouteName, string> = {
  BAINBRIDGE: 'Bainbridge',
  KINGSTON: 'Kingston',
}

const FERRY_ROUTES: FerryRouteName[] = ['BAINBRIDGE', 'KINGSTON']

export function planRoutesV0(inputs: PlanInputs): { routes: RouteOption[]; warnings: string[] } {
  const now = new Date(inputs.now)
  const routes: RouteOption[] = []
  const warnings: string[] = []

  // Driving option - always low risk (predictable, no waiting)
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
    })
  } else {
    warnings.push('Driving time unavailable')
  }

  for (const name of FERRY_ROUTES) {
    const ferry = inputs.ferries[name]
    const liveHomeLeg = ferry.homeLegs.find(leg => leg.departAt === null)
    if (ferry.driveToTerminalMinutes !== null && ferry.schedule !== null && liveHomeLeg) {
      routes.push(calculateFerryRoute(name, now, ferry, liveHomeLeg.minutes, inputs.vessels))
    } else {
      warnings.push(`${LABELS[name]} route unavailable`)
    }
  }

  routes.sort((a, b) => a.totalTimeMinutes - b.totalTimeMinutes)

  return { routes, warnings }
}

function assessTimingRisk(waitMinutes: number | null): RiskLevel | null {
  if (waitMinutes === null) return null
  if (waitMinutes < 10) return 'high'      // Very tight
  if (waitMinutes < 20) return 'medium'    // Cutting it close
  return 'low'                              // Comfortable buffer
}

function assessSpaceRisk(spaces: number | null): RiskLevel | null {
  if (spaces === null) return null
  if (spaces < 10) return 'high'           // Might not get on
  if (spaces < 30) return 'medium'         // Getting tight
  return 'low'                              // Plenty of room
}

function calculateOverallRisk(timing: RiskLevel | null, space: RiskLevel | null): RiskLevel {
  const risks = [timing, space].filter(Boolean) as RiskLevel[]
  if (risks.includes('high')) return 'high'
  if (risks.includes('medium')) return 'medium'
  return 'low'
}

function calculateFerryRoute(
  name: FerryRouteName,
  now: Date,
  ferry: FerryInputs,
  driveFromTerminal: number,
  vessels: RecordedVessel[]
): RouteOption {
  const driveToTerminal = ferry.driveToTerminalMinutes as number
  const crossingTime = CROSSING_MINUTES[name]
  const arrivalAtTerminal = new Date(now.getTime() + driveToTerminal * 60 * 1000)
  const cutoffTime = new Date(arrivalAtTerminal.getTime() + BUFFER_MINUTES * 60 * 1000)

  // Adjust scheduled departures based on real-time vessel locations
  const adjustedSchedule = (ferry.schedule ?? []).map(sailing => {
    const departureTime = new Date(sailing.departure)
    const vessel = vessels.find(v => v.vesselName.toLowerCase() === sailing.vesselName.toLowerCase())

    // If vessel has an ETA (meaning it's not at the dock yet),
    // the actual departure will be delayed
    if (vessel?.eta) {
      const estimatedDeparture = new Date(new Date(vessel.eta).getTime() + VESSEL_LOADING_TIME * 60 * 1000)
      if (estimatedDeparture > departureTime) {
        return { departureTime: estimatedDeparture, isDelayed: true }
      }
    }

    return { departureTime, isDelayed: false }
  })

  const missedSailings = adjustedSchedule
    .filter(s => s.departureTime <= cutoffTime && s.departureTime > now)
    .map(s => s.departureTime)

  const nextSailing = adjustedSchedule.find(s => s.departureTime > cutoffTime)

  if (!nextSailing) {
    return {
      name,
      type: 'ferry',
      totalTimeMinutes: Infinity,
      driveToTerminalMinutes: driveToTerminal,
      waitTimeMinutes: null,
      ferryTimeMinutes: crossingTime,
      driveFromTerminalMinutes: driveFromTerminal,
      nextDeparture: null,
      spacesAvailable: null,
      canMakeNextFerry: false,
      missedSailings,
      driveSummary: null,
      risks: { timingRisk: null, spaceRisk: null, overall: 'high' },
    }
  }

  const spaceInfo = ferry.spaces.find(
    s => Math.abs(new Date(s.departure).getTime() - nextSailing.departureTime.getTime()) < 5 * 60 * 1000
  )

  const spacesAvailable = spaceInfo?.driveUpSpaceCount ?? null
  const canMakeIt = spacesAvailable === null || spacesAvailable > 0

  const waitTime = Math.max(
    0,
    Math.round((nextSailing.departureTime.getTime() - arrivalAtTerminal.getTime()) / 60000)
  )

  const totalTime = driveToTerminal + waitTime + crossingTime + driveFromTerminal

  const timingRisk = assessTimingRisk(waitTime)
  const spaceRisk = assessSpaceRisk(spacesAvailable)
  const overallRisk = calculateOverallRisk(timingRisk, spaceRisk)

  return {
    name,
    type: 'ferry',
    totalTimeMinutes: canMakeIt ? totalTime : Infinity,
    driveToTerminalMinutes: driveToTerminal,
    waitTimeMinutes: waitTime,
    ferryTimeMinutes: crossingTime,
    driveFromTerminalMinutes: driveFromTerminal,
    nextDeparture: nextSailing.departureTime,
    spacesAvailable,
    canMakeNextFerry: canMakeIt,
    missedSailings,
    driveSummary: null,
    risks: { timingRisk, spaceRisk, overall: overallRisk },
  }
}
```

- [ ] **Step 5: Run tests and type check**

Run: `npm test && npx tsc --noEmit`
Expected: all tests PASS; tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/planInputs.ts src/lib/routePlan.v0.ts src/lib/routePlan.v0.test.ts
git commit -m "refactor: extract route algorithm as pure planRoutesV0

Characterization tests pin current behavior so the eval baseline and
later fixes compare against exactly what shipped.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TpNTLAPaGY8E3AoB3NZVyG"
```

---

### Task 3: Hook builds `PlanInputs` and calls v0

**Files:**
- Modify: `src/hooks/useRouteCalculation.ts`

**Interfaces:**
- Consumes: `PlanInputs`, `RecordedSailing`, `RecordedSpace`, `HomeLeg` from `src/lib/planInputs.ts`; `planRoutesV0` from `src/lib/routePlan.v0.ts`.
- Produces: `useRouteCalculation` with an unchanged public result type.

- [ ] **Step 1: Replace the file**

Replace `src/hooks/useRouteCalculation.ts` entirely with:
```ts
import { useState, useEffect, useCallback } from 'react'
import type { Location, RouteOption, SailingSpace } from '../types'
import {
  getTerminalSailingSpace,
  getScheduleToday,
  getVesselLocations,
  TERMINALS,
  TERMINAL_LOCATIONS,
} from '../api/ferries'
import { getDriveMinutesAndSummary, getDriveTimeMinutes } from '../api/routes'
import type { HomeLeg, PlanInputs, RecordedSailing, RecordedSpace } from '../lib/planInputs'
import { planRoutesV0 } from '../lib/routePlan.v0'

interface UseRouteCalculationProps {
  currentLocation: Location | null
  homeLocation: Location | null
}

interface UseRouteCalculationResult {
  routes: RouteOption[]
  bestRoute: RouteOption | null
  isLoading: boolean
  error: string | null
  warnings: string[]
  refresh: () => void
}

type Schedule = Awaited<ReturnType<typeof getScheduleToday>>

// A route is only dropped when data it can't be computed without is missing,
// so one flaky upstream service doesn't take out the whole comparison.
function fulfilled<T>(result: PromiseSettledResult<T>): result is PromiseFulfilledResult<T> {
  return result.status === 'fulfilled'
}

function valueOr<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return fulfilled(result) ? result.value : fallback
}

function minutesOrNull(result: PromiseSettledResult<number>): number | null {
  return fulfilled(result) ? result.value : null
}

function toSailings(result: PromiseSettledResult<Schedule>): RecordedSailing[] | null {
  if (!fulfilled(result)) return null
  return result.value.map(s => ({
    departure: s.departureTime.toISOString(),
    arrival: s.arrivalTime.toISOString(),
    vesselName: s.vesselName,
  }))
}

function toSpaces(result: PromiseSettledResult<SailingSpace[]>): RecordedSpace[] {
  return valueOr(result, []).map(s => ({
    departure: s.departureTime.toISOString(),
    driveUpSpaceCount: s.driveUpSpaceCount,
    totalSpaces: s.totalSpaces,
  }))
}

// The app prices the drive home with live traffic, hence departAt null
function liveHomeLeg(result: PromiseSettledResult<number>): HomeLeg[] {
  return fulfilled(result) ? [{ departAt: null, minutes: result.value }] : []
}

// Check if two locations are very close (within ~500m)
function isNearby(loc1: Location, loc2: Location): boolean {
  const latDiff = Math.abs(loc1.lat - loc2.lat)
  const lngDiff = Math.abs(loc1.lng - loc2.lng)
  // ~0.005 degrees ≈ 500m at Seattle's latitude
  return latDiff < 0.005 && lngDiff < 0.005
}

export function useRouteCalculation({
  currentLocation,
  homeLocation,
}: UseRouteCalculationProps): UseRouteCalculationResult {
  const [routes, setRoutes] = useState<RouteOption[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])

  const calculate = useCallback(async () => {
    if (!currentLocation || !homeLocation) {
      setRoutes([]) // Clear stale results when location is cleared
      setWarnings([])
      return
    }

    // Check if already at home
    if (isNearby(currentLocation, homeLocation)) {
      setRoutes([])
      setWarnings([])
      setError('You\'re already home.')
      return
    }

    setIsLoading(true)
    setError(null)
    setWarnings([])

    try {
      const now = new Date()

      const [
        driveToSeattle,
        driveToEdmonds,
        driveFromBainbridge,
        driveFromKingston,
        // Straight home without boarding a boat
        driveNoFerry,
        seattleSpaces,
        edmondsSpaces,
        seattleSchedule,
        edmondsSchedule,
        vesselLocations,
      ] = await Promise.allSettled([
        getDriveTimeMinutes(currentLocation, TERMINAL_LOCATIONS[TERMINALS.SEATTLE]),
        getDriveTimeMinutes(currentLocation, TERMINAL_LOCATIONS[TERMINALS.EDMONDS]),
        getDriveTimeMinutes(TERMINAL_LOCATIONS[TERMINALS.BAINBRIDGE], homeLocation),
        getDriveTimeMinutes(TERMINAL_LOCATIONS[TERMINALS.KINGSTON], homeLocation),
        getDriveMinutesAndSummary(currentLocation, homeLocation, { avoidFerries: true }),
        getTerminalSailingSpace(TERMINALS.SEATTLE),
        getTerminalSailingSpace(TERMINALS.EDMONDS),
        getScheduleToday(TERMINALS.SEATTLE, TERMINALS.BAINBRIDGE, true),
        getScheduleToday(TERMINALS.EDMONDS, TERMINALS.KINGSTON, true),
        getVesselLocations(),
      ])

      const inputs: PlanInputs = {
        now: now.toISOString(),
        drive: fulfilled(driveNoFerry) ? driveNoFerry.value : null,
        // Vessel positions and sailing space are refinements - degrade to empty
        vessels: valueOr(vesselLocations, []).map(v => ({
          vesselName: v.vesselName,
          eta: v.eta ? v.eta.toISOString() : null,
        })),
        ferries: {
          BAINBRIDGE: {
            driveToTerminalMinutes: minutesOrNull(driveToSeattle),
            schedule: toSailings(seattleSchedule),
            spaces: toSpaces(seattleSpaces),
            homeLegs: liveHomeLeg(driveFromBainbridge),
          },
          KINGSTON: {
            driveToTerminalMinutes: minutesOrNull(driveToEdmonds),
            schedule: toSailings(edmondsSchedule),
            spaces: toSpaces(edmondsSpaces),
            homeLegs: liveHomeLeg(driveFromKingston),
          },
        },
      }

      const plan = planRoutesV0(inputs)

      if (plan.routes.length === 0) {
        setRoutes([])
        setError('Could not reach the routing services. Try again in a moment.')
        return
      }

      setRoutes(plan.routes)
      setWarnings(plan.warnings)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setIsLoading(false)
    }
  }, [currentLocation, homeLocation])

  useEffect(() => {
    calculate()
  }, [calculate])

  const bestRoute = routes.length > 0 ? routes[0] : null

  return {
    routes,
    bestRoute,
    isLoading,
    error,
    warnings,
    refresh: calculate,
  }
}
```

- [ ] **Step 2: Type check, test, build**

Run: `npm test && npm run build`
Expected: tests PASS; `tsc && vite build` exits 0 with no unused-import errors.

- [ ] **Step 3: Smoke test in the browser**

Run: `npm run dev`, open the printed URL, and use the existing start point picker to pin a Seattle location. Expected: three routes render as before, no console errors. This costs about 6 Google calls. Stop the dev server afterwards.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useRouteCalculation.ts
git commit -m "refactor: route hook gathers PlanInputs and delegates to v0

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TpNTLAPaGY8E3AoB3NZVyG"
```

---

### Task 4: Sampler window, budget, candidate sailings

**Files:**
- Create: `src/sampler/window.ts`, `src/sampler/budget.ts`, `src/sampler/candidates.ts`, `src/sampler/sampler.test.ts`

**Interfaces:**
- Consumes: `RecordedSailing` from `src/lib/planInputs.ts`.
- Produces:
  - `pacificClock(date: Date): { day: string; minutes: number }` — `day` is `YYYY-MM-DD` Pacific, `minutes` since Pacific midnight
  - `inSamplingWindow(date: Date): boolean`
  - `DAILY_ROUTES_LIMIT = 650`
  - `interface BudgetState { day: string; used: number }`
  - `interface BudgetStore { load(): BudgetState | null; save(state: BudgetState): void }`
  - `class RoutesBudget { constructor(store: BudgetStore, day: string, limit?: number); readonly used: number; canSpend(calls: number): boolean; spend(calls: number): void }`
  - `candidateSailings(schedule: RecordedSailing[], earliestDeparture: Date, count?: number): RecordedSailing[]`

- [ ] **Step 1: Write failing tests**

Create `src/sampler/sampler.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { inSamplingWindow, pacificClock } from './window'
import { DAILY_ROUTES_LIMIT, RoutesBudget, type BudgetState, type BudgetStore } from './budget'
import { candidateSailings } from './candidates'

describe('pacificClock', () => {
  it('reports the Pacific day and minutes after midnight', () => {
    // 04:30 UTC on the 15th is 21:30 PDT on the 14th
    expect(pacificClock(new Date('2026-09-15T04:30:00Z'))).toEqual({ day: '2026-09-14', minutes: 21 * 60 + 30 })
  })
})

describe('inSamplingWindow', () => {
  it('opens at 06:00 Pacific', () => {
    expect(inSamplingWindow(new Date('2026-09-14T12:59:00Z'))).toBe(false)
    expect(inSamplingWindow(new Date('2026-09-14T13:00:00Z'))).toBe(true)
  })

  it('includes the 21:00 run and closes after it', () => {
    expect(inSamplingWindow(new Date('2026-09-15T04:00:30Z'))).toBe(true)
    expect(inSamplingWindow(new Date('2026-09-15T04:01:00Z'))).toBe(false)
  })
})

function memoryStore(initial: BudgetState | null): BudgetStore & { saved: BudgetState | null } {
  return {
    saved: initial,
    load() { return this.saved },
    save(state) { this.saved = state },
  }
}

describe('RoutesBudget', () => {
  it('starts at zero on a new day', () => {
    const budget = new RoutesBudget(memoryStore({ day: '2026-09-13', used: 600 }), '2026-09-14')
    expect(budget.used).toBe(0)
  })

  it('carries usage within the same day', () => {
    const budget = new RoutesBudget(memoryStore({ day: '2026-09-14', used: 600 }), '2026-09-14')
    expect(budget.used).toBe(600)
    expect(budget.canSpend(50)).toBe(true)
    expect(budget.canSpend(51)).toBe(false)
  })

  it('persists spending', () => {
    const store = memoryStore(null)
    const budget = new RoutesBudget(store, '2026-09-14')
    budget.spend(14)
    expect(store.saved).toEqual({ day: '2026-09-14', used: 14 })
  })

  it('defaults to a 650 call limit', () => {
    expect(DAILY_ROUTES_LIMIT).toBe(650)
  })
})

describe('candidateSailings', () => {
  const sailing = (departure: string) => ({ departure, arrival: departure, vesselName: 'X' })
  const schedule = [
    sailing('2026-09-14T18:00:00.000Z'),
    sailing('2026-09-14T17:00:00.000Z'),
    sailing('2026-09-14T19:00:00.000Z'),
    sailing('2026-09-14T20:00:00.000Z'),
    sailing('2026-09-14T21:00:00.000Z'),
  ]

  it('returns the first sailings strictly after the earliest departure, in order', () => {
    const picks = candidateSailings(schedule, new Date('2026-09-14T17:00:00.000Z'), 3)
    expect(picks.map(s => s.departure)).toEqual([
      '2026-09-14T18:00:00.000Z',
      '2026-09-14T19:00:00.000Z',
      '2026-09-14T20:00:00.000Z',
    ])
  })

  it('returns fewer when the schedule runs out', () => {
    expect(candidateSailings(schedule, new Date('2026-09-14T20:30:00.000Z'))).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/sampler`
Expected: FAIL — modules `./window`, `./budget`, `./candidates` not found.

- [ ] **Step 3: Implement**

Create `src/sampler/window.ts`:
```ts
// The droplet runs UTC and Debian cron has no dependable CRON_TZ, so cron
// fires all day and the sampler decides for itself whether it's in hours.

const PACIFIC = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const WINDOW_START_MINUTES = 6 * 60
const WINDOW_END_MINUTES = 21 * 60

export function pacificClock(date: Date): { day: string; minutes: number } {
  const parts = Object.fromEntries(PACIFIC.formatToParts(date).map(p => [p.type, p.value]))
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  }
}

export function inSamplingWindow(date: Date): boolean {
  const { minutes } = pacificClock(date)
  return minutes >= WINDOW_START_MINUTES && minutes <= WINDOW_END_MINUTES
}
```

Create `src/sampler/budget.ts`:
```ts
// Google Routes is capped at 1,000 calls a day for the whole project, and
// the live app spends from the same pool. The sampler stops itself well short.

export const DAILY_ROUTES_LIMIT = 650

export interface BudgetState {
  day: string
  used: number
}

export interface BudgetStore {
  load(): BudgetState | null
  save(state: BudgetState): void
}

export class RoutesBudget {
  private state: BudgetState

  constructor(
    private readonly store: BudgetStore,
    day: string,
    private readonly limit = DAILY_ROUTES_LIMIT
  ) {
    const saved = store.load()
    this.state = saved?.day === day ? saved : { day, used: 0 }
  }

  get used(): number {
    return this.state.used
  }

  canSpend(calls: number): boolean {
    return this.state.used + calls <= this.limit
  }

  spend(calls: number): void {
    this.state = { ...this.state, used: this.state.used + calls }
    this.store.save(this.state)
  }
}
```

Create `src/sampler/candidates.ts`:
```ts
import type { RecordedSailing } from '../lib/planInputs'

// The sampler prices the drive home for several upcoming sailings, not just
// the one today's algorithm would pick, so a replay still has the price when
// a changed algorithm picks a different boat.
export function candidateSailings(
  schedule: RecordedSailing[],
  earliestDeparture: Date,
  count = 3
): RecordedSailing[] {
  return [...schedule]
    .sort((a, b) => Date.parse(a.departure) - Date.parse(b.departure))
    .filter(s => Date.parse(s.departure) > earliestDeparture.getTime())
    .slice(0, count)
}
```

- [ ] **Step 4: Run tests and type check**

Run: `npm test && npx tsc --noEmit`
Expected: PASS; tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/sampler/window.ts src/sampler/budget.ts src/sampler/candidates.ts src/sampler/sampler.test.ts
git commit -m "feat(sampler): sampling window, Routes budget, candidate sailings

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TpNTLAPaGY8E3AoB3NZVyG"
```

---

### Task 5: Server-side upstream clients

**Files:**
- Create: `src/sampler/upstream.ts`, `src/sampler/upstream.test.ts`

**Interfaces:**
- Consumes: `parseScheduleToday`, `parseSailingSpace`, `parseVesselLocations` from `src/api/ferries.ts`; `RecordedSailing`, `RecordedSpace`, `RecordedVessel` from `src/lib/planInputs.ts`; `Location` from `src/types.ts`.
- Produces:
  ```ts
  export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>
  export interface DriveResult { minutes: number; summary: string | null }
  export interface DriveRequest { avoidFerries?: boolean; departAt?: Date }
  export interface Upstream {
    drive(origin: Location, destination: Location, request?: DriveRequest): Promise<DriveResult>
    schedule(departingId: number, arrivingId: number): Promise<RecordedSailing[]>
    spaces(departingId: number, arrivingId: number): Promise<RecordedSpace[]>
    vessels(): Promise<RecordedVessel[]>
  }
  export function makeUpstream(keys: { wsdot: string; google: string }, fetchImpl?: FetchLike): Upstream
  ```

- [ ] **Step 1: Write failing tests**

Create `src/sampler/upstream.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/sampler/upstream`
Expected: FAIL — module `./upstream` not found.

- [ ] **Step 3: Implement `src/sampler/upstream.ts`**

```ts
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
```

- [ ] **Step 4: Run tests and type check**

Run: `npm test && npx tsc --noEmit`
Expected: PASS; tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/sampler/upstream.ts src/sampler/upstream.test.ts
git commit -m "feat(sampler): direct Google Routes and WSDOT clients

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TpNTLAPaGY8E3AoB3NZVyG"
```

---

### Task 6: One sampling run

**Files:**
- Create: `src/sampler/runSample.ts`, `src/sampler/runSample.test.ts`

**Interfaces:**
- Consumes: `Upstream`, `DriveRequest`, `DriveResult` (Task 5); `RoutesBudget` (Task 4); `candidateSailings` (Task 4); `PlanInputs`, `HomeLeg`, `RecordedSailing` (Task 2); `TERMINALS`, `TERMINAL_LOCATIONS` from `src/api/ferries.ts`.
- Produces:
  ```ts
  export interface Origin { id: string; label: string; location: Location }
  export const ORIGINS: Origin[]
  export const CANDIDATES_PER_ROUTE = 3
  export function maxRoutesCalls(originCount: number): number   // originCount * 3 + 2 + 2 * CANDIDATES_PER_ROUTE
  export interface SampleRecord { sampleId: string; origin: Origin; now: string; inputs: PlanInputs }
  export interface SampleResult { records: SampleRecord[]; routesCalls: number; skipped: 'budget' | null }
  export function runSample(args: { upstream: Upstream; home: Location; now: Date; budget: RoutesBudget; origins?: Origin[] }): Promise<SampleResult>
  ```

- [ ] **Step 1: Write failing tests**

Create `src/sampler/runSample.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { runSample, maxRoutesCalls, ORIGINS, type Origin } from './runSample'
import { RoutesBudget, type BudgetState } from './budget'
import type { DriveRequest, Upstream } from './upstream'
import type { Location } from '../types'
import { TERMINALS, TERMINAL_LOCATIONS } from '../api/ferries'

const NOW = new Date('2026-09-14T19:00:00.000Z')
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString()
const HOME = { lat: 47.65, lng: -122.69 }

const same = (a: Location, b: Location) => a.lat === b.lat && a.lng === b.lng

interface DriveCall { origin: Location; destination: Location; request?: DriveRequest }

function fakeUpstream(overrides: Partial<Upstream> = {}): Upstream & { driveCalls: DriveCall[] } {
  const driveCalls: DriveCall[] = []
  const sailings = (offsets: number[], crossing: number) =>
    offsets.map(o => ({ departure: at(o), arrival: at(o + crossing), vesselName: 'Wenatchee' }))

  return {
    driveCalls,
    async drive(origin, destination, request) {
      driveCalls.push({ origin, destination, request })
      if (request?.departAt) return { minutes: 45, summary: null }
      if (same(destination, TERMINAL_LOCATIONS[TERMINALS.SEATTLE])) {
        return { minutes: same(origin, ORIGINS[0].location) ? 10 : 25, summary: null }
      }
      if (same(destination, TERMINAL_LOCATIONS[TERMINALS.EDMONDS])) return { minutes: 30, summary: null }
      if (request?.avoidFerries) return { minutes: 110, summary: 'I-5 S and WA-16 W' }
      return { minutes: 35, summary: null }
    },
    async schedule(departingId) {
      return departingId === TERMINALS.SEATTLE
        ? sailings([5, 20, 60, 100, 140], 35)
        : sailings([40, 80, 120, 160], 30)
    },
    async spaces() {
      return [{ departure: at(20), driveUpSpaceCount: 8, totalSpaces: 202 }]
    },
    async vessels() {
      return [{ vesselName: 'Wenatchee', eta: at(12) }]
    },
    ...overrides,
  }
}

function budget(state: BudgetState | null = null) {
  let saved = state
  return new RoutesBudget({ load: () => saved, save: s => { saved = s } }, '2026-09-14')
}

describe('runSample', () => {
  it('writes one record per origin with shared ferry data', async () => {
    const result = await runSample({ upstream: fakeUpstream(), home: HOME, now: NOW, budget: budget() })

    expect(result.skipped).toBeNull()
    expect(result.records.map(r => r.sampleId)).toEqual([
      `downtown-${NOW.toISOString()}`,
      `northgate-${NOW.toISOString()}`,
    ])
    const [downtown, northgate] = result.records
    expect(downtown.inputs.now).toBe(NOW.toISOString())
    expect(downtown.inputs.drive).toEqual({ minutes: 110, summary: 'I-5 S and WA-16 W' })
    expect(downtown.inputs.ferries.BAINBRIDGE.driveToTerminalMinutes).toBe(10)
    expect(northgate.inputs.ferries.BAINBRIDGE.driveToTerminalMinutes).toBe(25)
    expect(downtown.inputs.vessels).toEqual([{ vesselName: 'Wenatchee', eta: at(12) }])
    expect(downtown.inputs.ferries.BAINBRIDGE.spaces).toEqual(northgate.inputs.ferries.BAINBRIDGE.spaces)
  })

  it('prices the home leg live and for three candidate sailings after the shortest drive', async () => {
    const upstream = fakeUpstream()
    const result = await runSample({ upstream, home: HOME, now: NOW, budget: budget() })

    // Shortest drive to Colman is 10 min, so candidates depart after +10: +20, +60, +100
    expect(result.records[0].inputs.ferries.BAINBRIDGE.homeLegs).toEqual([
      { departAt: null, minutes: 35 },
      { departAt: at(55), minutes: 45 },
      { departAt: at(95), minutes: 45 },
      { departAt: at(135), minutes: 45 },
    ])
    // Kingston: shortest drive 30 min, candidates +40, +80, +120
    expect(result.records[1].inputs.ferries.KINGSTON.homeLegs.map(l => l.departAt)).toEqual([
      null, at(70), at(110), at(150),
    ])
    const timed = upstream.driveCalls.filter(c => c.request?.departAt)
    expect(timed.every(c => same(c.destination, HOME))).toBe(true)
  })

  it('counts every Routes call it makes and spends it from the budget', async () => {
    const b = budget()
    const result = await runSample({ upstream: fakeUpstream(), home: HOME, now: NOW, budget: b })
    // 2 origins x 3 + 2 terminal-home + 6 timed
    expect(result.routesCalls).toBe(14)
    expect(b.used).toBe(14)
    expect(maxRoutesCalls(ORIGINS.length)).toBe(14)
  })

  it('skips without calling anything when the budget cannot cover a full run', async () => {
    const upstream = fakeUpstream()
    const result = await runSample({ upstream, home: HOME, now: NOW, budget: budget({ day: '2026-09-14', used: 640 }) })
    expect(result).toEqual({ records: [], routesCalls: 0, skipped: 'budget' })
    expect(upstream.driveCalls).toEqual([])
  })

  it('records a missing schedule as null and prices no timed legs for it', async () => {
    const upstream = fakeUpstream({
      async schedule(departingId) {
        if (departingId === TERMINALS.SEATTLE) throw new Error('WSDOT schedule failed: 500')
        return [{ departure: at(40), arrival: at(70), vesselName: 'Puyallup' }]
      },
    })
    const result = await runSample({ upstream, home: HOME, now: NOW, budget: budget() })
    const bainbridge = result.records[0].inputs.ferries.BAINBRIDGE
    expect(bainbridge.schedule).toBeNull()
    expect(bainbridge.homeLegs).toEqual([{ departAt: null, minutes: 35 }])
    expect(result.routesCalls).toBe(9) // 6 + 2 + 1 Kingston candidate
  })

  it('degrades failed drives and refinements instead of dropping the record', async () => {
    const base = fakeUpstream()
    const upstream = fakeUpstream({
      async drive(origin, destination, request) {
        if (request?.avoidFerries) throw new Error('Google Routes failed: 429')
        return base.drive(origin, destination, request)
      },
      async spaces() { throw new Error('WSDOT sailing space failed: 500') },
      async vessels() { throw new Error('WSDOT vessels failed: 500') },
    })
    const origins: Origin[] = [ORIGINS[0]]
    const result = await runSample({ upstream, home: HOME, now: NOW, budget: budget(), origins })
    const [record] = result.records
    expect(record.inputs.drive).toBeNull()
    expect(record.inputs.vessels).toEqual([])
    expect(record.inputs.ferries.KINGSTON.spaces).toEqual([])
    expect(record.inputs.ferries.KINGSTON.schedule).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/sampler/runSample`
Expected: FAIL — module `./runSample` not found.

- [ ] **Step 3: Implement `src/sampler/runSample.ts`**

```ts
import type { Location } from '../types'
import type { FerryInputs, FerryRouteName, HomeLeg, PlanInputs, RecordedSailing } from '../lib/planInputs'
import { TERMINALS, TERMINAL_LOCATIONS } from '../api/ferries'
import type { DriveRequest, DriveResult, Upstream } from './upstream'
import type { RoutesBudget } from './budget'
import { candidateSailings } from './candidates'

export interface Origin {
  id: string
  label: string
  location: Location
}

export const ORIGINS: Origin[] = [
  { id: 'downtown', label: 'Downtown (Westlake)', location: { lat: 47.6114, lng: -122.3374 } },
  { id: 'northgate', label: 'Northgate', location: { lat: 47.7063, lng: -122.3255 } },
]

export const CANDIDATES_PER_ROUTE = 3

// Per origin: to Colman, to Edmonds, drive around. Shared: two terminal-home
// legs live, plus timed home legs for each route's candidate sailings.
export function maxRoutesCalls(originCount: number): number {
  return originCount * 3 + 2 + 2 * CANDIDATES_PER_ROUTE
}

export interface SampleRecord {
  sampleId: string
  origin: Origin
  now: string
  inputs: PlanInputs
}

export interface SampleResult {
  records: SampleRecord[]
  routesCalls: number
  skipped: 'budget' | null
}

const FERRY_ROUTES: Array<{
  name: FerryRouteName
  departing: number
  arriving: number
}> = [
  { name: 'BAINBRIDGE', departing: TERMINALS.SEATTLE, arriving: TERMINALS.BAINBRIDGE },
  { name: 'KINGSTON', departing: TERMINALS.EDMONDS, arriving: TERMINALS.KINGSTON },
]

function valueOr<T, F>(result: PromiseSettledResult<T>, fallback: F): T | F {
  return result.status === 'fulfilled' ? result.value : fallback
}

export async function runSample({
  upstream,
  home,
  now,
  budget,
  origins = ORIGINS,
}: {
  upstream: Upstream
  home: Location
  now: Date
  budget: RoutesBudget
  origins?: Origin[]
}): Promise<SampleResult> {
  if (!budget.canSpend(maxRoutesCalls(origins.length))) {
    return { records: [], routesCalls: 0, skipped: 'budget' }
  }

  let routesCalls = 0
  const drive = (origin: Location, destination: Location, request?: DriveRequest): Promise<DriveResult> => {
    routesCalls++
    return upstream.drive(origin, destination, request)
  }

  // Live legs double as observations of traffic right now
  const originLegs = await Promise.all(origins.map(origin => Promise.allSettled([
    drive(origin.location, TERMINAL_LOCATIONS[TERMINALS.SEATTLE]),
    drive(origin.location, TERMINAL_LOCATIONS[TERMINALS.EDMONDS]),
    drive(origin.location, home, { avoidFerries: true }),
  ])))

  const perRoute = await Promise.all(FERRY_ROUTES.map(async (route, routeIndex) => {
    const [liveHome, schedule, spaces] = await Promise.allSettled([
      drive(TERMINAL_LOCATIONS[route.arriving], home),
      upstream.schedule(route.departing, route.arriving),
      upstream.spaces(route.departing, route.arriving),
    ])

    const homeLegs: HomeLeg[] = liveHome.status === 'fulfilled'
      ? [{ departAt: null, minutes: liveHome.value.minutes }]
      : []

    const driveMinutes = originLegs
      .map(legs => legs[routeIndex])
      .flatMap(leg => (leg.status === 'fulfilled' ? [leg.value.minutes] : []))

    if (schedule.status === 'fulfilled' && driveMinutes.length > 0) {
      const earliest = new Date(now.getTime() + Math.min(...driveMinutes) * 60_000)
      const picks: RecordedSailing[] = candidateSailings(schedule.value, earliest, CANDIDATES_PER_ROUTE)
      const timed = await Promise.allSettled(
        picks.map(s => drive(TERMINAL_LOCATIONS[route.arriving], home, { departAt: new Date(s.arrival) }))
      )
      timed.forEach((leg, i) => {
        if (leg.status === 'fulfilled') homeLegs.push({ departAt: picks[i].arrival, minutes: leg.value.minutes })
      })
    }

    return {
      schedule: valueOr(schedule, null),
      spaces: valueOr(spaces, []),
      homeLegs,
    }
  }))

  const vessels = valueOr(await Promise.allSettled([upstream.vessels()]).then(([v]) => v), [])

  budget.spend(routesCalls)

  const nowIso = now.toISOString()
  const records = origins.map((origin, originIndex): SampleRecord => {
    const [toSeattle, toEdmonds, around] = originLegs[originIndex]
    const ferry = (routeIndex: number, toTerminal: PromiseSettledResult<DriveResult>): FerryInputs => ({
      driveToTerminalMinutes: toTerminal.status === 'fulfilled' ? toTerminal.value.minutes : null,
      ...perRoute[routeIndex],
    })

    return {
      sampleId: `${origin.id}-${nowIso}`,
      origin,
      now: nowIso,
      inputs: {
        now: nowIso,
        drive: valueOr(around, null),
        vessels,
        ferries: {
          BAINBRIDGE: ferry(0, toSeattle),
          KINGSTON: ferry(1, toEdmonds),
        },
      },
    }
  })

  return { records, routesCalls, skipped: null }
}
```

Note: the three per-origin legs are ordered Seattle, Edmonds, around, and `FERRY_ROUTES` is ordered Bainbridge, Kingston, so `legs[routeIndex]` is that route's terminal leg. Keep both orders in sync.

- [ ] **Step 4: Run tests and type check**

Run: `npm test && npx tsc --noEmit`
Expected: PASS; tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/sampler/runSample.ts src/sampler/runSample.test.ts
git commit -m "feat(sampler): record replayable inputs for two origins per run

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TpNTLAPaGY8E3AoB3NZVyG"
```

---

### Task 7: Entry point, bundle, local run

**Files:**
- Create: `src/sampler/main.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `inSamplingWindow`, `pacificClock` (Task 4); `RoutesBudget`, `BudgetStore` (Task 4); `makeUpstream` (Task 5); `runSample` (Task 6).
- Produces: `server/dist/sampler.mjs` (gitignored build output) accepting `--force` to ignore the sampling window. Env: `WSDOT_API_KEY`, `GOOGLE_MAPS_API_KEY`, `HOME_LAT`, `HOME_LNG`, `DATA_DIR`. Writes `DATA_DIR/samples.jsonl` and `DATA_DIR/routes-budget.json`.

- [ ] **Step 1: Create `src/sampler/main.ts`**

```ts
// Cron entry point: node server/dist/sampler.mjs [--force]
// --force ignores the sampling window (for a manual run), never the budget.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inSamplingWindow, pacificClock } from './window'
import { RoutesBudget, type BudgetStore } from './budget'
import { makeUpstream } from './upstream'
import { runSample } from './runSample'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

function fileStore(path: string): BudgetStore {
  return {
    load: () => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null),
    save: state => writeFileSync(path, JSON.stringify(state)),
  }
}

async function main() {
  const now = new Date()
  const stamp = now.toISOString()

  if (!process.argv.includes('--force') && !inSamplingWindow(now)) {
    console.log(`${stamp} outside sampling window, skipping`)
    return
  }

  const dataDir = requireEnv('DATA_DIR')
  mkdirSync(dataDir, { recursive: true })

  const home = { lat: Number(requireEnv('HOME_LAT')), lng: Number(requireEnv('HOME_LNG')) }
  if (!Number.isFinite(home.lat) || !Number.isFinite(home.lng)) {
    throw new Error('HOME_LAT and HOME_LNG must be numbers')
  }

  const budget = new RoutesBudget(fileStore(join(dataDir, 'routes-budget.json')), pacificClock(now).day)
  const upstream = makeUpstream({ wsdot: requireEnv('WSDOT_API_KEY'), google: requireEnv('GOOGLE_MAPS_API_KEY') })

  const result = await runSample({ upstream, home, now, budget })

  if (result.skipped) {
    console.log(`${stamp} skipped: ${result.skipped} (${budget.used} Routes calls used today)`)
    return
  }

  appendFileSync(
    join(dataDir, 'samples.jsonl'),
    result.records.map(record => JSON.stringify(record) + '\n').join('')
  )
  console.log(
    `${stamp} wrote ${result.records.length} samples, ${result.routesCalls} Routes calls, ${budget.used} used today`
  )
}

main().catch(error => {
  console.error(`${new Date().toISOString()} sampler failed:`, error)
  process.exitCode = 1
})
```

- [ ] **Step 2: Ignore sampler data**

Append to `.gitignore`:
```
# Sampler data (contains home coordinates)
data/
```
(`server/dist/` is already covered by the existing `dist` rule.)

- [ ] **Step 3: Type check and bundle**

Run: `npx tsc --noEmit && npm run build:sampler && ls -la server/dist/sampler.mjs && git status --short server/`
Expected: tsc exits 0; bundle exists; `git status` shows nothing under `server/dist`.

- [ ] **Step 4: Get home coordinates from the user**

Ask the user for the home address the app uses. Geocode it once (1 Geocoding call):
```bash
set -a && . ./.env.local && set +a && curl -s "https://maps.googleapis.com/maps/api/geocode/json?address=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "<ADDRESS>")&key=$GOOGLE_MAPS_API_KEY" | node -e 'const d=JSON.parse(require("fs").readFileSync(0));const l=d.results[0].geometry.location;console.log(l.lat,l.lng, d.results[0].geometry.location_type)'
```
Expected: two numbers and `ROOFTOP` (or `RANGE_INTERPOLATED`). Do not write them to any tracked file.

- [ ] **Step 5: Run once locally into the scratchpad (about 14 Routes calls)**

```bash
set -a && . ./.env.local && set +a && HOME_LAT=<lat> HOME_LNG=<lng> DATA_DIR=/private/tmp/claude-501/-Users-stout-dev-fhwrdh-ferrytimer/61fb5f3d-3117-4b80-ac12-90a87fa0c8b1/scratchpad/sampler-data node server/dist/sampler.mjs --force
```
Expected: `... wrote 2 samples, 14 Routes calls, 14 used today` (Routes calls may be lower late in the day when fewer than 3 sailings remain).

- [ ] **Step 6: Inspect the record and replay it through v0**

```bash
DATA=/private/tmp/claude-501/-Users-stout-dev-fhwrdh-ferrytimer/61fb5f3d-3117-4b80-ac12-90a87fa0c8b1/scratchpad/sampler-data
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")[0]); const f=r.inputs.ferries; console.log(r.sampleId, r.inputs.drive, f.BAINBRIDGE.homeLegs, f.KINGSTON.homeLegs.length, r.inputs.vessels.filter(v=>v.eta).length)' "$DATA/samples.jsonl"
npx esbuild src/lib/routePlan.v0.ts --bundle --platform=node --format=esm --outfile=$DATA/v0.mjs --log-level=warning
node --input-type=module -e "import { planRoutesV0 } from '$DATA/v0.mjs'; import { readFileSync } from 'node:fs'; const r = JSON.parse(readFileSync('$DATA/samples.jsonl','utf8').trim().split('\n')[0]); console.log(planRoutesV0(r.inputs).routes.map(x => [x.name, x.totalTimeMinutes, x.nextDeparture]))"
```
Expected: a sample id, a drive with minutes, Bainbridge home legs with one `null` and up to three timed entries, and v0 printing three routes with finite minutes (a ferry route may be `Infinity` late at night). If any timed `departAt` is not an ISO string, stop and fix before deploying.

- [ ] **Step 7: Commit**

```bash
git add src/sampler/main.ts .gitignore
git commit -m "feat(sampler): cron entry point with file-backed budget

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TpNTLAPaGY8E3AoB3NZVyG"
```

---

### Task 8: Deploy and schedule on the droplet

**Files:**
- Create: `server/run-sampler.sh`
- Modify: `scripts/deploy.sh`

**Interfaces:**
- Consumes: `server/dist/sampler.mjs` from Task 7; `~/ferrytimer/server/ferrytimer.env` on the droplet.
- Produces: cron entry `*/20 * * * *` running `~/ferrytimer/server/run-sampler.sh`, logging to `~/ferrytimer/data/sampler.log`, data in `~/ferrytimer/data/`.

- [ ] **Step 1: Create `server/run-sampler.sh`**

```bash
#!/usr/bin/env bash
# Cron wrapper for the Ferry Timer sampler. Loads the same env file pm2 uses,
# so the API keys still live in exactly one place on the droplet.
set -euo pipefail
cd "$(dirname "$0")"
set -a
. ./ferrytimer.env
set +a
exec /usr/bin/node dist/sampler.mjs "$@"
```

Run: `chmod +x server/run-sampler.sh`

- [ ] **Step 2: Ship the sampler from `scripts/deploy.sh`**

After the `npm run build` line, add:
```bash
npm run build:sampler
```
Replace the `echo "==> syncing server code"` block with:
```bash
echo "==> syncing server code"
rsync -az server/server.mjs server/ecosystem.config.cjs server/run-sampler.sh "$HOST:$REMOTE/server/"
rsync -az --delete server/dist/ "$HOST:$REMOTE/server/dist/"
```

- [ ] **Step 3: Add sampler env on the droplet (values not echoed)**

```bash
ssh fhwrdh@159.223.202.42 'grep -q "^HOME_LAT=" ~/ferrytimer/server/ferrytimer.env || printf "HOME_LAT=%s\nHOME_LNG=%s\nDATA_DIR=/home/fhwrdh/ferrytimer/data\n" "<lat>" "<lng>" >> ~/ferrytimer/server/ferrytimer.env; mkdir -p ~/ferrytimer/data; grep -o "^[A-Z_]*=" ~/ferrytimer/server/ferrytimer.env'
```
Expected: `WSDOT_API_KEY= GOOGLE_MAPS_API_KEY= HOME_LAT= HOME_LNG= DATA_DIR=`. The pm2 app ignores the new variables.

- [ ] **Step 4: Deploy**

Run: `npm run deploy`
Expected: build, both rsyncs, pm2 reload, `==> done`. Then confirm the app still serves:
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://ferry.fhwrdh.net/ && ssh fhwrdh@159.223.202.42 'curl -s 127.0.0.1:3458/api/health'
```
Expected: `200` and `{"ok":true}`.

- [ ] **Step 5: Manual run on the droplet**

```bash
ssh fhwrdh@159.223.202.42 '~/ferrytimer/server/run-sampler.sh --force && wc -l ~/ferrytimer/data/samples.jsonl && cat ~/ferrytimer/data/routes-budget.json'
```
Expected: `wrote 2 samples, 14 Routes calls, 14 used today`, `2 .../samples.jsonl`, and a budget JSON whose `day` is today's Pacific date.

- [ ] **Step 6: Install the cron entry (idempotent)**

```bash
ssh fhwrdh@159.223.202.42 'LINE="*/20 * * * * /home/fhwrdh/ferrytimer/server/run-sampler.sh >> /home/fhwrdh/ferrytimer/data/sampler.log 2>&1"; (crontab -l 2>/dev/null | grep -vF "run-sampler.sh"; echo "$LINE") | crontab - && crontab -l'
```
Expected: the existing `run-backup.sh` line is still present, plus the sampler line.

- [ ] **Step 7: Verify the first scheduled run**

After the next :00, :20, or :40, run:
```bash
ssh fhwrdh@159.223.202.42 'tail -3 ~/ferrytimer/data/sampler.log; wc -l ~/ferrytimer/data/samples.jsonl'
```
Expected: a `wrote 2 samples` line with a timestamp from that slot; line count grew by 2.

- [ ] **Step 8: Commit**

```bash
git add server/run-sampler.sh scripts/deploy.sh
git commit -m "feat(sampler): deploy sampler and run it from cron

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TpNTLAPaGY8E3AoB3NZVyG"
```

---

## Out of scope (Plan 2)

Fixes 1–3 in `src/lib/routePlan.ts`, stage-2 fetching in the hook, resolver, `eval/run.ts`, baseline, handcrafted scenarios, trips endpoint and arrival card, importer, tuning skill (note `.gitignore` currently excludes `.claude`), and the app's Colman sailing-space matching including Bremerton sailings.
