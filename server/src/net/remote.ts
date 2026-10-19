import type { Socket } from 'node:net'
import type { IncomingMessage } from 'node:http'
import type { FastifyRequest } from 'fastify'
import { isLoopbackAddress } from './loopback.js'

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The paired device a remote request was authenticated as, or null. Declared with a null
     * default at app construction; only the devices gate sets it.
     */
    deviceId: string | null
  }
}

/**
 * Local or remote is decided by the socket a request arrived on, never by a header and never by
 * the address alone: the remote listener marks every socket it accepts, and a marked socket is
 * remote whatever address it reports. Fastify's `trustProxy` stays off, so `req.ip` is the
 * socket's peer and cannot be forged by a header either.
 *
 * A WeakSet so a closed socket is forgotten with it.
 */
const remoteSockets = new WeakSet<Socket>()

/** Called by the remote listener for every connection it accepts. */
export function markRemoteSocket(socket: Socket): void {
  remoteSockets.add(socket)
}

/** Accepts a Fastify request (its socket is on `raw`) or a bare `IncomingMessage`. */
export function isRemoteRequest(req: FastifyRequest | IncomingMessage): boolean {
  const socket = 'raw' in req && req.raw ? req.raw.socket : (req as IncomingMessage).socket
  return socket !== undefined && socket !== null && remoteSockets.has(socket)
}

/** On this machine: a loopback peer on a socket the remote listener did not accept. */
export function isLocalRequest(req: FastifyRequest): boolean {
  return isLoopbackAddress(req.ip) && !isRemoteRequest(req)
}

/** The paired device behind a request, once the devices gate has authenticated it. */
export function pairedDeviceOf(req: FastifyRequest): string | null {
  return req.deviceId ?? null
}
