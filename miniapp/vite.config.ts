import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Connect } from 'vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const MANIFEST_NAME = 'GiftHub Escrow'

function normalizePath(url: string | undefined): string {
  const raw = url?.split('?')[0] ?? ''
  if (raw.length > 1 && raw.endsWith('/')) return raw.slice(0, -1)
  return raw
}

function tonconnectManifestMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const pathOnly = normalizePath(req.url)
    if (pathOnly !== '/tonconnect-manifest.json') {
      next()
      return
    }
    const host = req.headers.host ?? 'localhost:5173'
    const xf = req.headers['x-forwarded-proto']
    const proto =
      typeof xf === 'string'
        ? xf.split(',')[0].trim()
        : host.startsWith('127.') || host.startsWith('localhost')
          ? 'http'
          : 'https'
    const origin = `${proto}://${host}`
    const body = JSON.stringify({
      url: origin,
      name: MANIFEST_NAME,
      iconUrl: `${origin}/favicon.svg`,
    })
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(body)
  }
}

function tonconnectManifestPlugin() {
  return {
    name: 'tonconnect-manifest-dynamic',
    enforce: 'pre' as const,
    configureServer(server: { middlewares: Connect.Server }) {
      // Must run before static public files — otherwise a stale tonconnect-manifest.json breaks Telegram Wallet.
      server.middlewares.use(tonconnectManifestMiddleware())
    },
    configurePreviewServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(tonconnectManifestMiddleware())
    },
    writeBundle(options: { dir?: string }) {
      const origin = process.env.VITE_APP_ORIGIN?.trim()
      if (!origin || !options.dir) return
      const path = join(options.dir, 'tonconnect-manifest.json')
      writeFileSync(
        path,
        JSON.stringify(
          {
            url: origin,
            name: MANIFEST_NAME,
            iconUrl: `${origin}/favicon.svg`,
          },
          null,
          2,
        ),
      )
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [tonconnectManifestPlugin(), react()],
  server: {
    // Dev tunnels: allow any host header (ngrok / cloudflared domains change often).
    allowedHosts: true,
  },
})
