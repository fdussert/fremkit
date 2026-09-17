import type { Provider } from './types.js'
import { execCommand, type Exec } from './exec.js'

/** How many samples the snapshot carries, so a freshly opened widget draws a graph at once. */
export const NETWORK_HISTORY = 60
export const NETWORK_INTERVAL_MS = 2000

export type NetworkKind = 'wifi' | 'ethernet' | 'other'

export interface NetworkSnapshot {
  iface: string | null
  kind: NetworkKind
  ip?: string
  ssid?: string
  downBps: number
  upBps: number
  /** Oldest first, `[down, up]` in bytes per second. */
  history: [number, number][]
}

/**
 * The interface the default route goes out of, from `route -n get default`.
 *
 * A Mac with no route at all — no cable, Wi-Fi off — prints no `interface:` line, and the widget
 * then has nothing to draw rather than a throughput for some arbitrary adapter.
 */
export function parseDefaultInterface(output: string): string | null {
  const match = /^\s*interface:\s*(\S+)\s*$/m.exec(output)
  return match ? match[1] : null
}

/**
 * Cumulative byte counters for one interface, from `netstat -ib`.
 *
 * Only the `<Link#n>` row is read: the same interface is listed again per address family, with the
 * very same counters, so summing every row would multiply the throughput by three or four. The
 * columns are counted from the right — `Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll` — because the
 * Address column is empty on some interfaces and shifts everything left when it is.
 */
export function parseNetstatBytes(output: string, iface: string): { rx: number; tx: number } | null {
  for (const line of output.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols[0] !== iface || !cols[2]?.startsWith('<Link#')) continue
    const tail = cols.slice(-7)
    if (tail.length < 7) continue
    const rx = Number(tail[2])
    const tx = Number(tail[5])
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue
    return { rx, tx }
  }
  return null
}

/**
 * Interface name → hardware port name, from `networksetup -listallhardwareports`.
 *
 * Used only to tell a Wi-Fi adapter from a wired one; the port names are the ones macOS shows in
 * Network settings, so the match is on the words rather than on a device number.
 */
export function parseHardwarePorts(output: string): Record<string, string> {
  const ports: Record<string, string> = {}
  let name: string | null = null
  for (const line of output.split('\n')) {
    const port = /^Hardware Port:\s*(.+?)\s*$/.exec(line)
    if (port) { name = port[1]; continue }
    const device = /^Device:\s*(\S+)\s*$/.exec(line)
    if (device && name) { ports[device[1]] = name; name = null }
  }
  return ports
}

export function classifyPort(portName: string | undefined): NetworkKind {
  const name = (portName ?? '').toLowerCase()
  if (name.includes('wi-fi') || name.includes('wifi') || name.includes('airport')) return 'wifi'
  if (name.includes('ethernet') || name.includes('lan')) return 'ethernet'
  return 'other'
}

/**
 * The SSID, from `ipconfig getsummary <iface>` or `networksetup -getairportnetwork <iface>`.
 *
 * macOS 14 and later redact it for a process without the Location permission: the line is either
 * missing, or present with `<redacted>` in it. Both come back as `undefined`, and the widget then
 * simply shows no network name — asking the user for Location to label a tile would be a poor
 * trade.
 */
export function parseSsid(output: string): string | undefined {
  const summary = /^\s*(?:SSID|ssid_str)\s*:\s*(.+?)\s*$/m.exec(output)
  const airport = /^Current Wi-Fi Network:\s*(.+?)\s*$/m.exec(output)
  const raw = summary?.[1] ?? airport?.[1]
  if (!raw || raw.includes('<redacted>') || raw === '<none>') return undefined
  return raw
}

/** The IPv4 address `ipconfig getifaddr` prints, or undefined when the interface has none. */
export function parseIfaddr(output: string): string | undefined {
  const value = output.trim()
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) ? value : undefined
}

interface Sample { rx: number; tx: number; at: number }

/**
 * Live throughput of the interface the default route uses.
 *
 * Rates are deltas between two polls of the kernel's cumulative counters, so the first poll after
 * a subscription has nothing to compare against and reports zero. The history lives here rather
 * than in the widget: a tile opened a second ago should still draw the last minute, and every
 * widget watching the channel sees the same graph.
 */
export function createNetworkProvider(exec: Exec = execCommand): Provider<NetworkSnapshot> {
  let previous: Sample | null = null
  let history: [number, number][] = []
  /** Hardware ports change only when an adapter is plugged in, so they are read once per start. */
  let ports: Record<string, string> | null = null

  const run = async (file: string, args: string[]): Promise<string> => {
    try { return await exec(file, args) } catch { return '' }
  }

  return {
    channel: 'network',
    intervalMs: NETWORK_INTERVAL_MS,

    start() { previous = null; history = []; ports = null },
    stop() { previous = null; history = []; ports = null },

    async poll(): Promise<NetworkSnapshot> {
      const iface = parseDefaultInterface(await run('route', ['-n', 'get', 'default']))
      if (!iface) {
        previous = null
        return { iface: null, kind: 'other', downBps: 0, upBps: 0, history }
      }

      const counters = parseNetstatBytes(await run('netstat', ['-ib']), iface)
      const at = Date.now()
      let downBps = 0
      let upBps = 0
      if (counters) {
        // A counter that went backwards means the interface was reset (or the 32-bit counter
        // wrapped): drop the delta rather than publish a spike of several gigabytes per second.
        if (previous && at > previous.at && counters.rx >= previous.rx && counters.tx >= previous.tx) {
          const seconds = (at - previous.at) / 1000
          downBps = Math.round((counters.rx - previous.rx) / seconds)
          upBps = Math.round((counters.tx - previous.tx) / seconds)
        }
        previous = { rx: counters.rx, tx: counters.tx, at }
        history = [...history, [downBps, upBps] as [number, number]].slice(-NETWORK_HISTORY)
      }

      if (!ports) ports = parseHardwarePorts(await run('networksetup', ['-listallhardwareports']))
      const kind = classifyPort(ports[iface])
      const ip = parseIfaddr(await run('ipconfig', ['getifaddr', iface]))
      let ssid: string | undefined
      if (kind === 'wifi') {
        ssid = parseSsid(await run('ipconfig', ['getsummary', iface]))
          ?? parseSsid(await run('networksetup', ['-getairportnetwork', iface]))
      }

      return { iface, kind, ...(ip ? { ip } : {}), ...(ssid ? { ssid } : {}), downBps, upBps, history }
    },
  }
}
