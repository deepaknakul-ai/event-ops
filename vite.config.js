import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'

// ── Build stamp: version (package.json) + git commit + build time ────────────
// Injected as compile-time constants and also written to dist/version.json, so the
// LIVE site's deployed version is checkable at https://<host>/version.json.
const pkg = JSON.parse(readFileSync('./package.json', 'utf8'))
const gitSha = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim() } catch { return 'nogit' }
})()
const buildTime = new Date().toISOString()
const stamp = { version: pkg.version, gitSha, buildTime }

const emitVersionJson = () => ({
  name: 'emit-version-json',
  closeBundle() {
    try {
      if (!existsSync('dist')) mkdirSync('dist', { recursive: true })
      writeFileSync('dist/version.json', JSON.stringify(stamp, null, 2))
    } catch { /* non-fatal */ }
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), emitVersionJson()],
  define: {
    __APP_VERSION__: JSON.stringify(stamp.version),
    __GIT_SHA__: JSON.stringify(stamp.gitSha),
    __BUILD_TIME__: JSON.stringify(stamp.buildTime),
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-firebase': ['firebase/app', 'firebase/auth', 'firebase/firestore', 'firebase/storage'],
          'vendor-charts': ['recharts'],
          'vendor-pdf': ['jspdf', 'jspdf-autotable', 'html2canvas'],
          'vendor-xlsx': ['@e965/xlsx'],
          'vendor-icons': ['lucide-react'],
        },
      },
    },
  },
})
