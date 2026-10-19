/**
 * `/companion/ws`: the paired browser extension's socket.
 *
 * The route answers without the access secret (see `isCompanionRoute`), so it checks its own
 * credential, and nothing is heard before it has: an extension origin on the upgrade, then,
 * within `HELLO_TIMEOUT_MS` for the whole handshake, a `challenge` naming the extension's record
 * and a `hello` whose token belongs to that same record, origin and install.
 *
 * The challenge comes first so the server proves itself before the token is sent: it answers
 * `proof`, an HMAC of the extension's nonce keyed by the record's token hash (`proofMac`), which
 * another process holding the port cannot forge. A challenge naming no extension record of this
 * origin, or a hello whose token is not that record's, closes with `DEVICE_CLOSE_CODE` (4401),
 * the code that tells the extension it was unpaired and should forget its token. Anything else,
 * then or later — a message that does not parse, an unknown type, a hello before the challenge
 * (a version 1 extension), a second challenge or hello — closes the socket with 1008, which the
 * extension does not take for an unpairing: a newer or older extension the server cannot read
 * keeps its token. A frame over the 64 KiB cap is refused by `ws` itself, with 1009, before any
 * of it is buffered.
 *
 * An upgrade whose `Origin` is not an allowed extension's (`companionOrigins`) is answered 403
 * before any socket exists. Of the
 * rest, at most `MAX_PENDING_PER_ORIGIN` per extension origin and `MAX_PENDING_SOCKETS` in all may
 * be mid-handshake at once; one more is closed with 1013 (try again later) as soon as it is
 * upgraded.
 *
 * Each record holds one socket: a second one for it replaces the first. What the extension says
 * goes to the `CompanionSession`; what the session says comes back through `CompanionSockets`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { DeviceStore } from '../devices/store.js'
import { isLocalRequest } from '../net/remote.js'
import { DEVICE_CLOSE_CODE, DEVICE_TERMINATE_MS } from '../ws/hub.js'
import { EXTENSION_ORIGIN_RE, parseExtensionMessage, proofMac, type ServerMessage } from './protocol.js'
import type { CompanionSession } from './session.js'

/** How long a new socket has to finish the handshake: challenge, then hello. */
export const HELLO_TIMEOUT_MS = 5_000

/**
 * Sockets that have not finished the handshake, at most, at once, from every extension origin
 * together and from any one of them. Before hello a socket has proven nothing; an honest extension
 * opens one at a time and finishes in milliseconds, so it never meets either cap. Only a socket
 * with an extension `Origin` gets this far (anything else is 403 before the upgrade), so a page
 * cannot take a slot. A local process can forge that header, and any number of origins with it:
 * the per-origin cap does not limit it (eight made-up origins fill all 32 slots), only the overall
 * one bounds what it holds, and it can keep every slot taken (SECURITY.md says so).
 */
export const MAX_PENDING_SOCKETS = 32
export const MAX_PENDING_PER_ORIGIN = 4

/** "Try again later": what a socket over either cap is closed with, right after upgrade. */
export const TRY_AGAIN_LATER_CLOSE_CODE = 1013

/** How often the session is asked to clear a share that went quiet. */
export const TICK_MS = 1_000

/** Policy violation: what a refusal closes with, unless the token names no record (4401). */
const POLICY_CLOSE_CODE = 1008

interface CompanionSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  terminate(): void
}

/** Closes, then drops the connection if the peer has not finished the handshake in time. */
function closeSocket(socket: CompanionSocketLike, code: number, reason?: string): void {
  try { socket.close(code, reason) } catch { /* already closed */ }
  const timer = setTimeout(() => { try { socket.terminate() } catch { /* gone */ } }, DEVICE_TERMINATE_MS)
  timer.unref?.()
}

/** The authenticated socket of each connected extension, by device id. */
export class CompanionSockets {
  private readonly sockets = new Map<string, CompanionSocketLike>()

  send(deviceId: string, msg: ServerMessage): void {
    const socket = this.sockets.get(deviceId)
    if (!socket) return
    try { socket.send(JSON.stringify(msg)) } catch { /* socket closed */ }
  }

  /** Makes `socket` the device's one socket, closing the one it replaces. */
  attach(deviceId: string, socket: CompanionSocketLike): void {
    const previous = this.sockets.get(deviceId)
    this.sockets.set(deviceId, socket)
    if (previous && previous !== socket) closeSocket(previous, 1000, 'replaced')
  }

  isCurrent(deviceId: string, socket: CompanionSocketLike): boolean {
    return this.sockets.get(deviceId) === socket
  }

  /** Forgets the socket if it is still the device's. True when it was. */
  release(deviceId: string, socket: CompanionSocketLike): boolean {
    if (this.sockets.get(deviceId) !== socket) return false
    this.sockets.delete(deviceId)
    return true
  }

  ids(): string[] {
    return [...this.sockets.keys()]
  }

  /** For an unpaired device: tells it so, then closes with the revocation code. */
  revoke(deviceId: string): void {
    const socket = this.sockets.get(deviceId)
    if (!socket) return
    this.sockets.delete(deviceId)
    try { socket.send(JSON.stringify({ type: 'revoked' } satisfies ServerMessage)) } catch { /* closed */ }
    closeSocket(socket, DEVICE_CLOSE_CODE, 'revoked')
  }
}

export interface CompanionSocketOptions {
  store: DeviceStore
  session: CompanionSession
  sockets: CompanionSockets
  /** The extension origins let in (`companionOrigins`). */
  origins: ReadonlySet<string>
  /** Test seam; `HELLO_TIMEOUT_MS` otherwise. */
  helloTimeoutMs?: number
}

export async function companionSocket(app: FastifyInstance, opts: CompanionSocketOptions): Promise<void> {
  const { store, session, sockets, origins } = opts
  const allowed = (origin: unknown): origin is string => typeof origin === 'string' && EXTENSION_ORIGIN_RE.test(origin) && origins.has(origin)
  const helloTimeoutMs = opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS

  // A device removed in Appareils loses its socket and whatever it was sharing.
  const unsubscribe = store.onChange((devices) => {
    const ids = new Set(devices.map((d) => d.id))
    for (const id of sockets.ids()) if (!ids.has(id)) sockets.revoke(id)
    session.prune((id) => ids.has(id))
  })
  const tick = setInterval(() => session.tick(), TICK_MS)
  tick.unref()
  app.addHook('onClose', async () => {
    clearInterval(tick)
    unsubscribe()
  })

  /** Sockets between upgrade and a hello accepted (or their close): in all, and by origin. */
  let pending = 0
  const pendingByOrigin = new Map<string, number>()

  /** This Mac's only: the remote allow-list leaves it out too, this is in case it ever grows. */
  const localOnly = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!isLocalRequest(req)) return reply.callNotFound()
  }

  /** Before the 101: a web page, or anything that is not an allowed extension, gets no socket at all. */
  const extensionOnly = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!allowed(req.headers.origin)) return reply.code(403).send()
  }

  app.get('/companion/ws', { websocket: true, onRequest: [localOnly, extensionOnly] }, (socket, req) => {
    const origin = req.headers.origin
    const key = typeof origin === 'string' ? origin : ''
    if (pending >= MAX_PENDING_SOCKETS || (pendingByOrigin.get(key) ?? 0) >= MAX_PENDING_PER_ORIGIN) {
      return closeSocket(socket, TRY_AGAIN_LATER_CLOSE_CODE)
    }
    pending += 1
    pendingByOrigin.set(key, (pendingByOrigin.get(key) ?? 0) + 1)
    let counted = true
    /** Leaves the pending counts, once: on hello accepted, on refusal or on close. */
    const settle = (): void => {
      if (!counted) return
      counted = false
      pending -= 1
      const left = (pendingByOrigin.get(key) ?? 1) - 1
      if (left > 0) pendingByOrigin.set(key, left)
      else pendingByOrigin.delete(key)
    }

    let deviceId: string | null = null
    /** The record the challenge named, once the proof is sent: hello must carry its token. */
    let challenged: string | null = null
    let closed = false

    const refuse = (code = POLICY_CLOSE_CODE): void => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      settle()
      if (deviceId !== null && sockets.release(deviceId, socket)) session.disconnect(deviceId)
      closeSocket(socket, code)
    }

    const timer = setTimeout(() => refuse(), helloTimeoutMs)
    timer.unref()

    socket.on('close', () => {
      closed = true
      clearTimeout(timer)
      settle()
      if (deviceId !== null && sockets.release(deviceId, socket)) session.disconnect(deviceId)
    })

    // Refused before the upgrade already (`extensionOnly`); kept in case the hook ever moves.
    if (!allowed(origin)) return refuse()

    socket.on('message', (raw: Buffer, isBinary: boolean) => {
      if (closed) return
      if (isBinary) return refuse()
      const msg = parseExtensionMessage(raw.toString('utf8'))
      if (msg === null) return refuse()

      if (challenged === null) {
        // A version 1 extension says hello first: 1008 tells it an update is due.
        if (msg.type !== 'challenge') return refuse()
        const proof = store.extensionProofKey(msg.deviceId)
        // No record for this extension: it was removed in Appareils (or never paired here).
        if (proof === null || proof.origin !== origin) return refuse(DEVICE_CLOSE_CODE)
        challenged = msg.deviceId
        try { socket.send(JSON.stringify({ type: 'proof', mac: proofMac(proof.key, msg.nonce) } satisfies ServerMessage)) } catch { /* closed */ }
        return
      }

      if (deviceId === null) {
        if (msg.type !== 'hello') return refuse()
        // Never logged: the token, nor whose it might have been.
        const record = store.findByToken(msg.token, 'extension')
        if (
          record === null || record.kind !== 'extension' || record.id !== challenged ||
          record.origin !== origin || record.installId !== msg.installId
        ) {
          // No record for this extension: it was removed in Appareils (or never paired here).
          return refuse(DEVICE_CLOSE_CODE)
        }
        clearTimeout(timer)
        settle()
        deviceId = record.id
        sockets.attach(deviceId, socket)
        store.touch(deviceId).catch(() => undefined)
        session.connect(deviceId, record.name)
        session.onMessage(deviceId, msg)
        return
      }

      if (msg.type === 'hello' || msg.type === 'challenge') return refuse()
      // A socket replaced by a newer one is no longer heard while it closes.
      if (!sockets.isCurrent(deviceId, socket)) return
      session.onMessage(deviceId, msg)
    })
  })
}
