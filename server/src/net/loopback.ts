/**
 * The addresses that mean "this machine".
 *
 * Shared by the Dock hook routes and the WebSocket hub, so a socket and a POST are judged local
 * by exactly the same rule: anything that can drive the Mac (activating an app, reporting the
 * Dock) has to come from the Mac.
 */
export const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address)
}
