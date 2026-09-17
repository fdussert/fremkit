/**
 * The gate every HTTP request passes before it reaches a route.
 *
 * The server has no authentication: it listens on loopback and treats its own origin as trusted.
 * Two browser tricks get around "loopback only" without ever leaving the user's machine, and
 * both are answered here.
 *
 * **DNS rebinding.** A page on `evil.example` gets that name to resolve to `127.0.0.1`, then
 * talks to us with its own origin. The socket is loopback, the origin is the attacker's, and the
 * `Host` header says `evil.example` — which is how we catch it: a request whose `Host` is not
 * one of the loopback names we answer to was not aimed at this server, whatever the packets say.
 *
 * **Cross-site writes.** Any page can `fetch` us with `mode: 'no-cors'` and never read the
 * answer; that is enough to save a config, rescan the widgets or upload a wallpaper. So every
 * request that is not a read must carry an origin we trust.
 */

/** The names this server answers to. Anything else is a rebinding attempt. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** Requests that only read. Everything else needs a trusted origin. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Splits a `Host` header into its name and port, `[::1]:4242` included. */
export function parseHostHeader(host: string | undefined): { hostname: string; port: number | null } | null {
  if (typeof host !== 'string') return null
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(host.trim())
  if (!m) return null
  return { hostname: m[1].toLowerCase(), port: m[2] === undefined ? null : Number(m[2]) }
}

/**
 * True when a `Host` header names this server.
 *
 * `port` is the port we listen on, when the caller knows it — an embedded instance (the test
 * suite) does not, and then the name alone decides. A `Host` with no port at all is let through
 * for the same reason: the name is what a rebinding attack cannot fake, and a middlebox that
 * drops the port should not lock the user out of their own dashboard.
 */
export function isAllowedHost(host: string | undefined, port?: number): boolean {
  const parsed = parseHostHeader(host)
  if (!parsed) return false
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return false
  if (port !== undefined && parsed.port !== null && parsed.port !== port) return false
  return true
}

/** True when a request only reads, and so needs no trusted origin. */
export function isReadMethod(method: string): boolean {
  return READ_METHODS.has(method.toUpperCase())
}
