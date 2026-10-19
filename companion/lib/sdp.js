// The extension's own offer, filtered before it leaves the browser. The extension cannot list this
// Mac's addresses, so it keeps loopback, the private and link-local ranges and `.local` names;
// `isLocalSdp` in server/src/companion/protocol.ts then takes only loopback, `.local` and the Mac's
// own addresses, which a host candidate always is. Keep the extension's set the wider one.

// Strict dotted quad: four decimal octets in 0..255, no leading zeros (what net.isIP accepts).
function isIPv4(s) {
  const parts = s.split('.')
  return parts.length === 4 && parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255)
}

// The shape net.isIP accepts: hex groups of 1-4 digits, at most one `::`, an optional trailing IPv4.
function isIPv6(s) {
  if (s.split('::').length > 2 || /:::/.test(s)) return false
  const compressed = s.includes('::')
  let count = 0
  const parts = s.split(':')
  for (let i = 0; i < parts.length; i++) {
    const g = parts[i]
    if (g === '') continue
    if (i === parts.length - 1 && g.includes('.')) {
      if (!isIPv4(g)) return false
      count += 2
    } else if (/^[0-9a-f]{1,4}$/i.test(g)) count += 1
    else return false
  }
  // Without `::` every group is present; with it at least one is elided. A lone leading or trailing `:` is malformed.
  if (compressed) return count < 8 && !(s.startsWith(':') && !s.startsWith('::')) && !(s.endsWith(':') && !s.endsWith('::'))
  return count === 8 && !parts.includes('')
}

function isLocalAddress(address) {
  if (address.endsWith('.local') && address.length > '.local'.length) return /^[a-z0-9.-]+$/i.test(address)
  const bare = address.split('%')[0].toLowerCase()
  if (isIPv4(bare)) {
    const [a, b] = bare.split('.').map(Number)
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  if (isIPv6(bare)) {
    if (bare === '::1') return true
    const first = bare.split(':')[0]
    if (first.length !== 4) return false
    const value = parseInt(first, 16)
    return (value >= 0xfe80 && value <= 0xfebf) || (value >= 0xfc00 && value <= 0xfdff)
  }
  return false
}

/** Drops every candidate that is not a `host` candidate on a loopback, private, link-local or `.local` address. */
export function localCandidatesOnly(sdp) {
  return sdp
    .split(/(?<=\n)/)
    .filter((line) => {
      if (!line.startsWith('a=candidate:')) return true
      const fields = line.trim().split(/\s+/)
      return fields[6] === 'typ' && fields[7] === 'host' && isLocalAddress(fields[4] ?? '')
    })
    .join('')
}

/**
 * Each `host` candidate on a `.local` name written on 127.0.0.1 instead, so a receiver that only
 * dials loopback or this Mac's own addresses can reach it.
 *
 * Chrome hides a page's addresses behind mDNS names (`<uuid>.local`), and the socket behind such
 * a name answers on loopback too (checked in Chrome and a WKWebView configured like the kiosk). The Fremplay widget runs under the bridge's `local` WebRTC level
 * (server/src/widgets/webrtc.ts), which refuses a remote `.local` name: resolving it asks the
 * whole network. With only that name in the offer, the receiver has nothing to dial, and Chrome
 * does not reach the WKWebView's own `.local` name either, so the share never connects. The
 * receiver is on this Mac, so loopback reaches the same socket.
 */
export function loopbackForMdns(sdp) {
  return sdp
    .split(/(?<=\n)/)
    .map((line) => {
      if (!line.startsWith('a=candidate:')) return line
      const fields = line.split(' ')
      const address = fields[4] ?? ''
      if (fields[6] !== 'typ' || fields[7]?.trim() !== 'host' || !address.endsWith('.local')) return line
      fields[4] = '127.0.0.1'
      return fields.join(' ')
    })
    .join('')
}

/** The offer the offscreen document sends: local candidates only, mDNS names on loopback. */
export function offerSdp(sdp) {
  return loopbackForMdns(localCandidatesOnly(sdp))
}

// The receiver is the kiosk on this Mac, behind the bridge's `local` WebRTC level: loopback, or a
// `.local` name the browser resolves itself, is all an answer needs to say.
function isLoopbackAddress(address) {
  if (address.endsWith('.local') && address.length > '.local'.length) return /^[a-z0-9.-]+$/i.test(address)
  if (isIPv4(address)) return address.startsWith('127.')
  return address.toLowerCase() === '::1'
}

function isLoopbackCandidate(line) {
  const fields = line.trim().split(/\s+/)
  return fields[6] === 'typ' && fields[7] === 'host' && isLoopbackAddress(fields[4] ?? '')
}

/** `c=IN IP4 127.x.x.x` or `0.0.0.0`, `c=IN IP6 ::1` or `::`: nothing that names another host. */
function isLoopbackConnection(line) {
  const m = /^c=IN (IP4|IP6) ([^\s/]+)(\/\d+)*$/.exec(line.trim())
  if (!m) return false
  const address = m[2].toLowerCase()
  return m[1] === 'IP4' ? address === '0.0.0.0' || (isIPv4(address) && address.startsWith('127.')) : address === '::1' || address === '::'
}

/**
 * The receiver's answer as the offscreen document applies it: every candidate that is not a
 * `host` one on loopback (127.0.0.0/8, ::1) or a `.local` name dropped. Null when a `c=` line
 * names an address other than loopback or the unspecified one: such an answer is refused whole.
 * Defence in depth, not a boundary: ICE learns peer-reflexive addresses from incoming checks, and
 * the socket's challenge proof is what keeps an impostor from ever answering an offer.
 */
export function loopbackAnswer(sdp) {
  if (typeof sdp !== 'string') return null
  const lines = sdp.split(/(?<=\n)/)
  if (lines.some((line) => line.startsWith('c=') && !isLoopbackConnection(line))) return null
  return lines.filter((line) => !line.startsWith('a=candidate:') || isLoopbackCandidate(line)).join('')
}
