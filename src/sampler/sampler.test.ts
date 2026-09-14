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
