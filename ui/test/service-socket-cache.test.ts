// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
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
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
it('drops a retired cached snapshot without resubscribing and keeps the valid relay for fresh data', async () => {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  const { useSocket } = await import('../src/shared/socket')
  const socket = useSocket(); const wire = FakeWebSocket.latest; wire.onopen?.()
  const first: unknown[] = []; const second: unknown[] = []
  const off = socket.subscribe('gmail:account-a', (value) => first.push(value))
  wire.receive({ type: 'data', channel: 'gmail:account-a', data: 'retired snapshot' })
  wire.receive({ type: 'invalidate', channel: 'gmail:account-a' })
  const offSecond = socket.subscribe('gmail:account-a', (value) => second.push(value))
  expect(second).toEqual([])
  expect(wire.sent).toEqual([{ type: 'subscribe', channel: 'gmail:account-a' }])
  wire.receive({ type: 'data', channel: 'gmail:account-a', data: 'fresh snapshot' })
  expect(second).toEqual(['fresh snapshot'])
  expect(first).toEqual(['retired snapshot', 'fresh snapshot'])
  off(); offSecond()
})

it('does not replay a cache after disconnecting and missing account invalidations', async () => {
  vi.useFakeTimers()
  try {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const { useSocket } = await import('../src/shared/socket')
    const socket = useSocket(); const wire = FakeWebSocket.latest; wire.onopen?.()
    const off = socket.subscribe('gmail:account-a', () => {})
    wire.receive({ type: 'data', channel: 'gmail:account-a', data: 'before disconnect' })
    wire.readyState = 3; wire.onclose?.()
    const received: unknown[] = []
    const offNext = socket.subscribe('gmail:account-a', (data) => received.push(data))
    expect(received).toEqual([])
    off(); offNext()
  } finally { vi.clearAllTimers(); vi.useRealTimers() }
})
