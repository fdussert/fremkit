/**
 * The TLS listener paired devices reach the dashboard on, beside the loopback one.
 *
 * It is not a second Fastify instance: it accepts TLS connections, marks each socket as remote
 * (`net/remote.ts`), and hands every request and upgrade to the app's own server, so both
 * listeners share one set of routes, one hub and one config — and every remote request meets
 * the devices gate first (`gate.ts`).
 *
 * Before any of that, the peer: a connection from outside the local networks (`net/lan.ts`) is
 * dropped as it is accepted, before the TLS handshake, with nothing said to it.
 */

import { createServer, type Server } from 'node:https'
import type { Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { markRemoteSocket } from '../net/remote.js'
import { isLanPeer } from '../net/lan.js'

export const REMOTE_PORT = 4243

/**
 * `FREMKIT_REMOTE_PORT` read for the server: unset (or empty) leaves 4243, a whole number from 1
 * to 65535 that is not the loopback port moves the listener there, and anything else is an error
 * to stop on, named in plain words: a typo should not leave a bench fighting the live server for
 * 4243, nor put the remote listener on the dashboard's own port.
 */
export function remotePortFrom(raw: string | undefined, loopbackPort: number): { port?: number; error?: string } {
  if (raw === undefined || raw === '') return {}
  if (!/^[0-9]{1,5}$/.test(raw)) return { error: `FREMKIT_REMOTE_PORT must be a whole number from 1 to 65535, got ${JSON.stringify(raw)}` }
  const port = Number(raw)
  if (port < 1 || port > 65535) return { error: `FREMKIT_REMOTE_PORT must be a whole number from 1 to 65535, got ${raw}` }
  if (port === loopbackPort) return { error: `FREMKIT_REMOTE_PORT must differ from the dashboard's port (${loopbackPort})` }
  return { port }
}

/** Every listener running in this process, for `closeRemoteListenersNow`. */
const running = new Set<RemoteListener>()

/**
 * Stops every remote listener of this process from accepting, and drops its sockets, right now,
 * synchronously: the shutdown path calls it from the signal handler, before anything that could
 * block the event loop gets a chance to keep the port held (`shutdown.ts`). `stop()` still runs
 * later, through the app's close, and finds nothing left to do but wait.
 */
export function closeRemoteListenersNow(): void {
  for (const listener of running) listener.closeNow()
}

export class RemoteListener {
  private server: Server | null = null
  /** Every socket the listener holds open, the TCP ones and those upgraded to a WebSocket. */
  private readonly sockets = new Set<Socket>()
  private boundPort: number | null = null
  /** The server `closeNow` has closed already, and the promise of its close, for `stop`. */
  private closing: Server | null = null
  private closed: Promise<void> | null = null

  constructor(
    private readonly app: FastifyInstance,
    private readonly requestedPort = REMOTE_PORT,
    /** Which peer addresses may connect. Only tests pass another one. */
    private readonly acceptPeer: (address: string | undefined) => boolean = isLanPeer,
  ) {}

  get running(): boolean {
    return this.server !== null
  }

  /** The port actually bound once started (what port 0 resolved to), the requested one before. */
  get port(): number {
    return this.boundPort ?? this.requestedPort
  }

  /**
   * Starts listening on every interface, IPv4 and IPv6 (`::`, dual-stack); the peer check above
   * is what keeps it to the local networks. Rejects with the
   * listen error — `code: 'EADDRINUSE'` when the port is taken — and leaves nothing listening.
   */
  async start(keyPem: string, certPem: string): Promise<void> {
    if (this.server) throw new Error('remote listener already running')
    await this.app.ready()
    const server = createServer({ key: keyPem, cert: certPem, minVersion: 'TLSv1.2' })
    const track = (socket: Socket): void => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    }
    // The raw TCP connection, before TLS: a peer outside the local networks gets nothing, not even
    // the certificate.
    server.on('connection', (socket: Socket) => {
      if (!this.acceptPeer(socket.remoteAddress)) {
        socket.destroy()
        return
      }
      track(socket)
    })
    server.on('secureConnection', (socket: Socket) => {
      markRemoteSocket(socket)
      track(socket)
    })
    // Marked again on the way in, so a request can never reach the app looking local, whatever
    // order the events above come in.
    server.on('request', (req, res) => {
      // Asked again on the way in, so no event order can let a refused peer reach the app.
      if (!this.acceptPeer(req.socket.remoteAddress)) {
        res.writeHead(403).end()
        req.socket.destroy()
        return
      }
      markRemoteSocket(req.socket)
      this.app.server.emit('request', req, res)
    })
    server.on('upgrade', (req, socket: Socket, head: Buffer) => {
      if (!this.acceptPeer(socket.remoteAddress)) {
        socket.destroy()
        return
      }
      markRemoteSocket(socket)
      this.app.server.emit('upgrade', req, socket, head)
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      // No host: Node binds `::`, which on macOS also accepts IPv4.
      server.listen(this.requestedPort)
    })
    server.on('error', (err) => this.app.log.warn({ err: err.message }, 'remote listener error'))
    this.boundPort = (server.address() as AddressInfo).port
    this.server = server
    running.add(this)
  }

  /** Stops accepting and destroys every socket, without waiting: see `closeRemoteListenersNow`. */
  closeNow(): void {
    const server = this.server
    if (!server || this.closing) return
    this.closing = server
    this.closed = new Promise<void>((resolve) => server.close(() => resolve()))
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }

  /**
   * Swaps the certificate new connections are offered, without dropping the open ones: used when
   * the Mac's addresses change and the certificate is re-issued from the same key.
   */
  setCertificate(keyPem: string, certPem: string): void {
    this.server?.setSecureContext({ key: keyPem, cert: certPem, minVersion: 'TLSv1.2' })
  }

  /**
   * Destroys every socket the listener holds, WebSockets included, and keeps listening: used when
   * the key is reset, so no keep-alive connection goes on talking over the old key.
   */
  dropConnections(): void {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }

  /** Closes the listener and destroys every socket it still holds, WebSockets included. */
  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    this.boundPort = null
    running.delete(this)
    const closed = this.closing === server && this.closed
      ? this.closed
      : new Promise<void>((resolve) => server.close(() => resolve()))
    this.closing = null
    this.closed = null
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await closed
  }
}
