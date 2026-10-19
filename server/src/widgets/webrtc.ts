/**
 * Which widgets may use WebRTC, and how much of it.
 *
 * WebRTC is the one network door a widget's CSP cannot close: `connect-src 'none'` stops fetch,
 * XHR, WebSocket, EventSource and WebTransport, but not a peer connection. A STUN or TURN server
 * named in its configuration, or a remote candidate in a hand-written SDP, sends packets wherever
 * the widget likes, with whatever it likes in them — no `permissions.network`, no consent dialog.
 * So the bridge (`server/src/bridge/fremkit.js`), which runs before any of the widget's own code,
 * takes it away, and only this file decides otherwise.
 *
 * Two levels:
 *
 * - `none`, every widget's: `RTCPeerConnection`, `webkitRTCPeerConnection`, `RTCDataChannel`,
 *   `RTCSessionDescription` and `RTCIceCandidate` are `undefined`, non-writable and
 *   non-configurable on the widget's window.
 * - `local`: a wrapped `RTCPeerConnection` that has no ICE server whatever it is given, and drops
 *   every candidate — local or remote, in an SDP or on its own — that is not a host candidate on
 *   loopback or on one of this Mac's own addresses. The original constructor and methods stay in
 *   the bridge's closure, out of the widget's reach. A peer on this Mac (a browser tab, an app)
 *   can still reach the widget; nothing else can be reached from it.
 *
 * `local` is for built-in widgets only, by id, from the list below — reviewed with the server and
 * shipped with it. A widget installed from the registry never gets it: not from its manifest, not
 * through the consent dialog, not by taking a built-in's id (an installed folder is never the
 * `builtin` source). A built-in that needs a local peer adds its id here, in the commit that adds
 * the widget, and says why:
 *
 * - `fremplay` receives a browser tab's video from the Fremkit Companion extension, in the same
 *   browser profile on this Mac. It answers the extension's offer, which the server relays on the
 *   `companion` channel; the media goes peer to peer, and neither side names an ICE server.
 */

import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { WidgetSource } from './catalog.js'

export type WebRtcLevel = 'none' | 'local'

/** Built-in widgets allowed the `local` level, each for the reason given above. */
export const WEBRTC_LOCAL_BUILTINS: ReadonlySet<string> = new Set<string>(['fremplay'])

/** The level a widget's frame runs at. Anything but a listed built-in is `none`. */
export function webrtcLevel(
  id: string,
  source: WidgetSource | undefined,
  allowed: ReadonlySet<string> = WEBRTC_LOCAL_BUILTINS,
): WebRtcLevel {
  return source === 'builtin' && allowed.has(id) ? 'local' : 'none'
}

/**
 * This Mac's own addresses, the hosts a `local` peer connection may exchange packets with besides
 * loopback. Read at each request: a DHCP lease or a VPN moves them. Only IP literals, which is
 * also what makes them safe to write into an HTML attribute.
 */
export function hostAddresses(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const out = new Set<string>()
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      // A link-local IPv6 address carries its zone (`fe80::1%en0`) in `scopeid`, not in the text.
      const address = entry.address.toLowerCase()
      if (isIP(address)) out.add(address)
    }
  }
  return [...out]
}
