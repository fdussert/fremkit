// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vite-plus/test'

class FakeWebSocket {
  static OPEN = 1
  static latest: FakeWebSocket
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: unknown[] = []

  constructor() { FakeWebSocket.latest = this }
  send(message: string) { this.sent.push(JSON.parse(message)) }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }) }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('does not replay a retired snapshot to a later subscriber', async () => {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  const { useSocket } = await import('../src/shared/socket')
  const socket = useSocket()
  const wire = FakeWebSocket.latest
  wire.onopen?.()
  const first: unknown[] = []
  const second: unknown[] = []
  const offFirst = socket.subscribe('service:account-a', (value) => first.push(value))

  wire.receive({ type: 'data', channel: 'service:account-a', data: 'old snapshot' })
  wire.receive({ type: 'invalidate', channel: 'service:account-a' })
  const offSecond = socket.subscribe('service:account-a', (value) => second.push(value))
  expect(second).toEqual([])
  expect(wire.sent).toEqual([{ type: 'subscribe', channel: 'service:account-a' }])

  wire.receive({ type: 'data', channel: 'service:account-a', data: 'fresh snapshot' })
  expect(first).toEqual(['old snapshot', 'fresh snapshot'])
  expect(second).toEqual(['fresh snapshot'])
  offFirst()
  offSecond()
})

it('does not replay a snapshot after a disconnect that may have missed invalidation', async () => {
  vi.useFakeTimers()
  try {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const { useSocket } = await import('../src/shared/socket')
    const socket = useSocket()
    const wire = FakeWebSocket.latest
    wire.onopen?.()
    const offFirst = socket.subscribe('service:account-a', () => {})
    wire.receive({ type: 'data', channel: 'service:account-a', data: 'before disconnect' })
    wire.readyState = 3
    wire.onclose?.()

    const second: unknown[] = []
    const offSecond = socket.subscribe('service:account-a', (value) => second.push(value))
    expect(second).toEqual([])
    offFirst()
    offSecond()
  } finally {
    vi.clearAllTimers()
    vi.useRealTimers()
  }
})
