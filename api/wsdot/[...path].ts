import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const apiKey = process.env.WSDOT_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'WSDOT API key not configured' })
  }

  // Get the full path after /api/wsdot/
  const fullUrl = req.url || ''
  const pathMatch = fullUrl.match(/\/api\/wsdot\/(.*)/)
  const apiPath = pathMatch ? pathMatch[1] : ''

  // Construct WSDOT URL
  const separator = apiPath.includes('?') ? '&' : '?'
  const url = `https://www.wsdot.wa.gov/ferries/api/${apiPath}${separator}apiaccesscode=${apiKey}`

  try {
    const response = await fetch(url, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
      },
    })

    const data = await response.text()
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json')
    res.status(response.status).send(data)
  } catch (error) {
    console.error('WSDOT proxy error:', error)
    res.status(500).json({ error: 'Failed to fetch from WSDOT API' })
  }
}
