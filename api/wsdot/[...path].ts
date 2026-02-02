import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const apiKey = process.env.WSDOT_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'WSDOT API key not configured' })
  }

  const { path } = req.query
  const pathString = Array.isArray(path) ? path.join('/') : path || ''

  // Build the WSDOT URL, injecting the API key
  const originalQuery = req.url?.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''
  const separator = originalQuery ? '&' : '?'
  const url = `https://www.wsdot.wa.gov/ferries/api/${pathString}${originalQuery}${separator}apiaccesscode=${apiKey}`

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
