import si from 'systeminformation'
import type { Provider } from './types.js'

const round = (n: number) => Math.round(n * 10) / 10

/** Top processes by CPU. Polled on its own slower channel: si.processes() is expensive. */
export const processesProvider: Provider = {
  channel: 'processes',
  intervalMs: 5000,
  async poll() {
    const procs = await si.processes()
    return {
      processes: [...procs.list]
        .sort((a, b) => b.cpu - a.cpu)
        .slice(0, 10)
        .map((p) => ({ pid: p.pid, name: p.name, cpu: round(p.cpu), mem: round(p.mem) })),
    }
  },
}
