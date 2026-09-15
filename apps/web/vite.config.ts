import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Same-origin in dev, matching what nginx does in compose. No CORS, ever —
    // not in dev, not in prod, so there is no CORS config to get wrong.
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: true },
})
