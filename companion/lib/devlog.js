// What the page's hooks report, made safe to send: bounded text, a path with no query, no noise.

/** The longest error text or request path that leaves the tab. */
export const MAX_TEXT = 300

function show(v) {
  if (typeof v === 'string') return v
  if (v instanceof Error) return String(v)
  if (v !== null && typeof v === 'object') {
    try {
      const json = JSON.stringify(v)
      if (typeof json === 'string') return json
    } catch {
      // circular, or a toJSON that throws: fall through to the plain string
    }
  }
  return String(v)
}

/** The arguments of a `console.error` joined the way the console prints them. Never throws. */
export function errorText(args) {
  const parts = []
  try {
    for (const a of Array.from(args ?? [])) {
      try {
        parts.push(show(a))
      } catch {
        parts.push('[unprintable]')
      }
    }
    return parts.join(' ').slice(0, MAX_TEXT)
  } catch {
    return ''
  }
}

const DOWN = ['[vite] server connection lost', '[webpack-dev-server] Disconnected!', '[WDS] Disconnected!']
const UP = [
  '[vite] connected.',
  '[webpack-dev-server] Server started',
  '[webpack-dev-server] Hot Module Replacement enabled',
  '[webpack-dev-server] Live Reloading enabled',
]
const HOT = ['[vite] hot updated:', '[HMR] App is up to date', '[HMR] Updated modules']

/** What a dev server's console line says about it: `down`, `up`, `hot` (a reload landed) or null. */
export function hotReloadSignal(text) {
  if (typeof text !== 'string') return null
  if (DOWN.some((p) => text.startsWith(p))) return 'down'
  if (UP.some((p) => text.startsWith(p))) return 'up'
  if (HOT.some((p) => text.startsWith(p))) return 'hot'
  return null
}

/** The path of a URL, no query and no fragment; `/` when it does not parse. */
export function pathOf(url) {
  try {
    return new URL(url).pathname.slice(0, MAX_TEXT) || '/'
  } catch {
    return '/'
  }
}

/** Requests the dev tooling makes for itself, and aborts the page caused: not counted. */
export function isNoise(url, error) {
  if (typeof error === 'string' && error.includes('net::ERR_ABORTED')) return true
  const path = pathOf(url)
  return (
    path.endsWith('/favicon.ico') ||
    path.startsWith('/@vite/') ||
    path === '/__webpack_hmr' ||
    path.startsWith('/sockjs-node/') ||
    path.includes('.hot-update.')
  )
}

/** At most `perSecond` passes in any one second; the caller keeps counting what it refuses. */
export class RateLimiter {
  constructor(perSecond = 10, now = Date.now) {
    this.perSecond = perSecond
    this.now = now
    this.start = -Infinity
    this.used = 0
  }

  allow() {
    const t = this.now()
    if (t - this.start >= 1000) {
      this.start = t
      this.used = 0
    }
    if (this.used >= this.perSecond) return false
    this.used += 1
    return true
  }
}
