import si from 'systeminformation'
import { cpus, totalmem } from 'node:os'
import type { Provider } from './types.js'
import { targetPlatform } from '../platform/index.js'
import { sharedHost, type HostProcess } from '../win/powershell-host.js'

const round = (n: number) => Math.round(n * 10) / 10

interface ProcessRow { pid: number; name: string; cpu: number; mem: number }

/**
 * Windows processes from the host's `processes` op, not `si.processes()`, which starts a
 * powershell.exe of its own on every poll. The host gives each process's total CPU time; the
 * percentage is the time it gained since the previous poll over the time all cores had, as
 * `systeminformation` computes it on Windows. A process seen for the first time shows 0 %.
 */
export function windowsProcesses(opts: {
  read?: () => Promise<HostProcess[]>
  now?: () => number
  cores?: () => number
  total?: () => number
} = {}): () => Promise<ProcessRow[]> {
  const read = opts.read ?? (() => sharedHost().call<HostProcess[]>('processes', undefined, 4000))
  const now = opts.now ?? Date.now
  const cores = opts.cores ?? (() => Math.max(1, cpus().length))
  const total = opts.total ?? totalmem
  let previous: { at: number; cpu: Map<number, number> } | null = null
  return async () => {
    const list = await read()
    const at = now()
    const elapsed = previous && at > previous.at ? (at - previous.at) * cores() : 0
    const memory = total()
    const seen = new Map<number, number>()
    const rows = list.filter((p) => Number.isSafeInteger(p.pid) && typeof p.name === 'string').map((p) => {
      const cpuMs = typeof p.cpuMs === 'number' && Number.isFinite(p.cpuMs) ? p.cpuMs : null
      if (cpuMs !== null) seen.set(p.pid, cpuMs)
      const before = previous?.cpu.get(p.pid)
      const gained = cpuMs !== null && before !== undefined && cpuMs >= before ? cpuMs - before : 0
      return {
        pid: p.pid,
        name: p.name,
        cpu: elapsed > 0 ? Math.min(100, gained / elapsed * 100) : 0,
        mem: memory > 0 && Number.isFinite(p.ws) ? p.ws / memory * 100 : 0,
      }
    })
    previous = { at, cpu: seen }
    return rows
  }
}

/** Top processes by CPU. Polled on its own slower channel: listing every process is expensive. */
export function createProcessesProvider(opts: { platform?: NodeJS.Platform; list?: () => Promise<ProcessRow[]> } = {}): Provider {
  const list = opts.list ?? (targetPlatform(opts.platform) === 'win32'
    ? windowsProcesses()
    : async () => (await si.processes()).list)
  return {
    channel: 'processes',
    intervalMs: 5000,
    async poll() {
      const procs = await list()
      return {
        processes: [...procs]
          .sort((a, b) => b.cpu - a.cpu)
          .slice(0, 10)
          .map((p) => ({ pid: p.pid, name: p.name, cpu: round(p.cpu), mem: round(p.mem) })),
      }
    },
  }
}

export const processesProvider: Provider = createProcessesProvider()
