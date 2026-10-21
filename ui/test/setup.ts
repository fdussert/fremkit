/**
 * No test reaches a real WebSocket.
 *
 * `useSocket()` is a page-wide singleton that reconnects forever, and plenty of component tests
 * open it without asking: `useAdminStore()` subscribes to `config`, `useHealth()` to the health
 * channel. Under jsdom that dialled `ws://localhost:3000/ws`, was refused, and armed a retry
 * timer the test never knew about — one CI run saw it fire after the environment was torn down,
 * with `location` gone (`ReferenceError: location is not defined` in `socket.ts`), and fail a
 * suite whose tests had all passed. Each close also sent the session check through whatever
 * `fetch` the test had stubbed.
 *
 * This socket stays connecting: it never opens, never closes, so the reconnect loop never
 * starts. A test that wants to drive the wire stubs its own with `vi.stubGlobal('WebSocket', …)`
 * (`socket-cache-invalidation.test.ts`); `vi.unstubAllGlobals()` brings this one back.
 */
class SilentWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  send(): void {}
  close(): void {}
}

globalThis.WebSocket = SilentWebSocket as unknown as typeof WebSocket
