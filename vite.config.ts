import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    server: {
      proxy: {
        '/api/geocode': {
          target: 'https://maps.googleapis.com',
          changeOrigin: true,
          rewrite: (path) => {
            const url = new URL(path, 'http://localhost')
            const params = url.searchParams
            params.set('key', env.GOOGLE_MAPS_API_KEY || '')
            return `/maps/api/geocode/json?${params.toString()}`
          },
        },
        '/api/routes': {
          target: 'https://routes.googleapis.com',
          changeOrigin: true,
          rewrite: () => '/directions/v2:computeRoutes',
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader('X-Goog-Api-Key', env.GOOGLE_MAPS_API_KEY || '')
            })
          },
        },
        '/api/wsdot-sailingspace': {
          target: 'https://www.wsdot.wa.gov',
          changeOrigin: true,
          rewrite: (path) => {
            const url = new URL(path, 'http://localhost')
            const terminalId = url.searchParams.get('terminalId')
            return `/ferries/api/terminals/rest/terminalsailingspace/${terminalId}?apiaccesscode=${env.WSDOT_API_KEY}`
          },
        },
        '/api/wsdot-vessels': {
          target: 'https://www.wsdot.wa.gov',
          changeOrigin: true,
          rewrite: () => `/ferries/api/vessels/rest/vessellocations?apiaccesscode=${env.WSDOT_API_KEY}`,
        },
        '/api/wsdot-schedule': {
          target: 'https://www.wsdot.wa.gov',
          changeOrigin: true,
          rewrite: (path) => {
            const url = new URL(path, 'http://localhost')
            const departingId = url.searchParams.get('departingId')
            const arrivingId = url.searchParams.get('arrivingId')
            const onlyRemaining = url.searchParams.get('onlyRemaining') === 'true'
            return `/ferries/api/schedule/rest/scheduletoday/${departingId}/${arrivingId}/${onlyRemaining}?apiaccesscode=${env.WSDOT_API_KEY}`
          },
        },
      },
    },
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        manifest: {
          name: 'Ferry Timer',
          short_name: 'FerryTimer',
          description: 'Should I take the ferry or drive around?',
          theme_color: '#0b1315',
          background_color: '#0b1315',
          display: 'standalone',
          icons: [
            {
              src: '/icon-192.png',
              sizes: '192x192',
              type: 'image/png'
            },
            {
              src: '/icon-512.png',
              sizes: '512x512',
              type: 'image/png'
            }
          ]
        }
      })
    ]
  }
})
