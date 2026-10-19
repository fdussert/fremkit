// @vitest-environment jsdom
/**
 * A dropped socket on a paired device that the server now refuses: a 401 means the device was
 * revoked, not that the Mac's access secret changed, so the page shows it instead of reloading.
 */
import { afterEach, expect, it, vi } from 'vitest'

class FakeWebSocket {
  static OPEN = 1
  static latest: FakeWebSocket
  readyState = 3
  onopen: (() => void) | null = null
  onmessage: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor() { FakeWebSocket.latest = this }
  send() {}
  close() {}
}

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function dropWith(protocol: string) {
  const reload = vi.fn()
  vi.stubGlobal('location', { protocol, host: 'example.local:4243', reload })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.useFakeTimers()
  const { useSocket } = await import('../src/shared/socket')
  const { deviceUnauthorized } = await import('../src/shared/remote')
  useSocket()
  FakeWebSocket.latest.onclose?.()
  await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled())
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  return { reload, deviceUnauthorized }
}

it('raises the unauthorized flag on a paired device instead of reloading', async () => {
  const { reload, deviceUnauthorized } = await dropWith('https:')
  expect(deviceUnauthorized.value).toBe(true)
  expect(reload).not.toHaveBeenCalled()
})

it('still reloads once on the Mac', async () => {
  const { reload, deviceUnauthorized } = await dropWith('http:')
  expect(reload).toHaveBeenCalledTimes(1)
  expect(deviceUnauthorized.value).toBe(false)
})
