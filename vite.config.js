import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Runs the flight-booking API (server/api.js) inside the Vite dev server, so
 * `npm run dev` behaves like Vercel without the Vercel CLI. It adapts Node's
 * request to the web-standard Request the production function receives.
 * Production builds are untouched — this only patches configureServer.
 */
function flightsDevApi() {
  return {
    name: 'flights-dev-api',
    configureServer(server) {
      server.middlewares.use('/api/flights', async (req, res) => {
        try {
          const chunks = []
          for await (const c of req) chunks.push(c)
          const headers = new Headers()
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
          const request = new Request(`http://${req.headers.host || 'localhost'}${req.originalUrl}`, {
            method: req.method,
            headers,
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
          })
          const { handle } = await server.ssrLoadModule('/server/api.js')
          const response = await handle(request, (p) => p)
          res.statusCode = response.status
          response.headers.forEach((v, k) => res.setHeader(k, v))
          res.end(Buffer.from(await response.arrayBuffer()))
        } catch (e) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: 'Dev API error: ' + e.message }))
        }
      })
    },
  }
}

export default defineConfig(({ mode, isSsrBuild }) => {
  // Vite only auto-injects VITE_-prefixed vars into client code; loadEnv with
  // an empty prefix pulls the server secrets (TBO_*, RAZORPAY_*, DATABASE_URL,
  // STAFF_PASSWORD …) from .env.local into process.env for the dev API above.
  // They are never bundled into the browser code.
  const env = loadEnv(mode, process.cwd(), '')
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('VITE_') && process.env[k] === undefined) process.env[k] = v

  // Second build pass used only by scripts/prerender.mjs (see package.json).
  // gsap ships its plugins as ESM inside a CommonJS package, which Node can't
  // import directly, so it's bundled into the server build instead.
  if (isSsrBuild) {
    return {
      plugins: [react(), tailwindcss()],
      ssr: { noExternal: ['gsap', '@gsap/react'] },
      build: { outDir: 'dist-ssr', sourcemap: false, emptyOutDir: true },
    }
  }

  return {
    plugins: [react(), tailwindcss(), flightsDevApi()],
    server: { port: 5173, open: true },
    build: {
      outDir: 'dist',
      sourcemap: false,
      rollupOptions: {
        output: {
          // Keep the big, rarely-changing libraries in their own cacheable chunks.
          // Matched by path so sub-entries (react-dom/client, where React's
          // renderer actually lives) land in the vendor chunk too — the old
          // name list only caught the package root, leaving ~180 KB of React
          // in the app chunk that changes on every content edit.
          manualChunks(id) {
            if (!id.includes('node_modules')) return
            if (/node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return 'react'
            if (/node_modules[\\/](framer-motion|motion-dom|motion-utils)[\\/]/.test(id)) return 'motion'
            if (/node_modules[\\/](gsap|@gsap)[\\/]/.test(id)) return 'gsap'
            if (/node_modules[\\/]lucide-react[\\/]/.test(id)) return 'icons'
          },
        },
      },
    },
  }
})
