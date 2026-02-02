import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { path } = req.query
  const pathString = Array.isArray(path) ? path.join('/') : path || ''

  // Build the WSDOT URL
  const url = `https://www.wsdot.wa.gov/ferries/api/${pathString}${req.url?.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''}`

  try {
    const response = await fetch(url, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
      },
    })

    const data = await response.text()

    // Forward the response
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json')
    res.status(response.status).send(data)
  } catch (error) {
    console.error('WSDOT proxy error:', error)
    res.status(500).json({ error: 'Failed to fetch from WSDOT API' })
  }
}
