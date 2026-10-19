import { ref } from 'vue'

/**
 * Whether this page was loaded by a paired device rather than by the Mac. The Mac's own server
 * listens on plain HTTP on the loopback only; a paired device reaches the TLS listener, so HTTPS
 * is what tells the two apart. It lives in `shared/` because the socket needs it too, and the
 * socket must not import from the dashboard.
 */
export function isRemotePage(loc: Pick<Location, 'protocol'> = location): boolean {
  return loc.protocol === 'https:'
}

/**
 * Set once the server has refused this paired device: it was revoked, or the Mac no longer knows
 * it. Shared between the socket, which notices it when the connection drops, and the dashboard,
 * which shows it. It never goes back to false: only a new pairing, which reloads the page, can.
 */
export const deviceUnauthorized = ref(false)
