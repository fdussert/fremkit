import si from 'systeminformation'
import { uptime } from 'node:os'
import type { Provider } from './types.js'
import { createMacTemperatureReader } from './mac-thermals.js'
import { cachedDisks, readMemory, type MemoryReading } from './mac-readings.js'
import { targetPlatform } from '../platform/index.js'
import { sharedHost, type HostDefaultRoute, type HostDrive, type HostMemory } from '../win/powershell-host.js'

/** One interface's throughput in the system snapshot, in bytes per second. */
export interface SystemNetwork { iface: string; rx: number; tx: number }

/**
 * The default route's throughput on Windows, from the host's `network.default` counters.
 *
 * Not `si.networkStats()`: on Windows it finds the default interface with `netstat -r` and the
 * adapters with `ipconfig /all` and `netsh`, each through a shell with `execSync`, on every poll.
 * The first reading, a change of adapter, a counter going backwards or a failed read give no entry.
 */
export function windowsNetworkRates(
  readRoute: () => Promise<HostDefaultRoute | null> = () => sharedHost().call<HostDefaultRoute | null>('network.default', undefined, 4000),
  now: () => number = Date.now,
): () => Promise<SystemNetwork[]> {
  let previous: { iface: string; rx: number; tx: number; at: number } | null = null
  return async () => {
    let route: HostDefaultRoute | null
    try { route = await readRoute() } catch { route = null }
    if (!route || typeof route.name !== 'string' || !Number.isFinite(route.rx) || !Number.isFinite(route.tx)) {
      previous = null
      return []
    }
    const at = now()
    const before = previous
    previous = { iface: route.name, rx: route.rx, tx: route.tx, at }
    if (!before || before.iface !== route.name || at <= before.at || route.rx < before.rx || route.tx < before.tx) return []
    const seconds = (at - before.at) / 1000
    return [{ iface: route.name, rx: Math.round((route.rx - before.rx) / seconds), tx: Math.round((route.tx - before.tx) / seconds) }]
  }
}

const round = (n: number) => Math.round(n * 10) / 10

interface DiskReading {
  /** The device, e.g. `/dev/disk3s5`. */
  fs?: string
  type?: string
  mount: string
  size: number
  used: number
  available?: number
  use: number
}

/**
 * The APFS container a volume lives in: `/dev/disk3s5` and `/dev/disk3s7` are two volumes of
 * `disk3`. Only APFS volumes share a container's space; any other file system stands alone.
 */
function apfsContainer(disk: DiskReading): string | null {
  if (disk.type !== undefined && disk.type.toUpperCase() !== 'APFS') return null
  return /^\/dev\/(disk\d+)s\d+(?:s\d+)?$/.exec(disk.fs ?? '')?.[1] ?? null
}

/** A Windows drive as `systeminformation` reports it: `C:`, with no trailing separator. */
const WINDOWS_DRIVE = /^[A-Za-z]:/

/**
 * Windows lists every lettered drive with a size, mapped network drives included, as the Mac lists
 * the network mounts under /Volumes; empty card readers and optical drives (size 0) are dropped.
 */

/**
 * One row per disk rather than per volume.
 *
 * APFS volumes share their container's space, and macOS reports every one of them with the
 * container's size and the same free space: two volumes on the Mac's disk used to show as two
 * rows each claiming the whole disk. The volumes of one container are folded into one row whose
 * `used` is everything the container holds (so system volumes and snapshots are counted too) and
 * whose `volumes` say how much each shown volume takes. The data volume stands for the Mac disk.
 */
export function normalizeDisks(disks: DiskReading[]) {
  const data = disks.find((disk) => disk.mount === '/System/Volumes/Data')
  const shown = disks.filter((disk) => (data ? disk === data : disk.mount === '/')
    || disk.mount.startsWith('/Volumes/') || (WINDOWS_DRIVE.test(disk.mount) && disk.size > 0))
  const groups = new Map<string, DiskReading[]>()
  for (const disk of shown) {
    const key = apfsContainer(disk) ?? `mount:${disk.mount}`
    groups.set(key, [...(groups.get(key) ?? []), disk])
  }
  return [...groups.values()].map((group) => {
    // The Mac's own disk names the row; otherwise its first volume does.
    const head = group.find((disk) => disk === data || disk.mount === '/') ?? group[0]
    const available = typeof head.available === 'number'
      && Number.isFinite(head.available) && head.available >= 0
      ? head.available : null
    const shared = group.length > 1 || head === data
    const used = shared && available !== null ? Math.max(0, head.size - available) : head.used
    const mount = head === data ? '/' : head.mount
    return {
      mount,
      size: head.size,
      used,
      available,
      use: round(shared && available !== null && head.size > 0 ? used / head.size * 100 : head.use),
      ...(group.length > 1 ? {
        volumes: group.map((disk) => ({ mount: disk === data ? '/' : disk.mount, used: disk.used })),
      } : {}),
    }
  })
}

/**
 * Windows disks, read without ever holding the poll: `si.fsSize()` can stall for many seconds on
 * a disconnected mapped drive, so the poll waits `timeoutMs` at most and then answers the last
 * good reading (none yet: no disks). One read is in flight at a time; a late answer is kept for
 * the next poll.
 */
export function timedDisks(
  read: () => Promise<DiskReading[]>,
  timeoutMs = 3_000,
): () => Promise<DiskReading[]> {
  let last: DiskReading[] = []
  let pending: Promise<void> | null = null
  return async () => {
    if (!pending) {
      const run = read().then((disks) => { last = disks }, () => { /* keep the last good reading */ })
      pending = run.finally(() => { pending = null })
    }
    let timer: NodeJS.Timeout | undefined
    await Promise.race([pending, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs) })])
    clearTimeout(timer)
    return last
  }
}

type MemoryFields = Pick<MemoryReading, 'total' | 'active' | 'available' | 'swapused' | 'swaptotal'>

/**
 * Windows memory and swap from the host's `memory` op (`GlobalMemoryStatusEx`), not `si.mem()`,
 * which starts a powershell.exe of its own on every poll for the page file. A failed read answers
 * the last good one; with none yet it fails the poll, as `si.mem()` would.
 */
export function windowsMemory(
  read: () => Promise<HostMemory> = () => sharedHost().call<HostMemory>('memory', undefined, 4000),
): () => Promise<MemoryFields> {
  let last: MemoryFields | null = null
  return async () => {
    try {
      const m = await read()
      if (![m.total, m.available, m.swapTotal, m.swapUsed].every((n) => Number.isFinite(n) && n >= 0)) throw new Error('invalid')
      last = { total: m.total, active: Math.max(0, m.total - m.available), available: m.available, swapused: m.swapUsed, swaptotal: m.swapTotal }
    } catch (error) {
      if (!last) throw error
    }
    return last
  }
}

/**
 * Windows drives from the host's `drives` op (`DriveInfo`: fixed drives and mapped network ones,
 * as the Mac lists the network mounts under /Volumes), not `si.fsSize()`, which starts a
 * powershell.exe per poll. The host leaves out a drive whose size query hangs; `timedDisks` still
 * guards the poll.
 */
export function windowsDrives(
  read: () => Promise<HostDrive[]> = () => sharedHost().call<HostDrive[]>('drives', undefined, 4000),
): () => Promise<DiskReading[]> {
  return async () => (await read())
    .filter((d) => typeof d.mount === 'string' && /^[A-Za-z]:$/.test(d.mount)
      && Number.isFinite(d.size) && Number.isFinite(d.available) && d.available >= 0 && d.available <= d.size)
    .map((d) => {
      const used = d.size - d.available
      return { mount: d.mount, type: d.network ? 'network' : 'local', size: d.size, used, available: d.available, use: d.size > 0 ? round(used / d.size * 100) : 0 }
    })
}

/** A denied uptime reading must not suppress CPU, memory or disk metrics. */
function uptimeSeconds(): number | null {
  try {
    const seconds = uptime()
    return Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : null
  } catch {
    return null
  }
}

export function createSystemProvider(options: {
  macmonTemperatureEnabled?: () => boolean
  readMacTemperature?: ReturnType<typeof createMacTemperatureReader>
  /** Disks and memory; on macOS read without `systeminformation`'s blocking calls (`mac-readings.ts`). */
  readDisks?: () => Promise<DiskReading[]>
  readMemory?: () => Promise<MemoryFields>
  /** The per-interface throughput; on Windows `windowsNetworkRates()`, elsewhere `si.networkStats()`. */
  readNetwork?: () => Promise<SystemNetwork[]>
  platform?: NodeJS.Platform
} = {}): Provider {
  const readMacTemperature = options.readMacTemperature ?? createMacTemperatureReader()
  // On Windows nothing here goes through `systeminformation` except `currentLoad()`, which only
  // reads `os.cpus()` and `os.loadavg()`: everything else it would read there through a
  // powershell.exe of its own, started per call, outside `windowsTool()`.
  const windows = targetPlatform(options.platform) === 'win32'
  const mac = !windows && process.platform === 'darwin'
  const disks = options.readDisks ?? (windows ? timedDisks(windowsDrives()) : mac ? cachedDisks() : timedDisks(() => si.fsSize()))
  const memory = options.readMemory ?? (windows ? windowsMemory() : mac ? () => readMemory() : () => si.mem())
  // The CPU temperature needs admin rights on Windows (MSAcpi_ThermalZoneTemperature): unsupported.
  const temperature = windows ? async () => ({ main: -1 }) : () => si.cpuTemperature()
  const network = options.readNetwork ?? (windows
    ? windowsNetworkRates()
    : async () => (await si.networkStats()).map((n) => ({
      iface: n.iface,
      rx: Math.max(0, Math.round(n.rx_sec ?? 0)),
      tx: Math.max(0, Math.round(n.tx_sec ?? 0)),
    })))
  return {
    channel: 'system',
    intervalMs: 2000,
    async poll() {
      const [load, mem, fs, net, temp] = await Promise.all([
        si.currentLoad(), memory(), disks(), network(), temperature(),
      ])
      const measured = options.macmonTemperatureEnabled?.() ? readMacTemperature() : null
      const macmonTemp = measured?.cpuCelsius ?? null
      const systemTemp = temp.main > 0 ? round(temp.main) : null
      return {
        uptimeSeconds: uptimeSeconds(),
        cpu: {
          load: round(load.currentLoad),
          cores: load.cpus.map((c) => round(c.load)),
          temp: macmonTemp ?? systemTemp,
          tempSource: macmonTemp !== null ? 'macmon' : systemTemp !== null ? 'system' : null,
          tempError: measured?.error ?? null,
        },
        memory: {
          total: mem.total,
          used: mem.active,
          free: mem.available,
          swapUsed: mem.swapused,
          swapTotal: mem.swaptotal,
        },
        disks: normalizeDisks(fs),
        network: net,
      }
    },
  }
}
