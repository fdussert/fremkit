import { lookup } from 'node:dns/promises'

/**
 * Addresses a widget's proxy request must never reach.
 *
 * The proxy fetches a URL on a widget's behalf, and the widget is third-party code. Without this,
 * a manifest declaring `permissions.network: ["127.0.0.1"]` — or any host that merely *resolves*
 * to a private address — turns the proxy into a way to read this machine's own services: the
 * Fremkit API itself, a printer, a router's admin page, a cloud metadata endpoint.
 *
 * The check runs twice, because either alone can be fooled. The manifest is judged when it is
 * read, which catches the obvious literal; the resolved address is judged at request time, which
 * catches a name that points at 127.0.0.1 today and somewhere else tomorrow. Neither closes the
 * gap between our lookup and the one `fetch` does — that is a rebinding race no application-level
 * check can win — but a widget cannot reach a private address by simply asking for one.
 */

/**
 * The eight groups of an IPv6 literal, or null when it is not one.
 *
 * `::` is expanded, and a trailing dotted-quad (`::ffff:127.0.0.1`) becomes the two groups it
 * stands for. Anything that does not come out as exactly eight 16-bit groups is refused by the
 * caller rather than guessed at.
 */
export function expandIpv6(address: string): number[] | null {
  let text = address.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!text.includes(':')) return null
  // A trailing IPv4 part occupies the last two groups.
  const dotted = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)
  let tail: number[] = []
  if (dotted) {
    const octets = dotted[1].split('.').map(Number)
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null
    tail = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]]
    text = text.slice(0, text.length - dotted[1].length) + '0'
  }
  const runs = text.split('::')
  if (runs.length > 2) return null
  const parse = (part: string): number[] | null => {
    if (part === '') return []
    const groups: number[] = []
    for (const piece of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null
      groups.push(parseInt(piece, 16))
    }
    return groups
  }
  const head = parse(runs[0])
  if (!head) return null
  if (runs.length === 1) {
    // No `::`, so every group is spelled out. The placeholder group from the dotted-quad
    // rewrite above is dropped and replaced by `tail`.
    const groups = dotted ? [...head.slice(0, -1), ...tail] : head
    return groups.length === 8 ? groups : null
  }
  const rest = parse(runs[1])
  if (!rest) return null
  const explicit = dotted ? [...rest.slice(0, -1), ...tail] : rest
  const fill = 8 - head.length - explicit.length
  if (fill < 1) return null
  return [...head, ...Array(fill).fill(0), ...explicit]
}

/**
 * The IPv4 an IPv6 address carries, or null when it carries none.
 *
 * Two forms do: the IPv4-mapped `::ffff:a.b.c.d` and the deprecated IPv4-compatible
 * `::a.b.c.d`, whose first six groups are zero (or `0…0:ffff`). Both reach the same IPv4 stack,
 * and `new URL()` canonicalises them to hex — `[::ffff:127.0.0.1]` becomes `[::ffff:7f00:1]` —
 * which is how a loopback address got past a check that only knew the dotted spelling.
 */
export function embeddedIpv4(groups: number[]): string | null {
  if (groups.length !== 8) return null
  if (groups.slice(0, 5).some((g) => g !== 0)) return null
  const marker = groups[5]
  if (marker !== 0xffff && marker !== 0) return null
  const [a, b] = [groups[6], groups[7]]
  // `::` and `::1` are not IPv4 addresses; they are handled as IPv6 in their own right.
  if (marker === 0 && (a >>> 8) === 0 && (a & 0xff) === 0) return null
  return [a >>> 8, a & 0xff, b >>> 8, b & 0xff].join('.')
}

/** True for an IPv4 or IPv6 literal that names this machine, a LAN, or a reserved range. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (ip.includes(':')) {
    const groups = expandIpv6(ip)
    // Not an address we can read: refuse it rather than let it through.
    if (!groups) return true
    const carried = embeddedIpv4(groups)
    // An address carrying an IPv4 reaches the IPv4 stack, so it is judged as that IPv4.
    if (carried) return isPrivateIpv4(carried)
    return isPrivateIpv6Groups(groups)
  }
  return isPrivateIpv4(ip)
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.')
  if (parts.length !== 4) return true // not an address we can judge: refuse it
  const [a, b] = parts.map(Number)
  if (parts.some((p) => p === '' || !/^\d{1,3}$/.test(p)) || [a, b].some((n) => n > 255)) return true
  if (a === 0) return true                                  // "this network", and 0.0.0.0
  if (a === 10) return true                                 // private
  if (a === 127) return true                                // loopback
  if (a === 100 && b >= 64 && b <= 127) return true          // carrier-grade NAT
  if (a === 169 && b === 254) return true                    // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true           // private
  if (a === 192 && b === 168) return true                    // private
  if (a === 192 && b === 0) return true                      // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true        // benchmarking
  if (a >= 224) return true                                 // multicast, reserved, broadcast
  return false
}

/** Judged on the expanded groups, so no spelling can hide a range. */
function isPrivateIpv6Groups(groups: number[]): boolean {
  const first = groups[0]
  if (groups.every((g) => g === 0)) return true              // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true // ::1, loopback
  if ((first & 0xfe00) === 0xfc00) return true               // fc00::/7, unique local
  if ((first & 0xffc0) === 0xfe80) return true               // fe80::/10, link-local
  if ((first & 0xff00) === 0xff00) return true               // ff00::/8, multicast
  return false
}

/**
 * True when a host is written as an address at all: an IPv4 or IPv6 literal, bracketed or not.
 *
 * A name is not judged here — it has to be resolved first — so `isPrivateLiteral` answers "no"
 * for `api.open-meteo.com` rather than guessing.
 */
export function isAddressLiteral(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '')
  return /^[\d.]+$/.test(bare) || bare.includes(':')
}

/** True for a host written as a private or local address. A name always answers false. */
export function isPrivateLiteral(host: string): boolean {
  return isAddressLiteral(host) && isPrivateAddress(host)
}

/** Just the shape of `dns.lookup` this module uses, so a test can stand in for it. */
export type LookupAll = (
  host: string,
  options: { all: true; verbatim: true },
) => Promise<{ address: string; family: number }[]>

/**
 * True when a host is private, or resolves to a private address.
 *
 * A literal is judged without a lookup. A name that cannot be resolved counts as private: we are
 * about to refuse the request anyway, and answering "not private" for a host we know nothing
 * about is the wrong default.
 */
export async function resolvesToPrivate(host: string, resolve: LookupAll = lookup): Promise<boolean> {
  if (isAddressLiteral(host)) return isPrivateAddress(host)
  try {
    const addresses = await resolve(host, { all: true, verbatim: true })
    if (!addresses.length) return true
    return addresses.some((a) => isPrivateAddress(a.address))
  } catch {
    return true
  }
}
