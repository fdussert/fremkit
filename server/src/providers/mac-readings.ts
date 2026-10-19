import { execFile } from 'node:child_process'
import { freemem, totalmem } from 'node:os'
import { promisify } from 'node:util'

/**
 * Disk and memory readings for the `system` channel, taken without blocking the event loop.
 *
 * `systeminformation` reads both on macOS with `execSync`: `fsSize()` runs `diskutil list` and
 * `mount`, `mem()` runs `sysctl -n vm.pagesize`, on every poll. Measured on an M-series Mac, that
 * froze the whole server for about 43 ms and 25 ms every two seconds — and a server stuck in a
 * synchronous child process does not answer SIGTERM, which is how an old one outlived a restart.
 * The same programs are run here with `execFile` (by absolute path, see AGENTS.md), parsed the way
 * `systeminformation` parses them so the numbers on the dashboard do not move.
 */

export type Exec = (file: string, args: string[]) => Promise<{ stdout: string }>
const execFileAsync = promisify(execFile)
const defaultExec: Exec = (file, args) => execFileAsync(file, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 })

export interface DiskReading {
  /** The device, e.g. `/dev/disk3s5`. */
  fs: string
  type?: string
  mount: string
  size: number
  used: number
  available: number
  use: number
}

/** `mount`'s "<fs> on <mountpoint> (<type>, <options>)" lines, as a device → type map. */
export function parseMountTypes(stdout: string): Map<string, string> {
  const types = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const fs = line.split(' ')[0]
    const type = /\(([^),]+)[^)]*\)$/.exec(line)?.[1]
    if (fs && type) types.set(fs, type.trim().toLowerCase())
  }
  return types
}

/**
 * `df -kP`, one reading per mounted file system that names a device or a share — `devfs`,
 * `map auto_home` and the like are left out, as `systeminformation` leaves them out. The device
 * and the mount point may hold spaces, so the line is read from its numeric columns.
 */
export function parseDf(stdout: string, types: Map<string, string> = new Map()): DiskReading[] {
  const line = /^(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(?:\d+%|-)\s+(.+)$/
  const out: DiskReading[] = []
  for (const raw of stdout.split('\n')) {
    const m = line.exec(raw.trim())
    if (!m) continue
    const [, fs, blocks, usedBlocks, availableBlocks, mount] = m
    if (!(fs.startsWith('/') || mount === '/' || fs.indexOf('/') > 0 || fs.indexOf(':') === 1)) continue
    const size = Number(blocks) * 1024
    const used = Number(usedBlocks) * 1024
    const available = Number(availableBlocks) * 1024
    const use = used + available > 0 ? Number((100 * used / (used + available)).toFixed(2)) : 0
    if (out.some((d) => d.fs === fs && d.mount === mount)) continue
    const type = types.get(fs)
    out.push({ fs, ...(type ? { type } : {}), mount, size, used, available, use })
  }
  return out
}

export async function readDisks(exec: Exec = defaultExec): Promise<DiskReading[]> {
  const [df, mount] = await Promise.all([
    exec('/bin/df', ['-kP']),
    exec('/sbin/mount', []).catch(() => ({ stdout: '' })),
  ])
  return parseDf(df.stdout, parseMountTypes(mount.stdout))
}

/**
 * The disks, read at most once per `ttlMs`: free space does not move in two seconds, and a
 * volume mounted meanwhile shows within the minute. Concurrent callers share one reading; a
 * failed one is not kept, so the next poll tries again.
 */
export function cachedDisks(read: () => Promise<DiskReading[]> = readDisks, ttlMs = 60_000, now: () => number = Date.now): () => Promise<DiskReading[]> {
  let last: { at: number; value: Promise<DiskReading[]> } | null = null
  return () => {
    if (last && now() - last.at < ttlMs) return last.value
    const value = read()
    const entry = { at: now(), value }
    last = entry
    value.catch(() => { if (last === entry) last = null })
    return value
  }
}

export interface MemoryReading {
  total: number
  free: number
  used: number
  /** What `systeminformation` calls active: anonymous − purgeable + wired + compressed. */
  active: number
  available: number
  swaptotal: number
  swapused: number
}

/** `vm_stat`'s page counts, in bytes, with the page size it states in its first line. */
export function parseVmStat(stdout: string): { wired: number; compressed: number; purgeable: number; anonymous: number } {
  const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1]) || 4096
  const pages = (label: string): number => {
    const m = new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(stdout)
    return (m ? Number(m[1]) : 0) * pageSize
  }
  return {
    wired: pages('Pages wired down'),
    compressed: pages('Pages occupied by compressor'),
    purgeable: pages('Pages purgeable'),
    anonymous: pages('Anonymous pages'),
  }
}

/** `sysctl -n vm.swapusage`: "total = 2048.00M  used = 1023.25M  free = 1024.75M  (encrypted)". */
export function parseSwap(stdout: string): { swaptotal: number; swapused: number } {
  const mb = (label: string): number => {
    const m = new RegExp(`${label}\\s*=\\s*([\\d.,]+)M`).exec(stdout)
    return m ? Number(m[1].replace(',', '.')) * 1024 * 1024 : 0
  }
  return { swaptotal: mb('total'), swapused: mb('used') }
}

export async function readMemory(exec: Exec = defaultExec, total = totalmem(), free = freemem()): Promise<MemoryReading> {
  const [vm, swap] = await Promise.all([
    exec('/usr/bin/vm_stat', []).catch(() => null),
    exec('/usr/sbin/sysctl', ['-n', 'vm.swapusage']).catch(() => null),
  ])
  const used = total - free
  const pages = vm ? parseVmStat(vm.stdout) : null
  const active = pages ? pages.anonymous - pages.purgeable + pages.wired + pages.compressed : used
  return {
    total, free, used, active,
    available: free + (used - active),
    ...(swap ? parseSwap(swap.stdout) : { swaptotal: 0, swapused: 0 }),
  }
}
