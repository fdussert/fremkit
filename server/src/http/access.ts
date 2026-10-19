/**
 * The local access secret: what a request has to show before the server answers it.
 *
 * The server listens on loopback, and the Host and Origin checks in `guard.ts` stop a web page
 * from talking to it *as itself*. They do not stop a page from embedding or reading something
 * the browser lets through, and they cannot tell one local program from another. The secret
 * narrows "anything that can open a socket to 127.0.0.1" to "whoever can read a file only this
 * user can read": the helper that started the server, the scripts, and a browser that was handed
 * a one-time link by one of those.
 *
 * Two carriers, and nothing else:
 *
 * - `Authorization: Bearer <secret>`, for programs (the helper, the hook scripts, `curl`).
 * - A session cookie, `HttpOnly` and `SameSite=Strict`, for the pages. A browser gets it by
 *   following `/auth?code=…`, where the code is single-use, short-lived, and was minted by
 *   someone who already holds the secret; the helper's web views follow the same kind of link.
 *   The cookie holds a session id of its own, random, kept in this process's memory, expiring
 *   and revocable — never the secret. Browsers send a host's cookies to *every* port on that
 *   host, so whatever listens on another loopback port sees the cookie; what it sees is a session
 *   that dies with this process, after a day unused, or after a week at most, and that cannot
 *   mint a code or be presented as a bearer.
 *
 * A few routes are exempt, by route rather than by path text — see `isPublicRoute` and
 * `isCompanionRoute`.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readCookie } from './cookies.js'

/** Bytes of randomness in a secret and in a one-time code. */
export const TOKEN_BYTES = 32
/** How long a one-time code stays redeemable. Long enough to open a browser, no longer. */
export const CODE_TTL_MS = 60_000
/** Codes waiting to be redeemed; minting past this drops the oldest. */
export const MAX_PENDING_CODES = 16
/** A browser session unused this long is gone. The kiosk's socket keeps its own alive. */
export const SESSION_IDLE_MS = 24 * 60 * 60_000
/** And no session outlives this, used or not. */
export const SESSION_MAX_MS = 7 * 24 * 60 * 60_000
/** Sessions held at once; opening past this drops the least recently used. */
export const MAX_SESSIONS = 64
/** How often a session's last use is written down: no need to on every request. */
const TOUCH_EVERY_MS = 60_000

/** base64url, at least 32 bytes' worth (43 characters), and a ceiling so nothing absurd is held. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43,512}$/

/** A fresh secret or code: 32 random bytes, base64url. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/** True for a string that can be a secret: base64url, at least 32 bytes of it. */
export function isWellFormedToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value)
}

/**
 * The cookie's name, which carries the port.
 *
 * Browsers scope cookies by host and *not* by port, so the live server on 4242 and a second
 * checkout on 4301 would overwrite each other's cookie if both used one name, logging each other
 * out on every visit.
 */
export function cookieName(port?: number): string {
  return port === undefined ? 'fremkit_access' : `fremkit_access_${port}`
}

/**
 * Compares two strings in time that does not depend on where they differ.
 *
 * Both sides are hashed first, so the comparison is always over 32 bytes and a length mismatch
 * says nothing either.
 */
export function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest()
  const y = createHash('sha256').update(b).digest()
  return timingSafeEqual(x, y)
}

export { readCookie }

/** The token of an `Authorization: Bearer …` header, or undefined. */
export function readBearer(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header
  if (typeof raw !== 'string') return undefined
  const m = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(raw)
  return m?.[1]
}

/**
 * The routes that answer without the secret.
 *
 * - `/auth` is where the secret is *obtained*; it takes a one-time code instead.
 * - `/fremkit.js` and `/widgets/:id/*` are the widgets' own files. A widget runs in a sandboxed
 *   iframe with an opaque origin, and a browser treats every request such a document makes — its
 *   scripts, its styles, its images, the bridge itself — as cross-site, so a `SameSite=Strict`
 *   cookie is never sent with them. These files are the same bytes as the repository or the
 *   registry publishes, carry no user data, and are served under the widget CSP whatever opens
 *   them. Everything a widget *does* goes through the host page, which holds the cookie.
 *
 * Decided on the route Fastify matched, not on the request's path text: a path that merely
 * *starts* with `/widgets/` but is routed somewhere else (dot segments, encodings) is not exempt.
 */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set(['/auth', '/auth/proof', '/fremkit.js', '/widgets/:id/*'])

/** What a proof nonce may look like: base64url, 16 to 128 characters. */
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/

/** True for a string the proof route accepts as a nonce. */
export function isWellFormedNonce(value: unknown): value is string {
  return typeof value === 'string' && NONCE_RE.test(value)
}

/**
 * The server's proof that it holds `secret`, for a caller's `nonce`: HMAC-SHA256 over a fixed
 * label and the nonce, base64url. The label keeps the MAC from meaning anything anywhere else.
 * `native/Sources/FremkitCore/AccessProof.swift` computes the same and must stay in step.
 */
export function accessProof(secret: string, nonce: string): string {
  return createHmac('sha256', secret).update(`fremkit-access-proof-v1:${nonce}`).digest('base64url')
}

export function isPublicRoute(method: string, routeUrl: string | undefined): boolean {
  const m = method.toUpperCase()
  if (m !== 'GET' && m !== 'HEAD') return false
  return routeUrl !== undefined && PUBLIC_ROUTES.has(routeUrl)
}

/**
 * The routes the browser extension reaches without the secret, as `METHOD url-pattern`.
 *
 * An extension cannot read a file only this user can read, so it pairs instead: it asks
 * (`POST /api/companion/pair`), the Edge shows a code, the user types it into the extension, which
 * proves it (`…/:requestId/confirm`, answered with the server's proof and the token) and
 * watches for a refusal (`POST /api/companion/pair/:requestId`); the socket (`/companion/ws`) then
 * asks for the token. Each of these checks the extension's origin itself, and the Host check still
 * applies. They are POSTs because Chrome sends no `Origin` on an extension's GET to a host it holds
 * a permission for, and a POST always carries it.
 * Refusing is not here: it stays behind the secret.
 *
 * Matched on the method and the route Fastify matched, like `PUBLIC_ROUTES`.
 */
export const COMPANION_ROUTES: ReadonlySet<string> = new Set([
  'POST /api/companion/pair',
  'POST /api/companion/pair/:requestId',
  'POST /api/companion/pair/:requestId/confirm',
  'GET /companion/ws',
])

export function isCompanionRoute(method: string, routeUrl: string | undefined): boolean {
  return routeUrl !== undefined && COMPANION_ROUTES.has(`${method.toUpperCase()} ${routeUrl}`)
}

/**
 * Where `/auth` may send the browser afterwards: a path on this server, nothing else.
 *
 * `//evil.example` and `/\evil.example` are protocol-relative to a browser, so a second slash or
 * a backslash right after the first is refused, as is anything with a control character.
 */
export function safeNext(next: unknown): string {
  if (typeof next !== 'string' || next.length === 0 || next.length > 2048) return '/'
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/'
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return '/'
  return next
}

export interface AccessGateOptions {
  /** The port the server listens on, which names the cookie. */
  port?: number
  /** A clock, for the tests. */
  now?: () => number
}

interface Session {
  created: number
  lastUsed: number
}

/** The key a session is held under: its id's hash, so the map never holds a usable id. */
function sessionKey(id: string): string {
  return createHash('sha256').update(id).digest('base64url')
}

/** The secret, the one-time codes it mints, the sessions they open, and the checks a request goes through. */
export class AccessGate {
  readonly cookie: string
  private readonly now: () => number
  /** Pending one-time codes and when each stops being valid, oldest first. */
  private readonly codes = new Map<string, number>()
  /** Open browser sessions, least recently used first. */
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly token: string, opts: AccessGateOptions = {}) {
    if (!isWellFormedToken(token)) throw new Error('the access secret is not a base64url string of at least 32 bytes')
    this.cookie = cookieName(opts.port)
    this.now = opts.now ?? Date.now
  }

  /** True when the request carries the secret as a bearer token, or a live session as our cookie. */
  isAuthorized(headers: { authorization?: string | string[]; cookie?: string | string[] }): boolean {
    return this.hasBearer(headers) || this.sessionOf(headers) !== undefined
  }

  /** True when the request carries the secret itself, as a bearer token. A session is not enough. */
  hasBearer(headers: { authorization?: string | string[] }): boolean {
    const bearer = readBearer(headers.authorization)
    return bearer !== undefined && safeEqual(bearer, this.token)
  }

  /**
   * The live session the request's cookie names, or undefined. A hit counts as a use, which is
   * what keeps an open page's session from going idle.
   */
  sessionOf(headers: { cookie?: string | string[] }): string | undefined {
    const id = readCookie(headers.cookie, this.cookie)
    if (id === undefined || !isWellFormedToken(id)) return undefined
    const key = sessionKey(id)
    const session = this.sessions.get(key)
    if (session === undefined) return undefined
    const now = this.now()
    if (now - session.lastUsed >= SESSION_IDLE_MS || now - session.created >= SESSION_MAX_MS) {
      this.sessions.delete(key)
      return undefined
    }
    if (now - session.lastUsed >= TOUCH_EVERY_MS) {
      session.lastUsed = now
      // Re-inserted, so the map stays ordered by last use and the eviction below drops the right one.
      this.sessions.delete(key)
      this.sessions.set(key, session)
    }
    return id
  }

  /** A new session id. The caller hands it to the browser in `setCookieHeader`. */
  openSession(): string {
    this.sweepSessions()
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) break
      this.sessions.delete(oldest)
    }
    const id = generateToken()
    const now = this.now()
    this.sessions.set(sessionKey(id), { created: now, lastUsed: now })
    return id
  }

  /** Ends one session. Its cookie stops working at once. */
  revokeSession(id: string): void {
    this.sessions.delete(sessionKey(id))
  }

  /** Ends every session: every browser and web view has to sign in again. */
  revokeAllSessions(): void {
    this.sessions.clear()
  }

  /** Sessions currently open, for the tests. */
  get sessionCount(): number {
    this.sweepSessions()
    return this.sessions.size
  }

  /** This server's answer to a proof challenge (see `accessProof`). */
  prove(nonce: string): string {
    return accessProof(this.token, nonce)
  }

  /** A new one-time code, valid for `CODE_TTL_MS`. */
  mintCode(): string {
    this.sweep()
    while (this.codes.size >= MAX_PENDING_CODES) {
      const oldest = this.codes.keys().next().value
      if (oldest === undefined) break
      this.codes.delete(oldest)
    }
    const code = generateToken()
    this.codes.set(code, this.now() + CODE_TTL_MS)
    return code
  }

  /**
   * True once for a code that was minted and has not expired; the code is gone afterwards,
   * whether it worked or not. The lookup walks every pending code with `safeEqual` rather than
   * asking the map, so how long it takes says nothing about which codes exist.
   */
  redeem(code: unknown): boolean {
    this.sweep()
    if (typeof code !== 'string' || !isWellFormedToken(code)) return false
    let found: string | undefined
    for (const pending of this.codes.keys()) {
      if (safeEqual(pending, code)) found = pending
    }
    if (found === undefined) return false
    this.codes.delete(found)
    return true
  }

  /**
   * The `Set-Cookie` value that hands a session to a browser. A browser-session cookie with no
   * expiry of its own: the server decides when the session ends, and forgets every one when it
   * stops.
   */
  setCookieHeader(sessionId: string): string {
    return `${this.cookie}=${sessionId}; Path=/; HttpOnly; SameSite=Strict`
  }

  /** The `Set-Cookie` value that removes the cookie. */
  clearCookieHeader(): string {
    return `${this.cookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
  }

  private sweep(): void {
    const now = this.now()
    for (const [code, expires] of this.codes) {
      if (expires <= now) this.codes.delete(code)
    }
  }

  private sweepSessions(): void {
    const now = this.now()
    for (const [key, s] of this.sessions) {
      if (now - s.lastUsed >= SESSION_IDLE_MS || now - s.created >= SESSION_MAX_MS) this.sessions.delete(key)
    }
  }
}
