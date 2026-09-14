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
