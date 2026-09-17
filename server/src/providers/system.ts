import si from 'systeminformation'
import type { Provider } from './types.js'

const round = (n: number) => Math.round(n * 10) / 10

export const systemProvider: Provider = {
  channel: 'system',
  intervalMs: 2000,
  async poll() {
    const [load, mem, fs, net, temp] = await Promise.all([
      si.currentLoad(), si.mem(), si.fsSize(), si.networkStats(), si.cpuTemperature(),
    ])
    return {
      cpu: { load: round(load.currentLoad), cores: load.cpus.map((c) => round(c.load)), temp: temp.main > 0 ? round(temp.main) : null },
      memory: { total: mem.total, used: mem.active, free: mem.available },
      disks: fs
        .filter((d) => d.mount === '/' || d.mount.startsWith('/Volumes/'))
        .map((d) => ({ mount: d.mount, size: d.size, used: d.used, use: round(d.use) })),
      network: net.map((n) => ({ iface: n.iface, rx: Math.max(0, Math.round(n.rx_sec ?? 0)), tx: Math.max(0, Math.round(n.tx_sec ?? 0)) })),
    }
  },
}
