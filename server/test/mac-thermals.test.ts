import { describe, it, expect, vi } from 'vite-plus/test'
import { createMacTemperatureReader, parseMacTemperature } from '../src/providers/mac-thermals.js'

const now = 1800000000000
const reading = (value: unknown = 67.483, time = now) => JSON.stringify({ timestamp: new Date(time).toISOString(), temp: { cpu_temp_avg: value, gpu_temp_avg: 70.688 } })
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('measured Apple Silicon CPU temperature', () => {
  it('accepts a recent bounded CPU sample without publishing GPU data', () => {
    expect(parseMacTemperature(reading(), now)).toEqual({ cpuCelsius: 67.5, updatedAt: now, error: null })
  })
  it.each([0, -1, NaN, Infinity, 150, '67.5', null])('rejects invalid CPU sample %s', (value) => {
    expect(parseMacTemperature(reading(value), now)).toMatchObject({ cpuCelsius: null, error: 'invalid' })
  })
  it.each(['not json', '{}', reading(67, now - 30001), reading(67, now + 5001)])('rejects malformed or stale samples', (output) => {
    expect(parseMacTemperature(output, now)).toMatchObject({ cpuCelsius: null, error: 'invalid' })
  })
  it('returns cached data immediately while refreshing only once per ten seconds', async () => {
    let clock = now
    const run = vi.fn(async () => reading(67, clock))
    const read = createMacTemperatureReader({ platform: 'darwin', arch: 'arm64', now: () => clock, run })
    expect(read()).toMatchObject({ cpuCelsius: null, error: null })
    expect(read().cpuCelsius).toBeNull()
    await flush()
    expect(read().cpuCelsius).toBe(67)
    expect(run).toHaveBeenCalledTimes(1)
    clock += 10000
    expect(read().cpuCelsius).toBe(67)
    await flush()
    expect(run).toHaveBeenCalledTimes(2)
  })
  it('keeps a previous sample until it expires after a failed refresh', async () => {
    let clock = now
    const run = vi.fn().mockResolvedValueOnce(reading()).mockRejectedValueOnce(new Error('denied'))
    const read = createMacTemperatureReader({ platform: 'darwin', arch: 'arm64', now: () => clock, run })
    read(); await flush()
    expect(read().cpuCelsius).toBe(67.5)
    clock += 10000
    read(); await flush()
    expect(read()).toMatchObject({ cpuCelsius: 67.5, error: 'offline' })
    clock += 20001
    expect(read()).toMatchObject({ cpuCelsius: null, error: 'offline' })
  })
  it('keeps a recent sample when the next response is malformed', async () => {
    let clock = now
    const run = vi.fn().mockResolvedValueOnce(reading()).mockResolvedValueOnce('not json')
    const read = createMacTemperatureReader({ platform: 'darwin', arch: 'arm64', now: () => clock, run })
    read(); await flush()
    clock += 10000
    read(); await flush()
    expect(read()).toMatchObject({ cpuCelsius: 67.5, error: 'invalid' })
  })
  it('does not expose an expired cached sample after a long pause', async () => {
    let clock = now
    const run = vi.fn(async () => reading(67, clock))
    const read = createMacTemperatureReader({ platform: 'darwin', arch: 'arm64', now: () => clock, run })
    read(); await flush()
    expect(read().cpuCelsius).toBe(67)
    clock += 3600000
    expect(read().cpuCelsius).toBeNull()
    await flush()
    expect(read().cpuCelsius).toBe(67)
  })
  it('uses only fixed install paths and never runs on unsupported systems', async () => {
    const run = vi.fn(async (_file: string, _args: string[]) => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) })
    const read = createMacTemperatureReader({ platform: 'darwin', arch: 'arm64', run })
    read(); await flush()
    expect(read().error).toBe('unconfigured')
    expect(run.mock.calls.map((args) => args[0])).toEqual(['/opt/homebrew/bin/macmon', '/usr/local/bin/macmon'])
    const other = createMacTemperatureReader({ platform: 'linux', arch: 'arm64', run })
    expect(other().error).toBe('unsupported')
    expect(run).toHaveBeenCalledTimes(2)
  })
})
