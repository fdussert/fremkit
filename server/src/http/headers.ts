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
 * wallpaper, a widget's proxied response, a printer snapshot.
 */
export const BYTE_ROUTES = [
  '/api/favicon',
  '/api/apps/icon/',
  '/api/backgrounds/',
  '/api/proxy/',
  '/api/bambu/',
  '/api/backup',
]

/** True when a request path is one of those routes, query string and all. */
export function isByteRoute(url: string): boolean {
  const path = url.split('?')[0]
  return BYTE_ROUTES.some((prefix) => (prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix))
}
