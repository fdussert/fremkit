import type { FastifyInstance } from 'fastify'
import type { Hub } from './hub.js'
import { isLocalRequest, isRemoteRequest } from '../net/remote.js'

/**
 * Origins allowed to drive this server — the WebSocket, and every write, through the gate in
 * `app.ts`: its own port, which is `FREMKIT_PORT` when set and 4242 otherwise.
 *
 * The Vite dev server on `:5173` is on the list only when `FREMKIT_DEV=1`, which `scripts/dev.sh`
 * sets. Trusting it unconditionally meant that any unrelated project running Vite — 5173 is its
 * default everywhere — was trusted to save this dashboard's config and read its connections.
 *
 * Read per call rather than computed once: the environment is read where it is used, and a test
 * can set it without reaching into module state.
 */
export function allowedOrigins(): string[] {
  // This server's own port, and only that: a second checkout on 4301 must not take writes from
  // pages the live server on 4242 served (or from whatever else holds 4242 at the time).
  const configured = Number(process.env.FREMKIT_PORT)
  const own = Number.isInteger(configured) && configured > 0 && configured < 65536 ? configured : 4242
  const ports = new Set([own])
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
    // A remote upgrade's Origin was already held to `https://<Host>` by the devices gate; the
    // loopback origins below would refuse every one of them.
    if (!isRemoteRequest(req) && !isOriginAllowed(req.headers.origin)) {
      socket.close(1008, 'origin not allowed')
      return
    }
    if (isRemoteRequest(req)) {
      // The devices gate refuses a remote `/ws` with no valid token, so a device id is always
      // here; closing anyway keeps a paired socket from ever attaching without one.
      if (!req.deviceId) {
        socket.close(4401, 'unpaired')
        return
      }
      // Asked again: the gate checked the token before the handshake finished, and a device
      // revoked in between would otherwise attach under an id `revoke()` already closed.
      if (!app.pairing.store.has(req.deviceId)) {
        socket.close(4401, 'unpaired')
        return
      }
      opts.hub.attach(socket, { loopback: false, paired: true, deviceId: req.deviceId })
      return
    }
    opts.hub.attach(socket, { loopback: isLocalRequest(req), paired: false })
  })
}
