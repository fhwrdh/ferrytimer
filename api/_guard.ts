import type { VercelRequest, VercelResponse } from '@vercel/node'

// These handlers proxy upstream APIs using our own billed keys, so they only
// serve the app itself. Files prefixed with _ are not routed by Vercel.

const WINDOW_MS = 60_000
const DEFAULT_LIMIT = 90

// Per-instance sliding window. Vercel may run several instances, so this is a
// brake on casual abuse rather than a precise global quota - the hard ceiling
// is the budget cap on the upstream key.
const hits = new Map<string, number[]>()

function clientIp(req: VercelRequest): string {
  const forwarded = req.headers['x-forwarded-for']
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded
  return raw?.split(',')[0].trim() || 'unknown'
}

function hostOf(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw) return null
  try {
    return new URL(raw).host
  } catch {
    return null
  }
}

// Same-origin only: the browser either tells us directly via Sec-Fetch-Site, or
// the Origin/Referer host matches the host being served. Comparing against the
// request's own host keeps preview deployments and localhost working without an
// allowlist to maintain.
function isSameOrigin(req: VercelRequest): boolean {
  if (req.headers['sec-fetch-site'] === 'same-origin') return true

  const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host
  if (!host) return false

  const claimed = hostOf(req.headers.origin) ?? hostOf(req.headers.referer)
  return claimed === host
}

function underLimit(ip: string, limit: number): boolean {
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter(t => now - t < WINDOW_MS)

  if (recent.length >= limit) {
    hits.set(ip, recent)
    return false
  }

  recent.push(now)
  hits.set(ip, recent)

  // Drop idle callers so the map can't grow without bound
  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (times.every(t => now - t >= WINDOW_MS)) hits.delete(key)
    }
  }

  return true
}

/**
 * Returns true if the handler should proceed. When it returns false it has
 * already sent the response.
 */
export function allowRequest(
  req: VercelRequest,
  res: VercelResponse,
  limit: number = DEFAULT_LIMIT
): boolean {
  if (!isSameOrigin(req)) {
    res.status(403).json({ error: 'This endpoint only serves the Ferry Timer app.' })
    return false
  }

  if (!underLimit(clientIp(req), limit)) {
    res.setHeader('Retry-After', String(WINDOW_MS / 1000))
    res.status(429).json({ error: 'Too many requests. Try again in a minute.' })
    return false
  }

  return true
}
