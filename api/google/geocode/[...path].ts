import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { path } = req.query
  const pathString = Array.isArray(path) ? path.join('/') : path || ''

  // Build the Google Geocoding API URL
  const queryString = req.url?.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''
  const url = `https://maps.googleapis.com/maps/api/geocode/${pathString}${queryString}`

  try {
    const response = await fetch(url, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
      },
    })

    const data = await response.json()
    res.status(response.status).json(data)
  } catch (error) {
    console.error('Google Geocode proxy error:', error)
    res.status(500).json({ error: 'Failed to fetch from Google Geocoding API' })
  }
}
