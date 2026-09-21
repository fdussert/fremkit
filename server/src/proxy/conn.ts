/**
 * Matching a request a widget asks for against the requests it declared.
 *
 * This is the allow-list the whole declared-connection feature rests on. A widget names a method
 * and a path; the proxy holds the user's credentials and will make exactly the calls that were
 * shown in the consent dialog, and no others. So the matcher errs towards refusing: it compares
 * segment by segment against a pattern the schema has already vetted, and knows nothing about
 * encodings, case folding or path traversal, because it never sees a path that could carry any
 * of those — `checkPath` refuses those before the match is even attempted.
 */

import type { ConnectionDecl } from '../widgets/manifest.js'

/** A request a widget is asking the proxy to make. */
export interface ConnRequest { method: string; path: string }

/**
 * Whether a concrete path is one this pattern allows.
 *
 * `*` is exactly one segment. `**` is the rest, *including none* — a declaration for
 * `/api/devices/**` covers listing the collection itself, which is what an author writing that
 * pattern means.
 *
 * Everything else is a literal, compared exactly: no case folding, because a service's routes
 * may be case-sensitive and being lenient here would let `/API/Admin` through a rule written
 * for `/api/admin`.
 */
export function pathMatches(pattern: string, path: string): boolean {
  const want = pattern.slice(1).split('/')
  const got = path.slice(1).split('/')
  for (let i = 0; i < want.length; i++) {
    if (want[i] === '**') return true
    if (i >= got.length) return false
    if (want[i] === '*') continue
    if (want[i] !== got[i]) return false
  }
  return want.length === got.length
}

/**
 * A path a widget may be asking for, or null.
 *
 * Refused before any matching: a path that is not rooted, carries a query or a fragment, or
 * holds a `.`, `..` or an empty segment. The last three matter most — a service's own router may
 * collapse them, so `/api/flow/../admin` could match a pattern for `/api/flow/*` here and arrive
 * as `/api/admin` there. Percent-encodings that decode to a slash or a dot are refused for the
 * same reason: the matcher must be looking at the same string the service will route on.
 */
export function checkPath(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2000) return null
  if (!raw.startsWith('/')) return null
  if (raw.includes('?') || raw.includes('#') || raw.includes('\\')) return null
  // A control character in a URL is a header-splitting attempt or a truncation one; a NUL is
  // both, and some parsers stop reading at it while others do not.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null
  // `%2e` is `.` and `%2f` is `/`; either would make the service route on a path this matcher
  // never saw. There is no legitimate reason for a widget to send one.
  if (/%(?:2e|2f|5c)/i.test(raw)) return null
  const segments = raw.slice(1).split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null
  return raw
}

/** The declared request that allows this call, or undefined when nothing does. */
export function allowedRequest(decl: ConnectionDecl, req: ConnRequest): ConnectionDecl['requests'][number] | undefined {
  return decl.requests.find((r) => r.method === req.method && pathMatches(r.path, req.path))
}

/**
 * The headers a widget is allowed to set on a `conn:` request.
 *
 * Two, and only these two. A header is a way to reach past the proxy: `Authorization` would
 * override the secret the server just injected, `Cookie` would turn a stateless call into a
 * session, `X-Forwarded-*` lies to whatever sits in front of the service, and `Host` picks a
 * different virtual host at the same address. The widget is describing its *body*, which is all
 * these two do.
 */
export const ALLOWED_REQUEST_HEADERS = ['content-type', 'accept'] as const

export function checkHeaders(headers: Record<string, string> | undefined): Record<string, string> | null {
  if (!headers) return {}
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (!(ALLOWED_REQUEST_HEADERS as readonly string[]).includes(lower)) return null
    if (typeof value !== 'string' || value.length > 200 || /[\r\n]/.test(value)) return null
    out[lower] = value
  }
  return out
}

/**
 * A tiny per-connection cache, so two widgets on one screen do not poll a service twice.
 *
 * Keyed by connection id *and* path, never by widget: the point is that the second widget is
 * served what the first already fetched. Only GETs, and only for the time the declaration named
 * — a write is never cached, and an answer past its `cacheMs` is simply not there.
 */
export class ConnCache {
  private entries = new Map<string, { at: number; status: number; body: Buffer; json: boolean }>()

  constructor(private readonly now: () => number = Date.now) {}

  private key(connectionId: string, path: string): string { return `${connectionId}\u0000${path}` }

  get(connectionId: string, path: string, maxAgeMs: number): { status: number; body: Buffer; json: boolean } | undefined {
    const hit = this.entries.get(this.key(connectionId, path))
    if (!hit) return undefined
    if (this.now() - hit.at > maxAgeMs) { this.entries.delete(this.key(connectionId, path)); return undefined }
    return { status: hit.status, body: hit.body, json: hit.json }
  }

  put(connectionId: string, path: string, value: { status: number; body: Buffer; json: boolean }): void {
    this.entries.set(this.key(connectionId, path), { ...value, at: this.now() })
    // A cache with no ceiling is a leak with a nice name. The oldest goes first, and 200 entries
    // is far more than the handful of paths a screenful of widgets asks for.
    if (this.entries.size > 200) this.entries.delete(this.entries.keys().next().value as string)
  }

  /** Everything this connection cached, dropped — after a write, and when its secret changes. */
  forget(connectionId: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(`${connectionId}\u0000`)) this.entries.delete(key)
    }
  }
}
