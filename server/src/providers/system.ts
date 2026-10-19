import si from 'systeminformation'
import { uptime } from 'node:os'
import type { Provider } from './types.js'
import { createMacTemperatureReader } from './mac-thermals.js'
import { cachedDisks, readMemory, type MemoryReading } from './mac-readings.js'

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
    || disk.mount.startsWith('/Volumes/'))
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
  readMemory?: () => Promise<Pick<MemoryReading, 'total' | 'active' | 'available' | 'swapused' | 'swaptotal'>>
} = {}): Provider {
  const readMacTemperature = options.readMacTemperature ?? createMacTemperatureReader()
  const mac = process.platform === 'darwin'
  const disks = options.readDisks ?? (mac ? cachedDisks() : () => si.fsSize())
  const memory = options.readMemory ?? (mac ? () => readMemory() : () => si.mem())
  return {
    channel: 'system',
    intervalMs: 2000,
    async poll() {
      const [load, mem, fs, net, temp] = await Promise.all([
        si.currentLoad(), memory(), disks(), si.networkStats(), si.cpuTemperature(),
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
        network: net.map((n) => ({
          iface: n.iface,
          rx: Math.max(0, Math.round(n.rx_sec ?? 0)),
          tx: Math.max(0, Math.round(n.tx_sec ?? 0)),
        })),
      }
    },
  }
}
