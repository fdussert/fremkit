/**
 * The protective headers every answer carries.
 *
 * The server has no authentication by design: it listens on loopback and trusts its own origin
 * for the WebSocket and the connections API. That makes its origin worth stealing, and the
 * cheapest way to steal it is to get a browser to treat one of our answers as a document —
 * an icon that is really an SVG, a proxied response that claims to be HTML. `nosniff` stops the
 * re-guessing, and the CSP below makes such a document inert even if one gets through.
 */

/** Nothing loads, nothing runs, and the document is thrown into a unique opaque origin. */
export const BYTES_CSP = "default-src 'none'; sandbox"

/**
 * The routes that answer with bytes we did not write: a site's favicon, an application icon, a
 * wallpaper, an imported tile icon, a widget's proxied response, a printer snapshot.
 */
export const BYTE_ROUTES = [
  '/api/favicon',
  '/api/apps/icon/',
  '/api/backgrounds/',
  '/api/tile-icons/',
  '/api/proxy/',
  '/api/bambu/',
  '/api/backup',
  '/api/marketplace/preview/',
]

/** True when a request path is one of those routes, query string and all. */
export function isByteRoute(url: string): boolean {
  const path = url.split('?')[0]
  return BYTE_ROUTES.some((prefix) => (prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix))
}

/**
 * The policy of the pages we write ourselves: the dashboard and the admin.
 *
 * Its first job is `frame-src`: a widget frame may navigate itself, and the only place it may go
 * is another widget document (`/widgets/…`, served under the widget CSP with the bridge first).
 * Without it a widget sent its data off in the URL of its own frame (`location = 'https://…?d=…'`),
 * since a sandboxed frame may always navigate itself. The rest is the usual: our own scripts and
 * nothing else, no plugins, no `<base>`, never framed by another page.
 *
 * Written for the origin the page was loaded from — `host` is the request's Host, already checked
 * against the names this server answers to (the loopback gate, or the devices gate on 4243) — so
 * the WebSocket and the widget paths are named exactly, on 4242, a second checkout's port, or
 * `https://<mac>:4243` for a paired device. `ws:`/`wss:` are spelled out rather than left to
 * `'self'`, which older WebKit does not stretch to WebSockets. Vite's dev server serves the same
 * pages in development with its own variant: `ui/vite.config.ts`.
 */
export function hostCsp(host: string, secure = false): string {
  const http = `${secure ? 'https' : 'http'}://${host}`
  const ws = `${secure ? 'wss' : 'ws'}://${host}`
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${ws}`,
    `frame-src ${http}/widgets/`,
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}
