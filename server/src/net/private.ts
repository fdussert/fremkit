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

/** True for an IPv4 or IPv6 literal that names this machine, a LAN, or a reserved range. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.trim().toLowerCase().replace(/^\[|\]$/g, '')
  // An IPv4-mapped IPv6 address is judged on the IPv4 it carries.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip)
  if (mapped) return isPrivateAddress(mapped[1])
  if (ip.includes(':')) return isPrivateIpv6(ip)
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

function isPrivateIpv6(ip: string): boolean {
  if (ip === '::' || ip === '::1') return true
  if (/^f[cd]/.test(ip)) return true                        // fc00::/7, unique local
  if (/^fe[89ab]/.test(ip)) return true                     // fe80::/10, link-local
  if (/^ff/.test(ip)) return true                           // multicast
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
