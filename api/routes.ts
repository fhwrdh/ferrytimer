import type { VercelRequest, VercelResponse } from '@vercel/node'
import { allowRequest } from './_guard.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!allowRequest(req, res, 40)) return

  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'Google Maps API key not configured' })
  }

  const url = 'https://routes.googleapis.com/directions/v2:computeRoutes'

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': req.headers['x-goog-fieldmask'] as string || 'routes.duration',
      },
      body: JSON.stringify(req.body),
    })

    const data = await response.json()
    res.status(response.status).json(data)
  } catch (error) {
    console.error('Google Routes proxy error:', error)
    res.status(500).json({ error: 'Failed to fetch from Google Routes API' })
  }
}
