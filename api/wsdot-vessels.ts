import type { VercelRequest, VercelResponse } from '@vercel/node'
import { allowRequest } from './_guard'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!allowRequest(req, res, 90)) return

  const apiKey = process.env.WSDOT_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'WSDOT API key not configured' })
  }

  const url = `https://www.wsdot.wa.gov/ferries/api/vessels/rest/vessellocations?apiaccesscode=${apiKey}`

  try {
    const response = await fetch(url)
    const data = await response.json()
    res.status(response.status).json(data)
  } catch (error) {
    console.error('WSDOT vessels error:', error)
    res.status(500).json({ error: 'Failed to fetch from WSDOT API' })
  }
}
