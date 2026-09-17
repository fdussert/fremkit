import type { FastifyInstance } from 'fastify'
import type { Hub } from './hub.js'
import { isLoopbackAddress } from '../net/loopback.js'

/**
 * Origins allowed to drive this server — the WebSocket, and every write, through the gate in
 * `app.ts`: the production port, and the one `FREMKIT_PORT` moves a second checkout to.
 *
 * The Vite dev server on `:5173` is on the list only when `FREMKIT_DEV=1`, which `scripts/dev.sh`
 * sets. Trusting it unconditionally meant that any unrelated project running Vite — 5173 is its
 * default everywhere — was trusted to save this dashboard's config and read its connections.
 *
 * Read per call rather than computed once: the environment is read where it is used, and a test
 * can set it without reaching into module state.
 */
export function allowedOrigins(): string[] {
  const ports = new Set([4242])
  const configured = Number(process.env.FREMKIT_PORT)
  if (Number.isInteger(configured) && configured > 0 && configured < 65536) ports.add(configured)
  if (process.env.FREMKIT_DEV === '1') ports.add(5173)
  return [...ports].flatMap((port) => [`http://127.0.0.1:${port}`, `http://localhost:${port}`])
}

/** Non-browser clients send no Origin header and are allowed; browsers must be on the list. */
export function isOriginAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true
  return allowedOrigins().includes(origin)
}

export async function wsRoutes(app: FastifyInstance, opts: { hub: Hub }): Promise<void> {
  app.get('/ws', { websocket: true }, (socket, req) => {
    if (!isOriginAllowed(req.headers.origin)) {
      socket.close(1008, 'origin not allowed')
      return
    }
    opts.hub.attach(socket, { loopback: isLoopbackAddress(req.ip) })
  })
}
