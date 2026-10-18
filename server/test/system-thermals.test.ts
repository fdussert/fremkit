import { expect, it, vi } from 'vite-plus/test'
import si from 'systeminformation'

vi.mock('systeminformation', () => ({
  default: {
    currentLoad: async () => ({ currentLoad: 12, cpus: [{ load: 12 }] }),
    mem: async () => ({ total: 100, active: 40, available: 60 }),
    fsSize: async () => [],
    networkStats: async () => [],
    cpuTemperature: vi.fn(async () => ({ main: 0 })),
  },
}))

import { createSystemProvider } from '../src/providers/system.js'

it('never runs the optional sensor before consent and keeps polling without waiting for it', async () => {
  let enabled = false
  const readMacTemperature = vi.fn(() => ({ cpuCelsius: 55, updatedAt: 1800000000000, error: null as null }))
  const provider = createSystemProvider({ macmonTemperatureEnabled: () => enabled, readMacTemperature })
  expect((await provider.poll!() as { cpu: { temp: number | null; tempSource: string | null; tempError: string | null } }).cpu)
    .toMatchObject({ temp: null, tempSource: null, tempError: null })
  expect(readMacTemperature).not.toHaveBeenCalled()
  enabled = true
  expect((await provider.poll!() as { cpu: { temp: number | null; tempSource: string | null; tempError: string | null } }).cpu)
    .toMatchObject({ temp: 55, tempSource: 'macmon', tempError: null })
  expect(readMacTemperature).toHaveBeenCalledTimes(1)
})

it('reports a missing macmon tool while preserving the system fallback', async () => {
  const readMacTemperature = vi.fn(() => ({ cpuCelsius: null, updatedAt: null, error: 'unconfigured' as const }))
  vi.mocked(si.cpuTemperature).mockResolvedValueOnce({ main: 42 } as Awaited<ReturnType<typeof si.cpuTemperature>>)
  const provider = createSystemProvider({ macmonTemperatureEnabled: () => true, readMacTemperature })
  expect((await provider.poll!() as { cpu: { temp: number | null; tempSource: string | null; tempError: string | null } }).cpu)
    .toMatchObject({ temp: 42, tempSource: 'system', tempError: 'unconfigured' })
})
