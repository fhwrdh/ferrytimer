import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const apiKey = process.env.WSDOT_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'WSDOT API key not configured' })
  }

  const { terminalId } = req.query
  if (!terminalId) {
    return res.status(400).json({ error: 'terminalId parameter required' })
  }

  const url = `https://www.wsdot.wa.gov/ferries/api/terminals/rest/terminalsailingspace/${terminalId}?apiaccesscode=${apiKey}`

  try {
    const response = await fetch(url)
    const data = await response.json()
    res.status(response.status).json(data)
  } catch (error) {
    console.error('WSDOT sailing space error:', error)
    res.status(500).json({ error: 'Failed to fetch from WSDOT API' })
  }
}
