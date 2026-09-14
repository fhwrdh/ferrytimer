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
