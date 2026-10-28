import { describe, it, expect, vi } from 'vitest'
import { createVolumeProvider } from '../src/providers/volume.js'
import { tr } from '../src/i18n.js'
import { HostError } from '../src/win/powershell-host.js'

describe('volume provider on Windows', () => {
  const setup = (answer: unknown = { level: 35, muted: false }) => {
    const host = { call: vi.fn(async () => answer) } as any
    const run = vi.fn(async () => '')
    return { host, run, provider: createVolumeProvider(run, { platform: 'win32', host }) }
  }

  it('reads the level and the mute state through the host', async () => {
    const { provider, host, run } = setup()
    expect(await provider.poll!()).toEqual({ level: 35, muted: false })
    expect(host.call).toHaveBeenCalledWith('volume.get', undefined, expect.any(Number))
    expect(run).not.toHaveBeenCalled()
  })

  it('clamps and rounds the level before it reaches the host', async () => {
    const { provider, host } = setup()
    expect(await provider.commands!.set!({ level: 140 })).toEqual({ level: 100 })
    expect(host.call).toHaveBeenLastCalledWith('volume.set', { level: 100 }, expect.any(Number))
    await provider.commands!.set!({ level: -5 })
    expect(host.call).toHaveBeenLastCalledWith('volume.set', { level: 0 }, expect.any(Number))
    await provider.commands!.set!({ level: 41.6 })
    expect(host.call).toHaveBeenLastCalledWith('volume.set', { level: 42 }, expect.any(Number))
  })

  it('refuses a bad payload before any host call', async () => {
    const { provider, host } = setup()
    await expect(provider.commands!.set!({ level: 'loud' })).rejects.toThrow(tr(undefined, 'volume.invalidLevel'))
    await expect(provider.commands!.set!({ level: NaN })).rejects.toThrow(tr(undefined, 'volume.invalidLevel'))
    await expect(provider.commands!.mute!({ muted: 'yes' })).rejects.toThrow(tr(undefined, 'volume.invalidMute'))
    expect(host.call).not.toHaveBeenCalled()
  })

  it('mutes through the host', async () => {
    const { provider, host } = setup()
    expect(await provider.commands!.mute!({ muted: true })).toEqual({ muted: true })
    expect(host.call).toHaveBeenCalledWith('volume.mute', { muted: true }, expect.any(Number))
  })

  it('publishes the last reading with no-device, or offline for any other failure', async () => {
    const { provider, host } = setup()
    await provider.poll!()
    host.call.mockRejectedValue(new HostError('no-device'))
    expect(await provider.poll!()).toEqual({ level: 35, muted: false, error: 'no-device' })
    for (const code of ['host-exited', 'timeout', 'host-start-timeout', 'busy']) {
      host.call.mockRejectedValue(new HostError(code))
      expect(await provider.poll!()).toEqual({ level: 35, muted: false, error: 'offline' })
    }
    host.call.mockRejectedValue(new Error('x'))
    expect(await provider.poll!()).toEqual({ level: 35, muted: false, error: 'offline' })
  })

  it('never calls the host on macOS', async () => {
    const host = { call: vi.fn() } as any
    const run = vi.fn(async () => 'output volume:50, input volume:0, alert volume:100, output muted:false')
    const provider = createVolumeProvider(run, { platform: 'darwin', host })
    expect(await provider.poll!()).toEqual({ level: 50, muted: false })
    await provider.commands!.set!({ level: 20 })
    await provider.commands!.mute!({ muted: true })
    expect(host.call).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledWith('set volume output volume 20')
  })
})
