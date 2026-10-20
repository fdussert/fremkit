/**
 * What tells the server someone could see a companion pairing request
 * (`server/src/companion/viewers.ts`): the dashboard's socket says it is one, and the Devices
 * pane's polls say they are the pane's.
 */
import { describe, expect, it, vi } from 'vitest'
import { socketUrl } from '../src/shared/socket'
import { createDevices } from '../src/admin/devices'
import type { DeviceStatus } from '../src/shared/api'

describe('socketUrl', () => {
  const at = (pathname: string, protocol = 'http:', host = '127.0.0.1:4242') => socketUrl({ protocol, host, pathname })

  it('marks a dashboard page, and never the admin', () => {
    expect(at('/')).toBe('ws://127.0.0.1:4242/ws?view=dashboard')
    expect(at('/index.html')).toBe('ws://127.0.0.1:4242/ws?view=dashboard')
    expect(at('/admin')).toBe('ws://127.0.0.1:4242/ws')
    expect(at('/admin/')).toBe('ws://127.0.0.1:4242/ws')
    expect(at('/admin.html')).toBe('ws://127.0.0.1:4242/ws')
  })

  it('keeps wss for a paired device, whose socket the server never counts', () => {
    expect(at('/', 'https:', 'mac.example.local:4243')).toBe('wss://mac.example.local:4243/ws?view=dashboard')
  })
})

describe('the devices store', () => {
  const status = { enabled: false, listening: false, error: null, guessing: false, host: 'mac.example.local', addresses: [],
    port: 4243, keyHash: null, fingerprint: null, devices: [], companionRequest: null } as unknown as DeviceStatus

  it('says its polls are the pane\'s while watched, and a one-off refresh is not', async () => {
    vi.useFakeTimers()
    const getDevices = vi.fn(async () => status)
    const devices = createDevices({ getDevices } as never, 1000)
    await devices.refresh()
    expect(getDevices).toHaveBeenLastCalledWith(false)
    const release = devices.watch()
    await vi.advanceTimersByTimeAsync(0)
    expect(getDevices).toHaveBeenLastCalledWith(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(getDevices).toHaveBeenLastCalledWith(true)
    release()
    await devices.refresh()
    expect(getDevices).toHaveBeenLastCalledWith(false)
    vi.useRealTimers()
  })
})
