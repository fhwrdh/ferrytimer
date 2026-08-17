import type { VercelRequest, VercelResponse } from '@vercel/node'
import { allowRequest } from './_guard'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!allowRequest(req, res, 40)) return

  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'Google Maps API key not configured' })
  }

  const { address, latlng } = req.query

  let url: string
  if (address) {
    const addressStr = Array.isArray(address) ? address[0] : address
    url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addressStr)}&key=${apiKey}`
  } else if (latlng) {
    const latlngStr = Array.isArray(latlng) ? latlng[0] : latlng
    url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${encodeURIComponent(latlngStr)}&key=${apiKey}`
  } else {
    return res.status(400).json({ error: 'Address or latlng parameter required' })
  }

  try {
    const response = await fetch(url)
    const data = await response.json()
    res.status(response.status).json(data)
  } catch (error) {
    console.error('Google Geocode proxy error:', error)
    res.status(500).json({ error: 'Failed to fetch from Google Geocoding API' })
  }
}
