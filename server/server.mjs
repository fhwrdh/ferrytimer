// Standalone /api proxy for Ferry Timer, self-hosted behind nginx.
//
// Replaces the Vercel serverless functions in ../api. nginx serves the static
// dist/ and reverse-proxies /api/* to this process on 127.0.0.1:PORT. Zero
// dependencies: Node's built-in http server and the global fetch (Node 18+).
//
// Keys come from the environment (see ferrytimer.env): WSDOT_API_KEY,
// GOOGLE_MAPS_API_KEY. PORT defaults to 3458.

import { createServer } from 'node:http'

const PORT = Number(process.env.PORT) || 3458
const WSDOT_API_KEY = process.env.WSDOT_API_KEY
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY

// --- Same-origin + rate-limit guard (ported from ../api/_guard.ts) ---------

const WINDOW_MS = 60_000
const hits = new Map()

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded
  return raw?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown'
}

function hostOf(value) {
  if (!value) return null
  try {
    return new URL(value).host
  } catch {
    return null
  }
}

// Same-origin only: the browser tells us via Sec-Fetch-Site, or the
// Origin/Referer host matches the host being served. This keeps the upstream
// keys serving the app itself rather than the open internet.
function isSameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'same-origin') return true
  const host = req.headers.host
  if (!host) return false
  const claimed = hostOf(req.headers.origin) ?? hostOf(req.headers.referer)
  return claimed === host
}

function underLimit(ip, limit) {
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS)

  if (recent.length >= limit) {
    hits.set(ip, recent)
    return false
  }

  recent.push(now)
  hits.set(ip, recent)

  // Drop idle callers so the map can't grow without bound
  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (times.every((t) => now - t >= WINDOW_MS)) hits.delete(key)
    }
  }

  return true
}

// Returns true if the handler should proceed. When it returns false it has
// already sent the response.
function allowRequest(req, res, limit) {
  if (!isSameOrigin(req)) {
    sendJson(res, 403, { error: 'This endpoint only serves the Ferry Timer app.' })
    return false
  }
  if (!underLimit(clientIp(req), limit)) {
    res.setHeader('Retry-After', String(WINDOW_MS / 1000))
    sendJson(res, 429, { error: 'Too many requests. Try again in a minute.' })
    return false
  }
  return true
}

// --- Small response/request helpers ----------------------------------------

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body)
}

// Proxy an upstream fetch Response back to the client, preserving status.
async function relay(res, upstream) {
  const text = await upstream.text()
  res.writeHead(upstream.status, { 'Content-Type': 'application/json' })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// --- Route handlers (ported from ../api/*.ts) ------------------------------

async function handleRoutes(req, res) {
  if (!allowRequest(req, res, 40)) return
  if (!GOOGLE_MAPS_API_KEY) {
    return sendJson(res, 500, { error: 'Google Maps API key not configured' })
  }
  try {
    const body = await readBody(req)
    const upstream = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': req.headers['x-goog-fieldmask'] || 'routes.duration',
      },
      body,
    })
    await relay(res, upstream)
  } catch (error) {
    console.error('Google Routes proxy error:', error)
    sendJson(res, 500, { error: 'Failed to fetch from Google Routes API' })
  }
}

async function handleGeocode(req, res, query) {
  if (!allowRequest(req, res, 40)) return
  if (!GOOGLE_MAPS_API_KEY) {
    return sendJson(res, 500, { error: 'Google Maps API key not configured' })
  }
  const address = query.get('address')
  const latlng = query.get('latlng')

  let url
  if (address) {
    url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}`
  } else if (latlng) {
    url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${encodeURIComponent(latlng)}&key=${GOOGLE_MAPS_API_KEY}`
  } else {
    return sendJson(res, 400, { error: 'Address or latlng parameter required' })
  }

  try {
    await relay(res, await fetch(url))
  } catch (error) {
    console.error('Google Geocode proxy error:', error)
    sendJson(res, 500, { error: 'Failed to fetch from Google Geocoding API' })
  }
}

async function handleSchedule(req, res, query) {
  if (!allowRequest(req, res, 90)) return
  if (!WSDOT_API_KEY) {
    return sendJson(res, 500, { error: 'WSDOT API key not configured' })
  }
  const departingId = query.get('departingId')
  const arrivingId = query.get('arrivingId')
  if (!departingId || !arrivingId) {
    return sendJson(res, 400, { error: 'departingId and arrivingId parameters required' })
  }
  const onlyRemaining = query.get('onlyRemaining')
  const remaining = onlyRemaining === 'true' || onlyRemaining === '1'
  const url = `https://www.wsdot.wa.gov/ferries/api/schedule/rest/scheduletoday/${departingId}/${arrivingId}/${remaining}?apiaccesscode=${WSDOT_API_KEY}`

  try {
    await relay(res, await fetch(url))
  } catch (error) {
    console.error('WSDOT schedule error:', error)
    sendJson(res, 500, { error: 'Failed to fetch from WSDOT API' })
  }
}

async function handleSailingSpace(req, res, query) {
  if (!allowRequest(req, res, 90)) return
  if (!WSDOT_API_KEY) {
    return sendJson(res, 500, { error: 'WSDOT API key not configured' })
  }
  const terminalId = query.get('terminalId')
  if (!terminalId) {
    return sendJson(res, 400, { error: 'terminalId parameter required' })
  }
  const url = `https://www.wsdot.wa.gov/ferries/api/terminals/rest/terminalsailingspace/${terminalId}?apiaccesscode=${WSDOT_API_KEY}`

  try {
    await relay(res, await fetch(url))
  } catch (error) {
    console.error('WSDOT sailing space error:', error)
    sendJson(res, 500, { error: 'Failed to fetch from WSDOT API' })
  }
}

async function handleVessels(req, res) {
  if (!allowRequest(req, res, 90)) return
  if (!WSDOT_API_KEY) {
    return sendJson(res, 500, { error: 'WSDOT API key not configured' })
  }
  const url = `https://www.wsdot.wa.gov/ferries/api/vessels/rest/vessellocations?apiaccesscode=${WSDOT_API_KEY}`

  try {
    await relay(res, await fetch(url))
  } catch (error) {
    console.error('WSDOT vessels error:', error)
    sendJson(res, 500, { error: 'Failed to fetch from WSDOT API' })
  }
}

// --- Router ----------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname
  const query = url.searchParams

  try {
    if (path === '/api/routes') return await handleRoutes(req, res)
    if (path === '/api/geocode') return await handleGeocode(req, res, query)
    if (path === '/api/wsdot-schedule') return await handleSchedule(req, res, query)
    if (path === '/api/wsdot-sailingspace') return await handleSailingSpace(req, res, query)
    if (path === '/api/wsdot-vessels') return await handleVessels(req, res)
    if (path === '/api/health') return sendJson(res, 200, { ok: true })
    sendJson(res, 404, { error: 'Not found' })
  } catch (error) {
    console.error('Unhandled error:', error)
    sendJson(res, 500, { error: 'Internal server error' })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ferrytimer api listening on 127.0.0.1:${PORT}`)
})
