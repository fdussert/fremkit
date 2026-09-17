/**
 * What the server writes to its log.
 *
 * The log lives at `~/Library/Logs/Fremkit/server.log`, it is plain text, and it is not something
 * the user reads — it is something they would send to someone else when asking for help. So the
 * request line records the path and nothing after the `?`.
 *
 * That matters most for `/api/favicon?url=…`, whose own comment promises the URL "never leaves
 * this machine" and "nothing is ever logged": the route logged nothing itself, but Fastify's
 * default serializer wrote the whole query string, token and private page and all. The widget
 * proxy (`/api/proxy/:id?url=…`) is the same.
 */

import type { FastifyServerOptions } from 'fastify'

/** A request path with everything after the `?` removed. */
export function stripQuery(url: string): string {
  const cut = url.indexOf('?')
  return cut === -1 ? url : url.slice(0, cut)
}

/**
 * One request, as a log line records it.
 *
 * The index signature is what Fastify's own serializer type asks for; the named fields are the
 * whole of what we actually write.
 */
export interface LoggedRequest {
  [key: string]: unknown
  method: string
  url: string
  host: string | undefined
  remoteAddress: string | undefined
  remotePort: number | undefined
}

/**
 * The serializer, kept separate from the options so it can be exercised on its own.
 *
 * Takes `unknown` and narrows: a serializer has to be assignable to one accepting Fastify's own
 * request type, and a narrower parameter would not be.
 */
export function serializeRequest(value: unknown): LoggedRequest {
  const req = (value ?? {}) as {
    method?: string
    url?: string
    headers?: Record<string, unknown>
    host?: string
    ip?: string
    socket?: { remotePort?: number }
  }
  return {
    method: req.method ?? '',
    url: stripQuery(req.url ?? ''),
    host: typeof req.headers?.host === 'string' ? req.headers.host : req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  }
}

/** Fastify's `logger` option when logging is on at all. */
export const LOGGER_OPTIONS: FastifyServerOptions['logger'] = {
  serializers: { req: serializeRequest },
}
