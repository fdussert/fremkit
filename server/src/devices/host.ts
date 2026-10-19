import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { execFileAsync, type Exec } from '../secrets/keychain.js'

/** What a Bonjour local host name may contain; anything else is treated as unknown. */
const HOST_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

/** An interface name as `route` prints it (`en0`, `utun3`, `bridge100`). */
const INTERFACE_RE = /^[A-Za-z][A-Za-z0-9]{0,15}$/

/** The interfaces and their addresses, as `os.networkInterfaces()` returns them. */
export type InterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>

/**
 * The Mac's Bonjour name (`<name>.local` on the LAN), from `scutil --get LocalHostName`.
 * Null when the command fails or prints something that is not a plain host label.
 */
export async function localHostName(exec: Exec = execFileAsync): Promise<string | null> {
  try {
    const { stdout } = await exec('/usr/sbin/scutil', ['--get', 'LocalHostName'])
    const name = stdout.trim()
    return HOST_NAME_RE.test(name) ? name : null
  } catch {
    return null
  }
}

/** The name a Bonjour service instance may carry: 63 bytes of UTF-8 at most. */
const SERVICE_NAME_MAX_BYTES = 63

/**
 * The Mac's name as its owner sees it (`scutil --get ComputerName`), which is what the device app
 * lists. Trimmed and cut to 63 bytes on a character boundary; `Fremkit` when the command fails or
 * prints nothing.
 */
export async function computerName(exec: Exec = execFileAsync): Promise<string> {
  try {
    const { stdout } = await exec('/usr/sbin/scutil', ['--get', 'ComputerName'])
    let name = stdout.trim()
    while (Buffer.byteLength(name) > SERVICE_NAME_MAX_BYTES) name = Array.from(name).slice(0, -1).join('')
    name = name.trimEnd()
    return name === '' ? 'Fremkit' : name
  } catch {
    return 'Fremkit'
  }
}

function octets(address: string): number[] {
  return address.split('.').map(Number)
}

/**
 * Addresses a device on the LAN can never reach the Mac at: link-local (169.254/16, what an
 * interface falls back to with no DHCP) and carrier-grade NAT (100.64/10, Tailscale's range).
 */
function unreachable(address: string): boolean {
  const [a, b] = octets(address)
  return (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
}

/** RFC 1918: 10/8, 172.16/12, 192.168/16. */
export function isPrivate(address: string): boolean {
  const [a, b] = octets(address)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

function usable(info: NetworkInterfaceInfo): boolean {
  return info.family === 'IPv4' && !info.internal && !unreachable(info.address)
}

/**
 * The IPv4 addresses a device on the LAN may reach the Mac at, deduplicated and sorted: every
 * non-internal interface's, less link-local and carrier-grade NAT ones. These are the
 * certificate's SANs and the remote listener's Host allow-list.
 */
export function lanAddresses(ifaces: InterfaceMap = networkInterfaces()): string[] {
  const out = new Set<string>()
  for (const list of Object.values(ifaces)) {
    for (const info of list ?? []) {
      if (usable(info)) out.add(info.address)
    }
  }
  return [...out].sort()
}

/** The interface the default route goes out of (`route -n get default`), or null. */
export async function defaultRouteInterface(exec: Exec = execFileAsync): Promise<string | null> {
  try {
    const { stdout } = await exec('/sbin/route', ['-n', 'get', 'default'])
    const m = /^\s*interface:\s*(\S+)\s*$/m.exec(stdout)
    return m && INTERFACE_RE.test(m[1]) ? m[1] : null
  } catch {
    return null
  }
}

/**
 * The one address the pairing QR code carries, among `addresses`: the default-route interface's
 * first, then any RFC 1918 address on an `en*` interface (Wi-Fi, Ethernet), then the first one
 * left. A VPN or a bridge that happens to sort first is not what an iPad on the LAN can reach.
 */
export function pickAddress(addresses: string[], ifaces: InterfaceMap, defaultInterface: string | null): string | null {
  const allowed = new Set(addresses)
  const of = (name: string): string[] =>
    (ifaces[name] ?? []).filter((i) => usable(i) && allowed.has(i.address)).map((i) => i.address).sort()
  if (defaultInterface !== null) {
    const first = of(defaultInterface)[0]
    if (first !== undefined) return first
  }
  const ethernet = Object.keys(ifaces).filter((n) => /^en\d+$/.test(n)).sort((x, y) => Number(x.slice(2)) - Number(y.slice(2)))
  for (const name of ethernet) {
    const first = of(name).find(isPrivate)
    if (first !== undefined) return first
  }
  return addresses[0] ?? null
}

/** Wi-Fi and Ethernet, built in or plugged in: `en0`, `en7`. */
function isEthernet(name: string): boolean {
  return /^en\d+$/.test(name)
}

/**
 * The addresses among `addresses` an iPad on the LAN may be told to look for the Mac at: RFC 1918
 * ones on a Wi-Fi or Ethernet interface (`en*`), the default route's interface first when it is
 * one, then by interface number. A VPN's `utun*` (a company network on 10/8 is private too), a
 * virtual machine's `bridge100` or `vmnet*` are never listed: the iPad cannot reach them, and the
 * list would tell it about networks the Mac is on.
 */
export function appAddresses(addresses: string[], ifaces: InterfaceMap, defaultInterface: string | null): string[] {
  const allowed = new Set(addresses.filter(isPrivate))
  const names = Object.keys(ifaces).filter(isEthernet).sort((x, y) => Number(x.slice(2)) - Number(y.slice(2)))
  if (defaultInterface !== null && names.includes(defaultInterface)) {
    names.splice(names.indexOf(defaultInterface), 1)
    names.unshift(defaultInterface)
  }
  const out: string[] = []
  for (const name of names) {
    for (const address of (ifaces[name] ?? []).filter((i) => usable(i) && allowed.has(i.address)).map((i) => i.address).sort()) {
      if (!out.includes(address)) out.push(address)
    }
  }
  return out
}

/** `appAddresses` on this Mac's own interfaces and default route. */
export async function lanAppAddresses(addresses: string[], exec: Exec = execFileAsync): Promise<string[]> {
  return appAddresses(addresses, networkInterfaces(), await defaultRouteInterface(exec))
}

/** How long `cachedPick` keeps an answer for the same addresses. */
export const PICK_TTL_MS = 30_000

/**
 * `pick` remembered for `ttlMs` per address list: the same list asked again within that time gets
 * the same answer without running `pick` (for `lanAppAddresses`, `route -n get default`) again;
 * another list, or an older answer, asks again. Concurrent asks for one list share one lookup.
 */
export function cachedPick<T>(
  pick: (addresses: string[]) => Promise<T>,
  ttlMs = PICK_TTL_MS,
  now: () => number = Date.now,
): (addresses: string[]) => Promise<T> {
  let last: { key: string; at: number; answer: Promise<T> } | null = null
  return (addresses) => {
    const key = addresses.join(',')
    const t = now()
    if (last !== null && last.key === key && t - last.at < ttlMs) return last.answer
    const answer = pick(addresses)
    const entry = { key, at: t, answer }
    last = entry
    // A failed lookup is not kept.
    answer.catch(() => { if (last === entry) last = null })
    return answer
  }
}

/** `pickAddress` on this Mac's own interfaces and default route. */
export async function preferredAddress(addresses: string[], exec: Exec = execFileAsync): Promise<string | null> {
  return pickAddress(addresses, networkInterfaces(), await defaultRouteInterface(exec))
}
