// Which pages Fremdev watches: the built-in development hosts plus the user's own patterns.
// A pattern is a bare host, with at most one `*` in its first label; nothing is listed by default.

/** Host permissions requested when the module is turned on (optional, never at install). */
export const BUILTIN_PERMISSION_ORIGINS = [
  'http://localhost/*',
  'https://localhost/*',
  'http://127.0.0.1/*',
  'https://127.0.0.1/*',
  'http://[::1]/*',
  'https://[::1]/*',
  '*://*.localhost/*',
  '*://*.test/*',
]

/**
 * Fremkit's own pages are never a dev tab: the admin open in the browser would be watched. Spelled
 * out per scheme: Chrome refuses a port under the `*` scheme ("Invalid port").
 */
export const FREMKIT_EXCLUDES = ['http', 'https'].flatMap((scheme) =>
  ['4242', '4243'].flatMap((port) =>
    ['127.0.0.1', 'localhost', '[::1]', '*.localhost'].map((host) => `${scheme}://${host}:${port}/*`),
  ),
)

// The server's two ports: the local one and the paired devices' listener. Another port (a second
// checkout on 4301, say) is a real dev server and stays watched.
const FREMKIT_PORTS = ['4242', '4243']

// Common two-label public suffixes: a wildcard over one would cover every site under it.
const PUBLIC_SUFFIXES = [
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'ne.jp', 'or.jp',
  'com.br', 'com.cn', 'com.mx', 'co.in', 'co.za', 'com.tr', 'com.tw', 'co.kr', 'com.sg', 'com.hk',
]
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]']

const isBuiltinHost = (host) => LOOPBACK.includes(host) || host.endsWith('.localhost') || host.endsWith('.test')

/** A user pattern as `{ pattern, permission }`, or null when it is not one we accept. */
export function parsePattern(input) {
  if (typeof input !== 'string') return null
  const pattern = input.trim().toLowerCase()
  if (!pattern || !/^[a-z0-9*.-]+$/.test(pattern)) return null
  const labels = pattern.split('.')
  if (labels.some((l) => l === '')) return null
  const stars = pattern.split('*').length - 1
  if (stars > 1) return null
  if (isBuiltinHost(pattern.replace('*', 'x'))) return null
  if (stars === 0) return { pattern, permission: `*://${pattern}/*` }
  // The star lives in the first label only, and what follows it keeps at least two labels.
  if (!labels[0].includes('*') || labels.length < 3) return null
  const rest = labels.slice(1)
  if (PUBLIC_SUFFIXES.includes(rest.join('.'))) return null
  // A wildcard over numeric labels would stand for IP addresses, not a name the user owns.
  if (rest.every((l) => /^\d+$/.test(l))) return null
  return { pattern, permission: `*://*.${labels.slice(1).join('.')}/*` }
}

function matches(host, pattern) {
  if (!pattern.includes('*')) return host === pattern
  const dot = pattern.indexOf('.')
  const first = pattern.slice(0, dot)
  const rest = pattern.slice(dot) // starts with the dot
  if (first === '*') return host.endsWith(rest) && host.length > rest.length
  const at = host.indexOf('.')
  if (at < 0 || host.slice(at) !== rest) return false
  const [head, tail] = first.split('*')
  const label = host.slice(0, at)
  return label.length >= head.length + tail.length && label.startsWith(head) && label.endsWith(tail)
}

/** Whether a page URL is a dev page: a built-in host or one of the user's accepted patterns. */
export function isDevUrl(url, patterns = []) {
  let u
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase()
  if ((LOOPBACK.includes(host) || host.endsWith('.localhost')) && FREMKIT_PORTS.includes(u.port)) return false
  if (isBuiltinHost(host)) return true
  return patterns.some((p) => typeof p === 'string' && matches(host, p))
}
