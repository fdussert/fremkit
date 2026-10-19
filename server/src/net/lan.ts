import { expandIpv6 } from './private.js'

/**
 * Whether a peer may talk to the remote listener at all: an address on a local network, or this
 * Mac itself.
 *
 * The listener binds every interface (`::`), because which of them the iPad comes in on — Wi-Fi,
 * Ethernet, IPv4 or IPv6 — is not known in advance and changes with DHCP. What it must not do is
 * answer the rest of the world: a VPN peer, a host on a global IPv6 address, anything a port
 * forward lets in. So the peer's address is judged on the socket, before TLS, and only these
 * ranges pass:
 *
 * - IPv4 private networks, RFC 1918: 10/8, 172.16/12, 192.168/16;
 * - IPv4 link-local, 169.254/16 (a Mac and an iPad on a cable, or a network with no DHCP);
 * - IPv6 unique local, fc00::/7, and link-local, fe80::/10;
 * - loopback, 127/8 and ::1: the Mac itself, which the tests use;
 * - IPv4-mapped forms of all the IPv4 ones (`::ffff:192.168.1.20`), which is how a dual-stack
 *   socket reports an IPv4 peer.
 *
 * Nothing else carries an IPv4 here: a 6to4 or NAT64 address that *embeds* a private IPv4 still
 * arrives from the internet, so unlike `isPrivateAddress` (which asks where a request would go),
 * this asks where it came from and reads only the mapped form.
 *
 * Two ranges inside those are refused by name because a VPN is known to hand them out:
 * Tailscale's 100.64/10 (CGNAT, a carrier's network anyway) and its IPv6 ULA fd7a:115c:a1e0::/48.
 * What this cannot do is tell a home network from a VPN that uses the same private ranges — a
 * WireGuard or OpenVPN tunnel on 10/8 or 172.16/12, ZeroTier on its own fc/fd prefix: a peer there
 * is let in like any LAN peer, and still needs a live code or a device token to get anywhere.
 *
 * Pure: the address in, a yes or no out. Anything that does not parse is refused.
 */
export function isLanPeer(address: string | undefined | null): boolean {
  if (typeof address !== 'string') return false
  // A link-local IPv6 peer is reported with its zone (`fe80::1%en0`): the zone names our
  // interface, not the address.
  const ip = address.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%[^%]*$/, '')
  if (ip === '') return false
  if (!ip.includes(':')) return isLanIpv4(ip)
  const groups = expandIpv6(ip)
  if (!groups) return false
  // IPv4-mapped, ::ffff:a.b.c.d, in either spelling.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [a, b] = [groups[6], groups[7]]
    return isLanIpv4([a >>> 8, a & 0xff, b >>> 8, b & 0xff].join('.'))
  }
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true // ::1
  const first = groups[0]
  // Tailscale's ULA, fd7a:115c:a1e0::/48: a tailnet, not the local network.
  if (first === 0xfd7a && groups[1] === 0x115c && groups[2] === 0xa1e0) return false
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7, unique local
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10, link-local
  return false
}

function isLanIpv4(ip: string): boolean {
  const parts = ip.split('.')
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return false
  const [a, b] = parts.map(Number)
  // 100.64/10, CGNAT and Tailscale's IPv4 range: refused, as everything not listed below is.
  if (a === 10) return true // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 168) return true // 192.168/16
  if (a === 169 && b === 254) return true // link-local
  if (a === 127) return true // loopback: this Mac
  return false
}
