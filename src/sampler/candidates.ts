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
