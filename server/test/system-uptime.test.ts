import { beforeEach, describe, expect, it, vi } from 'vitest'
import { uptime } from 'node:os'
import { createSystemProvider } from '../src/providers/system.js'

vi.mock('node:os', () => ({ uptime: vi.fn() }))
vi.mock('systeminformation', () => ({ default: {
  currentLoad: vi.fn(async () => ({ currentLoad: 12, cpus: [{ load: 12 }] })),
  mem: vi.fn(async () => ({ total: 100, active: 50, available: 50, swapused: 0, swaptotal: 0 })),
  fsSize: vi.fn(async () => []),
  networkStats: vi.fn(async () => []),
  cpuTemperature: vi.fn(async () => ({ main: 0 })),
} }))

describe('OS uptime in the system snapshot', () => {
  // Disks and memory come from `mac-readings.ts` on a Mac; handed in here so the test reads nothing.
  const systemProvider = createSystemProvider({
    readDisks: async () => [],
    readMemory: async () => ({ total: 100, active: 50, available: 50, swapused: 0, swaptotal: 0 }),
  })
  beforeEach(() => vi.mocked(uptime).mockReset())

  it.each([0, 90061.9])('publishes system uptime %s seconds rather than process uptime', async (seconds) => {
    vi.mocked(uptime).mockReturnValue(seconds)
    expect(await systemProvider.poll!()).toMatchObject({
      uptimeSeconds: Math.floor(seconds), cpu: { load: 12 }, memory: { total: 100 },
    })
  })

  it.each([-1, NaN, Infinity])('leaves invalid reading %s unknown', async (seconds) => {
    vi.mocked(uptime).mockReturnValue(seconds)
    expect(await systemProvider.poll!()).toMatchObject({ uptimeSeconds: null, cpu: { load: 12 } })
  })

  it('keeps other metrics working when uptime access fails', async () => {
    vi.mocked(uptime).mockImplementationOnce(() => { throw new Error('Permission denied') })
    expect(await systemProvider.poll!()).toMatchObject({
      uptimeSeconds: null, cpu: { load: 12 }, disks: [], network: [],
    })
  })
})
