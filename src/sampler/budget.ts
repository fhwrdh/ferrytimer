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
