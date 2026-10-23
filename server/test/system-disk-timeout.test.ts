import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSystemProvider, normalizeDisks, timedDisks } from '../src/providers/system.js'

vi.mock('systeminformation', () => ({ default: {
  currentLoad: vi.fn(async () => ({ currentLoad: 12, cpus: [{ load: 12 }] })),
  mem: vi.fn(async () => ({ total: 100, active: 50, available: 50, swapused: 0, swaptotal: 0 })),
  fsSize: vi.fn(async () => []),
  networkStats: vi.fn(async () => []),
  cpuTemperature: vi.fn(async () => ({ main: 0 })),
} }))

const disk = (mount: string, size = 100) => ({ fs: mount, type: 'NTFS', mount, size, used: 10, available: size - 10, use: 10 })

afterEach(() => vi.useRealTimers())

describe('timedDisks', () => {
  it('does not hold the system poll when the disks never answer', async () => {
    vi.useFakeTimers()
    const provider = createSystemProvider({
      readDisks: timedDisks(() => new Promise(() => {})),
      readMemory: async () => ({ total: 100, active: 50, available: 50, swapused: 0, swaptotal: 0 }),
      readNetwork: async () => [],
    })
    const polled = provider.poll!()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await polled).toMatchObject({ cpu: { load: 12 }, memory: { total: 100 }, disks: [] })
  })

  it('keeps the last good disks when a later read stalls, and takes a late answer next time', async () => {
    vi.useFakeTimers()
    let release!: (d: ReturnType<typeof disk>[]) => void
    const reads = [
      () => Promise.resolve([disk('C:')]),
      () => new Promise<ReturnType<typeof disk>[]>((resolve) => { release = resolve }),
    ]
    let n = 0
    const read = timedDisks(() => reads[Math.min(n++, 1)]())
    expect(await read()).toEqual([disk('C:')])
    const stalled = read()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await stalled).toEqual([disk('C:')])
    const again = read() // the same read is still in flight: no second one is started
    await vi.advanceTimersByTimeAsync(3_000)
    expect(n).toBe(2)
    release([disk('C:'), disk('D:')])
    await again
    expect(await read()).toEqual([disk('C:'), disk('D:')])
  })

  it('keeps the last good disks when a read fails', async () => {
    let fail = false
    const read = timedDisks(async () => { if (fail) throw new Error('x'); return [disk('C:')] })
    await read()
    fail = true
    expect(await read()).toEqual([disk('C:')])
  })
})

describe('Windows drive listing', () => {
  it('drops empty drives and keeps mapped network drives', () => {
    const net = { ...disk('Z:'), type: 'SMB' }
    expect(normalizeDisks([disk('C:'), disk('E:', 0), net]).map((d) => d.mount)).toEqual(['C:', 'Z:'])
  })
})
