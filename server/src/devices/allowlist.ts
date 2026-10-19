/**
 * What a paired device may reach on the remote listener. Deny by default: anything not listed
 * here answers 404 there, exactly as if the route did not exist.
 *
 * Matched on the request *path* (the URL before its `?`), not on the route pattern: the UI is
 * served by `@fastify/static` under a `/*` route, so the pattern alone would say nothing about
 * whether `/index.html` or `/admin.html` is being asked for.
 *
 * Every entry is a strict shape over the raw path, and every segment is checked once
 * percent-decoded. The router and `@fastify/static` both decode and resolve what they are given,
 * so `/assets/%2e%2e/admin.html` or `/assets/..%2fadmin.html` would otherwise slip a file this
 * list never meant to serve through an entry that looks harmless.
 */

export type RemoteAccess = 'public' | 'token'

type Rule = { method: string; path: RegExp; access: RemoteAccess }

/** One path segment: anything but a slash. Decoded and vetted separately by `safeSegments`. */
const SEG = '[^/]+'

const RULES: Rule[] = [
  // The dashboard shell, before pairing: the page, its code, and the pairing call itself.
  { method: 'POST', path: /^\/api\/pair$/, access: 'public' },
  { method: 'GET', path: /^\/$/, access: 'public' },
  { method: 'GET', path: /^\/index\.html$/, access: 'public' },
  { method: 'GET', path: new RegExp(`^/assets(?:/${SEG})+$`), access: 'public' },
  { method: 'GET', path: /^\/favicon[A-Za-z0-9._-]*$/, access: 'public' },
  { method: 'GET', path: /^\/fremkit\.js$/, access: 'public' },
  { method: 'GET', path: new RegExp(`^/widgets/${SEG}(?:/${SEG})*/?$`), access: 'public' },

  // What a paired dashboard reads and talks to.
  { method: 'GET', path: /^\/api\/config$/, access: 'token' },
  { method: 'GET', path: /^\/api\/config\/status$/, access: 'token' },
  { method: 'GET', path: /^\/api\/widgets$/, access: 'token' },
  { method: 'GET', path: /^\/api\/themes$/, access: 'token' },
  { method: 'GET', path: new RegExp(`^/api/backgrounds/${SEG}$`), access: 'token' },
  { method: 'GET', path: /^\/api\/devices\/me$/, access: 'token' },
  { method: 'POST', path: /^\/api\/devices\/me\/brightness$/, access: 'token' },
  { method: 'GET', path: /^\/ws$/, access: 'token' },
  { method: 'GET', path: new RegExp(`^/api/proxy/${SEG}$`), access: 'token' },
  { method: 'POST', path: new RegExp(`^/api/proxy/${SEG}/conn$`), access: 'token' },
  { method: 'GET', path: /^\/api\/favicon$/, access: 'token' },
  { method: 'GET', path: new RegExp(`^/api/apps/icon/${SEG}$`), access: 'token' },
  { method: 'GET', path: /^\/api\/apps\/installed$/, access: 'token' },
]

/**
 * True when every segment of `path` is an ordinary name once decoded: no `.` or `..`, no
 * encoded slash or backslash, no NUL, and nothing that fails to decode.
 */
function safeSegments(path: string): boolean {
  if (path.includes('\\')) return false
  for (const raw of path.split('/').slice(1)) {
    let seg: string
    try {
      seg = decodeURIComponent(raw)
    } catch {
      return false
    }
    if (seg === '.' || seg === '..') return false
    if (/[/\\\0]/.test(seg)) return false
  }
  return true
}

/** How a remote request for `method` `path` is let in, or null when it is not let in at all. */
export function remoteAccess(method: string, path: string): RemoteAccess | null {
  const m = method.toUpperCase()
  if (!path.startsWith('/') || !safeSegments(path)) return null
  for (const rule of RULES) {
    if (rule.method === m && rule.path.test(path)) return rule.access
  }
  return null
}
