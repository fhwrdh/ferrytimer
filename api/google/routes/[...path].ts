import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'Google Maps API key not configured' })
  }

  // The frontend calls /api/google/routes/directions/v2:computeRoutes
  const fullUrl = req.url || ''
  const pathMatch = fullUrl.match(/\/api\/google\/routes\/(.*)/)
  const apiPath = pathMatch ? pathMatch[1].split('?')[0] : 'directions/v2:computeRoutes'

  const url = `https://routes.googleapis.com/${apiPath}`

  try {
    const response = await fetch(url, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': req.headers['x-goog-fieldmask'] as string || '',
      },
      body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
    })

    const data = await response.json()
    res.status(response.status).json(data)
  } catch (error) {
    console.error('Google Routes proxy error:', error)
    res.status(500).json({ error: 'Failed to fetch from Google Routes API' })
  }
}
