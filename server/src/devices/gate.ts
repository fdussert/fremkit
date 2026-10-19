/**
 * The gate every request on the remote listener passes, before anything else sees it.
 *
 * A request is remote because of the socket it arrived on (`net/remote.ts`), never because of a
 * header. Local requests are not this gate's business and go straight through to the loopback
 * guard and the access gate, which in turn skip remote ones.
 *
 * In order, a remote request is refused with:
 *   1. 421 when its `Host` is not one of the names the listener answers to (DNS rebinding);
 *   2. 404 when the allow-list does not let it in at all — indistinguishable from a route that
 *      does not exist;
 *   3. 403 when it writes, or opens the WebSocket, from a page that is not ours;
 *   4. 401 when the route needs a paired device and the `fremkit_device` cookie names none.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { isRemoteRequest } from '../net/remote.js'
import { readCookie } from '../http/cookies.js'
import { isReadMethod } from '../http/guard.js'
import { stripQuery } from '../http/logging.js'
import { serverLocale, tr } from '../i18n.js'
import { remoteAccess } from './allowlist.js'
import type { DeviceStore } from './store.js'

/** The cookie a paired device carries. Its value is the device token, never logged. */
export const DEVICE_COOKIE = 'fremkit_device'

/** Longer than any token we issue (43 characters); a bigger value is not worth hashing. */
const MAX_TOKEN_LENGTH = 256

export interface Pairing {
  /** The paired devices, loaded from `<dataDir>/devices.json`. */
  store: DeviceStore
  /**
   * What the remote listener answers to: lowercased `host:port` authorities, exactly as a
   * `Host` header names them (`example.local:4243`, `192.0.2.10:4243`, `[::1]:4243`). Empty
   * until the listener is started, so every remote request is refused 421 until then.
   */
  setRemoteHosts(fn: () => Set<string>): void
}

declare module 'fastify' {
  interface FastifyInstance {
    pairing: Pairing
  }
}

export interface RemoteGateOptions {
  devices: DeviceStore
  remoteHosts: () => Set<string>
}

function refuse(reply: FastifyReply, code: 403 | 421 | 401, key: 'http.originNotAllowed' | 'http.hostNotAllowed' | 'devices.unauthorized'): FastifyReply {
  return reply.code(code).header('cache-control', 'no-store').send({ error: tr(serverLocale(), key) })
}

/**
 * Registers the gate on `app` itself, so it runs before every route, the static UI, the 404
 * handler and the WebSocket handshake. Must be the first `onRequest` hook added.
 */
export function registerRemoteGate(app: FastifyInstance, opts: RemoteGateOptions): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isRemoteRequest(req)) return

    const host = typeof req.headers.host === 'string' ? req.headers.host.trim().toLowerCase() : ''
    if (host === '' || !opts.remoteHosts().has(host)) return refuse(reply, 421, 'http.hostNotAllowed')

    const path = stripQuery(req.url)
    const access = remoteAccess(req.method, path)
    if (access === null) return reply.callNotFound()

    const upgrade = path === '/ws' || req.headers.upgrade !== undefined
    if (!isReadMethod(req.method) || upgrade) {
      const origin = req.headers.origin
      if (origin !== undefined && origin.toLowerCase() !== `https://${host}`) {
        return refuse(reply, 403, 'http.originNotAllowed')
      }
    }

    if (access === 'public') return
    // An empty cookie is no cookie.
    const token = readCookie(req.headers.cookie, DEVICE_COOKIE) || null
    const device = token !== null && token.length <= MAX_TOKEN_LENGTH ? opts.devices.findByToken(token, 'ipad') : null
    if (!device) return refuse(reply, 401, 'devices.unauthorized')
    req.deviceId = device.id
    // Not awaited: a slow or failed `lastSeen` write must not hold up, or fail, the request.
    opts.devices.touch(device.id).catch((err: unknown) => {
      req.log.warn({ err: (err as Error).message }, 'could not record a paired device as seen')
    })
  })
}
