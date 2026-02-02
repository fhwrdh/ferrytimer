import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { path } = req.query
  const pathString = Array.isArray(path) ? path.join('/') : path || ''

  // Build the Google Routes API URL
  const url = `https://routes.googleapis.com/${pathString}`

  try {
    const response = await fetch(url, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': req.headers['x-goog-api-key'] as string || '',
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
