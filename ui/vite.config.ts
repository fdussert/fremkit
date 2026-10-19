import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

import { hostCsp } from '../server/src/http/headers'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/**
 * The host-page CSP under `pnpm dev`, where Vite rather than the server writes the pages: the
 * server's policy (`hostCsp`), for the origin the page was loaded from — `localhost:5173`, whose
 * own WebSocket is also Vite's hot reload. Pages only: what Vite proxies to the server (the
 * widgets above all) keeps the header the server gave it.
 */
function hostPagePolicy(): Plugin {
  const proxied = /^\/(api|auth|widgets|fremkit\.js|ws)(\/|\?|$)/
  return {
    name: 'fremkit-host-csp',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '/').split('?')[0]
        if (!proxied.test(path) && /text\/html/.test(String(req.headers.accept ?? '')) && req.headers.host) {
          res.setHeader('content-security-policy', hostCsp(req.headers.host.toLowerCase()))
        }
        next()
      })
    },
  }
}
// The server the dev UI talks to: 4242, or the port `FREMKIT_PORT` moved a second checkout to.
const server = `127.0.0.1:${Number(process.env.FREMKIT_PORT) || 4242}`

export default defineConfig({
  plugins: [vue(), hostPagePolicy()],
  build: { rollupOptions: { input: { index: r('index.html'), admin: r('admin.html') } } },
  server: {
    port: 5173,
    proxy: {
      '/api': `http://${server}`,
      // The one-time link that sets the access cookie, for this origin (see docs/contributing.md).
      '/auth': `http://${server}`,
      '/widgets': `http://${server}`,
      '/fremkit.js': `http://${server}`,
      '/ws': { target: `ws://${server}`, ws: true },
    },
  },
})
