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
