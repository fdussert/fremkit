import { describe, expect, it, vi } from 'vitest'
import si from 'systeminformation'
import { createSystemProvider, windowsDrives, windowsMemory } from '../src/providers/system.js'
import { createProcessesProvider, windowsProcesses } from '../src/providers/processes.js'
import { createLocalModelsProvider } from '../src/providers/local-operations.js'
import type { HostProcess } from '../src/win/powershell-host.js'

// On Windows every one of these but currentLoad (os.cpus/os.loadavg only) starts a powershell.exe
// of its own: none may be called there.
vi.mock('systeminformation', () => ({ default: {
  currentLoad: vi.fn(async () => ({ currentLoad: 12, cpus: [{ load: 12 }] })),
  mem: vi.fn(async () => ({ total: 100, active: 50, available: 50, swapused: 0, swaptotal: 0 })),
  fsSize: vi.fn(async () => []),
  networkStats: vi.fn(async () => []),
  cpuTemperature: vi.fn(async () => ({ main: 40 })),
  processes: vi.fn(async () => ({ list: [] })),
} }))

const GB = 1024 ** 3

describe('the system snapshot on Windows', () => {
  it('reads memory, drives and temperature without systeminformation', async () => {
    // The host's ops are injected through the Windows readers; their defaults would start a host.
    const injected = createSystemProvider({
      platform: 'win32',
      readNetwork: async () => [],
      readMemory: windowsMemory(async () => ({ total: 16 * GB, available: 6 * GB, swapTotal: 4 * GB, swapUsed: GB })),
      readDisks: windowsDrives(async () => [{ mount: 'C:', network: false, size: 500 * GB, available: 125 * GB }]),
    })
    const snapshot = await injected.poll!() as { cpu: { temp: number | null }; memory: Record<string, number>; disks: { mount: string; use: number }[] }
    expect(snapshot.cpu.temp).toBeNull()
    expect(snapshot.memory).toEqual({ total: 16 * GB, used: 10 * GB, free: 6 * GB, swapUsed: GB, swapTotal: 4 * GB })
    expect(snapshot.disks).toMatchObject([{ mount: 'C:', use: 75 }])
    expect(si.mem).not.toHaveBeenCalled()
    expect(si.fsSize).not.toHaveBeenCalled()
    expect(si.cpuTemperature).not.toHaveBeenCalled()
  })

  it('answers the last good memory reading when the host fails, and fails with none yet', async () => {
    const answers: (Error | { total: number; available: number; swapTotal: number; swapUsed: number })[] = [
      new Error('busy'), { total: 8, available: 2, swapTotal: 0, swapUsed: 0 }, new Error('host-exited'),
    ]
    const memory = windowsMemory(async () => {
      const next = answers.shift()!
      if (next instanceof Error) throw next
      return next
    })
    await expect(memory()).rejects.toThrow('busy')
    expect(await memory()).toMatchObject({ total: 8, active: 6, available: 2 })
    expect(await memory()).toMatchObject({ total: 8, active: 6, available: 2 })
  })

  it('keeps well-formed lettered drives, network ones included', async () => {
    const drives = windowsDrives(async () => [
      { mount: 'C:', network: false, size: 100, available: 40 },
      { mount: 'Z:', network: true, size: 200, available: 200 },
      { mount: '\\\\server\\share', network: true, size: 10, available: 5 },
      { mount: 'D:', network: false, size: 10, available: 20 },
    ])
    expect(await drives()).toEqual([
      { mount: 'C:', type: 'local', size: 100, used: 60, available: 40, use: 60 },
      { mount: 'Z:', type: 'network', size: 200, used: 0, available: 200, use: 0 },
    ])
  })
})

describe('processes on Windows', () => {
  it('computes CPU from the time each process gained between polls, over all cores', async () => {
    let t = 0
    const answers: HostProcess[][] = [
      [{ pid: 4, name: 'System', cpuMs: null, ws: 1024 }, { pid: 100, name: 'busy', cpuMs: 1000, ws: 512 }, { pid: 200, name: 'idle', cpuMs: 50, ws: 256 }],
      [{ pid: 4, name: 'System', cpuMs: null, ws: 1024 }, { pid: 100, name: 'busy', cpuMs: 3000, ws: 512 }, { pid: 200, name: 'idle', cpuMs: 50, ws: 256 },
        { pid: 300, name: 'new', cpuMs: 9000, ws: 128 }],
    ]
    const list = windowsProcesses({ read: async () => answers.shift()!, now: () => t, cores: () => 4, total: () => 2048 })
    const first = await list()
    expect(first.every((p) => p.cpu === 0)).toBe(true)
    expect(first.find((p) => p.pid === 4)).toMatchObject({ mem: 50 })
    t = 1000
    const second = await list()
    // 2000 ms gained over 1000 ms × 4 cores = 50 %; a process first seen now counts nothing yet.
    expect(second.find((p) => p.pid === 100)!.cpu).toBe(50)
    expect(second.find((p) => p.pid === 200)!.cpu).toBe(0)
    expect(second.find((p) => p.pid === 300)!.cpu).toBe(0)
    expect(second.find((p) => p.pid === 4)!.cpu).toBe(0)
  })

  it('never asks systeminformation for the process list', async () => {
    const provider = createProcessesProvider({ platform: 'win32', list: windowsProcesses({ read: async () => [{ pid: 1, name: 'a', cpuMs: 1, ws: 1 }] }) })
    expect(await provider.poll!()).toMatchObject({ processes: [{ pid: 1, name: 'a' }] })
    const local = createLocalModelsProvider({ platform: 'win32', fetchFn: (async () => { throw new Error('offline') }) as typeof fetch })
    expect(await local.poll!()).toMatchObject({ mlx: { data: [], error: null } })
    expect(si.processes).not.toHaveBeenCalled()
  })
})
