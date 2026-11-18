// @vitest-environment jsdom
/**
 * What tells the server someone could see a companion pairing request
 * (`server/src/companion/viewers.ts`): the dashboard's socket says it is one and whether the page
 * is on screen, and the Devices pane's polls say they are the pane's while it is on screen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { socketUrl } from '../src/shared/socket'
import { createDevices } from '../src/admin/devices'
import type { DeviceStatus } from '../src/shared/api'

/** The page's visibility, as the browser (or WKWebView) reports it. */
let visibility: DocumentVisibilityState = 'visible'
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
const turn = (state: DocumentVisibilityState) => { visibility = state; document.dispatchEvent(new Event('visibilitychange')) }

afterEach(() => {
  visibility = 'visible'
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.useRealTimers()
})

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
  })

  it('does not say so while the page is hidden: a background tab, the admin window closed', async () => {
    vi.useFakeTimers()
    const getDevices = vi.fn(async () => status)
    const devices = createDevices({ getDevices } as never, 1000)
    const release = devices.watch()
    await vi.advanceTimersByTimeAsync(0)
    expect(getDevices).toHaveBeenLastCalledWith(true)
    visibility = 'hidden'
    await vi.advanceTimersByTimeAsync(1000)
    expect(getDevices).toHaveBeenLastCalledWith(false)
    visibility = 'visible'
    await vi.advanceTimersByTimeAsync(1000)
    expect(getDevices).toHaveBeenLastCalledWith(true)
    release()
  })
})

class FakeWebSocket {
  static OPEN = 1
  static latest: FakeWebSocket
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: unknown[] = []
  constructor(readonly url: string) { FakeWebSocket.latest = this }
  send(message: string) { this.sent.push(JSON.parse(message)) }
}

describe('the socket\'s visibility', () => {
  const open = async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const { useSocket } = await import('../src/shared/socket')
    useSocket()
    const wire = FakeWebSocket.latest
    wire.onopen?.()
    return wire
  }

  it('says nothing for a page on screen, then each change', async () => {
    const wire = await open()
    expect(wire.sent).toEqual([])
    turn('hidden')
    turn('visible')
    expect(wire.sent.slice(-2)).toEqual([{ type: 'visibility', visible: false }, { type: 'visibility', visible: true }])
  })

  it('says it is hidden as soon as it opens hidden', async () => {
    visibility = 'hidden'
    const wire = await open()
    expect(wire.sent[0]).toEqual({ type: 'visibility', visible: false })
  })
})
