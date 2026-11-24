import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Fail the production build instead of shipping a bundle that falls back to localhost.
  const apiUrl = loadEnv(mode, process.cwd(), 'VITE_').VITE_API_URL ?? ''
  if (mode === 'production' && !/^https?:\/\//.test(apiUrl)) {
    throw new Error('VITE_API_URL must be an absolute URL for production builds, e.g. https://proyecto3-api.onrender.com/api')
  }

  return {
    plugins: [react(), tailwindcss()],
  }
})
