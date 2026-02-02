import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    server: {
      proxy: {
        '/api/wsdot': {
          target: 'https://www.wsdot.wa.gov',
          changeOrigin: true,
          rewrite: (path) => {
            const newPath = path.replace(/^\/api\/wsdot/, '/ferries/api')
            // Inject API key
            const separator = newPath.includes('?') ? '&' : '?'
            return `${newPath}${separator}apiaccesscode=${env.WSDOT_API_KEY}`
          },
        },
        '/api/google/routes': {
          target: 'https://routes.googleapis.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/google\/routes/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader('X-Goog-Api-Key', env.GOOGLE_MAPS_API_KEY || '')
            })
          },
        },
        '/api/google/geocode': {
          target: 'https://maps.googleapis.com',
          changeOrigin: true,
          rewrite: (path) => {
            const newPath = path.replace(/^\/api\/google\/geocode/, '/maps/api/geocode')
            // Inject API key
            const separator = newPath.includes('?') ? '&' : '?'
            return `${newPath}${separator}key=${env.GOOGLE_MAPS_API_KEY}`
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
          theme_color: '#1a1a2e',
          background_color: '#1a1a2e',
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
