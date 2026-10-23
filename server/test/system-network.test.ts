import { describe, expect, it, vi } from 'vitest'
import si from 'systeminformation'
import { createSystemProvider, windowsNetworkRates } from '../src/providers/system.js'

vi.mock('systeminformation', () => ({ default: {
  currentLoad: vi.fn(async () => ({ currentLoad: 12, cpus: [{ load: 12 }] })),
  mem: vi.fn(async () => ({ total: 100, active: 50, available: 50, swapused: 0, swaptotal: 0 })),
  fsSize: vi.fn(async () => []),
  networkStats: vi.fn(async () => [{ iface: 'en0', rx_sec: 10.4, tx_sec: -1 }]),
  cpuTemperature: vi.fn(async () => ({ main: 0 })),
} }))

const route = (name: string, rx: number, tx: number) => ({ name, kind: 'ethernet' as const, ip4: '192.0.2.5', rx, tx })

describe('the system snapshot\'s network on Windows', () => {
  it('turns the default route\'s counters into a rate from the second reading', async () => {
    let t = 0
    const answers = [route('Ethernet', 1000, 500), route('Ethernet', 5000, 1500)]
    const rates = windowsNetworkRates(async () => answers.shift() ?? null, () => t)
    expect(await rates()).toEqual([])
    t = 2000
    expect(await rates()).toEqual([{ iface: 'Ethernet', rx: 2000, tx: 500 }])
  })

  it('gives no entry on a change of adapter, a counter going back, no route or a failed read', async () => {
    let t = 0
    const answers: (ReturnType<typeof route> | null | Error)[] = [
      route('Ethernet', 1000, 500), route('Wi-Fi', 9000, 9000), route('Wi-Fi', 100, 100), null, new Error('host-exited'),
    ]
    const rates = windowsNetworkRates(async () => {
      const next = answers.shift()
      if (next instanceof Error) throw next
      return next ?? null
    }, () => (t += 1000))
    for (let i = 0; i < 5; i++) expect(await rates()).toEqual([])
  })

  it('never asks systeminformation for the network stats on Windows', async () => {
    const provider = createSystemProvider({
      platform: 'win32',
      readDisks: async () => [],
      readMemory: async () => ({ total: 100, active: 50, available: 50, swapused: 0, swaptotal: 0 }),
      readNetwork: async () => [{ iface: 'Ethernet', rx: 1, tx: 2 }],
    })
    expect(await provider.poll!()).toMatchObject({ network: [{ iface: 'Ethernet', rx: 1, tx: 2 }] })
    expect(si.networkStats).not.toHaveBeenCalled()
  })

  it('keeps systeminformation\'s rates on the Mac, rounded and never negative', async () => {
    const provider = createSystemProvider({
      platform: 'darwin',
      readDisks: async () => [],
      readMemory: async () => ({ total: 100, active: 50, available: 50, swapused: 0, swaptotal: 0 }),
    })
    expect(await provider.poll!()).toMatchObject({ network: [{ iface: 'en0', rx: 10, tx: 0 }] })
  })
})
