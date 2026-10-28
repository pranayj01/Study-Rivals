import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: 'autoUpdate',
    manifest: {
      name: 'Study Rivals', short_name: 'Study Rivals', description: 'A two-player competitive study room',
      theme_color: '#080b16', background_color: '#080b16', display: 'standalone', start_url: '/',
      icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }]
    }
  })],
  server: { proxy: { '/api': 'http://localhost:3001', '/socket.io': { target: 'http://localhost:3001', ws: true } } }
})
