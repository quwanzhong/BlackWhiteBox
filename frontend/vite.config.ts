import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3310',
      '/socket.io': { target: 'http://localhost:3310', ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 2000,
  },
})
