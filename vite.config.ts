import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  server: {
    proxy: {
      '/api/wsdot': {
        target: 'https://www.wsdot.wa.gov',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/wsdot/, '/ferries/api'),
      },
      '/api/google/routes': {
        target: 'https://routes.googleapis.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/google\/routes/, ''),
      },
      '/api/google/geocode': {
        target: 'https://maps.googleapis.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/google\/geocode/, '/maps/api/geocode'),
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
})
