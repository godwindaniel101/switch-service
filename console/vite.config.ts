import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The console is served by switch-service at /console/, so every asset path
 * must be relative to that prefix.
 */
export default defineConfig({
  plugins: [react()],
  base: '/console/',
  build: {
    outDir: '../public/console',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
})
