import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Hub, MAX_CHANNELS_PER_SOCKET, DEVICE_CLOSE_CODE, DEVICE_TERMINATE_MS } from '../src/ws/hub.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import { deviceHostView } from '../src/devices/service.js'

class FakeSocket extends EventEmitter {
  sent: any[] = []
  send(data: string) { this.sent.push(JSON.parse(data)) }
  receive(msg: unknown) { this.emit('message', Buffer.from(JSON.stringify(msg))) }
  closedWith: number | undefined
  close(code?: number) { this.closedWith = code; this.emit('close') }
}

function setup() {
  let hub: Hub
  const registry = new ProviderRegistry((c, d) => hub.broadcast(c, d))
  registry.register({ channel: 'volume', intervalMs: 1000, poll: async () => ({ level: 10 }), commands: { set: async (p) => ({ ok: true, p }) } })
  hub = new Hub(registry)
  return { hub, registry }
}

describe('Hub', () => {
  it('delivers broadcasts only to subscribed sockets', () => {
    const { hub } = setup()
    const a = new FakeSocket(), b = new FakeSocket()
    hub.attach(a); hub.attach(b)
    a.receive({ type: 'subscribe', channel: 'config' })
    hub.broadcast('config', { version: 1 })
    expect(a.sent).toEqual([{ type: 'data', channel: 'config', data: { version: 1 } }])
    expect(b.sent).toEqual([])
  })
  it('replays the last value on subscribe', () => {
    const { hub } = setup()
    hub.broadcast('config', { version: 1 })
    const a = new FakeSocket(); hub.attach(a)
    a.receive({ type: 'subscribe', channel: 'config' })
    expect(a.sent).toEqual([{ type: 'data', channel: 'config', data: { version: 1 } }])
  })
  it('notifies subscribers without keeping the value for the next one', () => {
    const { hub } = setup()
    const a = new FakeSocket(); hub.attach(a)
    a.receive({ type: 'subscribe', channel: 'widget-dev' })
    hub.notify('widget-dev', { ids: ['clock'], manifest: false })
    expect(a.sent).toEqual([{ type: 'data', channel: 'widget-dev', data: { ids: ['clock'], manifest: false } }])
    const b = new FakeSocket(); hub.attach(b)
    b.receive({ type: 'subscribe', channel: 'widget-dev' })
    expect(b.sent).toEqual([])
  })
  it('forwards subscriber counts to the registry and releases on close', () => {
    const { hub, registry } = setup()
    const add = vi.spyOn(registry, 'addSubscriber'), rem = vi.spyOn(registry, 'removeSubscriber')
    const a = new FakeSocket(); hub.attach(a)
    a.receive({ type: 'subscribe', channel: 'volume' })
    a.receive({ type: 'subscribe', channel: 'volume' })
    expect(add).toHaveBeenCalledTimes(1)
    a.emit('close')
    expect(rem).toHaveBeenCalledWith('volume')
    registry.stop()
  })
  it('unsubscribe stops delivery', () => {
    const { hub } = setup()
    const a = new FakeSocket(); hub.attach(a)
    a.receive({ type: 'subscribe', channel: 'config' })
    a.receive({ type: 'unsubscribe', channel: 'config' })
    hub.broadcast('config', 1)
    expect(a.sent).toEqual([])
  })
  it('runs commands and reports errors with the request id', async () => {
    const { hub } = setup()
    const a = new FakeSocket(); hub.attach(a)
    a.receive({ type: 'command', id: 'c1', channel: 'volume', name: 'set', payload: { level: 3 } })
    a.receive({ type: 'command', id: 'c2', channel: 'volume', name: 'nope', payload: null })
    await new Promise((r) => setTimeout(r, 0))
    expect(a.sent).toContainEqual({ type: 'result', id: 'c1', result: { ok: true, p: { level: 3 } } })
    expect(a.sent.find((m) => m.id === 'c2')).toMatchObject({ type: 'error', id: 'c2' })
  })
  it('answers malformed messages with an error and survives', () => {
    const { hub } = setup()
    const a = new FakeSocket(); hub.attach(a)
    a.emit('message', Buffer.from('not json'))
    a.receive({ type: 'wat' })
    expect(a.sent.every((m) => m.type === 'error')).toBe(true)
    expect(a.sent).toHaveLength(2)
  })
})

describe('the cached last value of a channel', () => {
  const subscribe = (hub: Hub, channel: string) => {
    const socket = new FakeSocket()
    hub.attach(socket, { loopback: true, paired: false })
    socket.receive({ type: 'subscribe', channel })
    return socket
  }

  it('is replayed to a new subscriber', () => {
    let hub!: Hub
    const registry = new ProviderRegistry((c, d) => hub.broadcast(c, d), (c) => hub.forget(c))
    hub = new Hub(registry)
    registry.register({ channel: 'volume', intervalMs: 1000 })
    hub.broadcast('volume', { level: 7 })
    expect(subscribe(hub, 'volume').sent).toEqual([{ type: 'data', channel: 'volume', data: { level: 7 } }])
  })

  it('is dropped once the provider behind it is gone', () => {
    let hub!: Hub
    const registry = new ProviderRegistry((c, d) => hub.broadcast(c, d), (c) => hub.forget(c))
    hub = new Hub(registry)
    registry.register({ channel: 'homey:old', intervalMs: 1000 })
    hub.broadcast('homey:old', { devices: ['from the deleted connection'] })

    // The connection was deleted from the config.
    registry.unregister('homey:old')

    // Nothing replayed: that snapshot belonged to credentials that no longer exist.
    expect(subscribe(hub, 'homey:old').sent).toEqual([])
  })

  it('invalidates only live subscribers when a provider is replaced', () => {
    let hub!: Hub
    const registry = new ProviderRegistry((c, d) => hub.broadcast(c, d), (c) => hub.forget(c))
    hub = new Hub(registry)
    registry.register({ channel: 'homey:x', intervalMs: 1000 })
    const active = subscribe(hub, 'homey:x')
    const unrelated = subscribe(hub, 'config')
    hub.broadcast('homey:x', { devices: ['old host'] })

    registry.register({ channel: 'homey:x', intervalMs: 1000 })

    expect(active.sent).toEqual([
      { type: 'data', channel: 'homey:x', data: { devices: ['old host'] } },
      { type: 'invalidate', channel: 'homey:x' },
    ])
    expect(unrelated.sent).toEqual([])
    expect(subscribe(hub, 'homey:x').sent).toEqual([])
  })

  it('is dropped when the provider is replaced, so the old host is not shown', () => {
    let hub!: Hub
    const registry = new ProviderRegistry((c, d) => hub.broadcast(c, d), (c) => hub.forget(c))
    hub = new Hub(registry)
    registry.register({ channel: 'homey:x', intervalMs: 1000 })
    hub.broadcast('homey:x', { devices: ['old host'] })
    registry.register({ channel: 'homey:x', intervalMs: 1000 })
    expect(subscribe(hub, 'homey:x').sent).toEqual([])
  })

  it('survives the last subscriber leaving, so a reload paints at once', () => {
    let hub!: Hub
    const registry = new ProviderRegistry((c, d) => hub.broadcast(c, d), (c) => hub.forget(c))
    hub = new Hub(registry)
    registry.register({ channel: 'github:gh-1', intervalMs: 1000 })
    const first = subscribe(hub, 'github:gh-1')
    hub.broadcast('github:gh-1', { notifications: 3 })
    expect(first.sent).toHaveLength(1)
    // A dashboard reload takes every widget away and brings it back. The provider is the same
    // one and its last answer is still true, so the reloaded page must not paint blank for a
    // network round trip.
    first.emit('close')
    expect(subscribe(hub, 'github:gh-1').sent).toEqual([
      { type: 'data', channel: 'github:gh-1', data: { notifications: 3 } },
    ])
  })

  it('is dropped when the last subscriber leaves the clipboard, which must not linger', () => {
    let hub!: Hub
    const registry = new ProviderRegistry((c, d) => hub.broadcast(c, d), (c) => hub.forget(c))
    hub = new Hub(registry)
    registry.register({ channel: 'clipboard', intervalMs: 1000 })
    const first = subscribe(hub, 'clipboard')
    hub.broadcast('clipboard', { entries: [{ preview: 'something private' }] })
    expect(first.sent).toHaveLength(1)
    // The widget was removed from the dashboard: the clipboard provider clears its history on
    // stop(), and the hub must not keep handing the last snapshot out after that.
    first.emit('close')
    expect(subscribe(hub, 'clipboard').sent).toEqual([])
  })
})

describe('what one socket may ask for', () => {
  it('stops subscribing past the cap, and says so', () => {
    let hub!: Hub
    const registry = new ProviderRegistry((c, d) => hub.broadcast(c, d), (c) => hub.forget(c))
    hub = new Hub(registry)
    const socket = new FakeSocket()
    hub.attach(socket, { loopback: true, paired: false })
    for (let i = 0; i < MAX_CHANNELS_PER_SOCKET + 5; i++) {
      socket.receive({ type: 'subscribe', channel: `ch-${i}` })
    }
    const errors = socket.sent.filter((m) => m.type === 'error')
    expect(errors).toHaveLength(5)
    expect(errors[0].error).toMatch(/trop de canaux/)
  })

  it('does not count a repeated subscribe against the cap', () => {
    let hub!: Hub
    const registry = new ProviderRegistry((c, d) => hub.broadcast(c, d), (c) => hub.forget(c))
    hub = new Hub(registry)
    const socket = new FakeSocket()
    hub.attach(socket, { loopback: true, paired: false })
    for (let i = 0; i < MAX_CHANNELS_PER_SOCKET * 2; i++) {
      socket.receive({ type: 'subscribe', channel: 'volume' })
    }
    expect(socket.sent.filter((m) => m.type === 'error')).toEqual([])
  })

  it('frees a slot when a channel is unsubscribed', () => {
    let hub!: Hub
    const registry = new ProviderRegistry((c, d) => hub.broadcast(c, d), (c) => hub.forget(c))
    hub = new Hub(registry)
    const socket = new FakeSocket()
    hub.attach(socket, { loopback: true, paired: false })
    for (let i = 0; i < MAX_CHANNELS_PER_SOCKET; i++) socket.receive({ type: 'subscribe', channel: `ch-${i}` })
    socket.receive({ type: 'unsubscribe', channel: 'ch-0' })
    socket.receive({ type: 'subscribe', channel: 'something-new' })
    expect(socket.sent.filter((m) => m.type === 'error')).toEqual([])
  })

  it('refuses an empty channel name instead of subscribing to it', () => {
    let hub!: Hub
    const subscribed: string[] = []
    const registry = new ProviderRegistry((c, d) => hub.broadcast(c, d), (c) => hub.forget(c))
    const add = registry.addSubscriber.bind(registry)
    registry.addSubscriber = (channel: string) => { subscribed.push(channel); add(channel) }
    hub = new Hub(registry)
    const socket = new FakeSocket()
    hub.attach(socket, { loopback: true, paired: false })
    socket.receive({ type: 'subscribe', channel: '' })
    expect(subscribed).toEqual([])
    // It falls through to the same refusal any malformed message gets.
    expect(socket.sent).toEqual([{ type: 'error', error: 'message inconnu' }])
  })
})

describe('a paired socket', () => {
  const REFUSED = { type: 'error', error: 'canal non autorisé pour l’écran de cet appareil' }

  function pairedSetup() {
    let hub!: Hub
    const registry = new ProviderRegistry((c, d) => hub.broadcast(c, d), (c) => hub.forget(c))
    hub = new Hub(registry)
    const focused: unknown[] = []
    registry.register({ channel: 'spotify', intervalMs: 1000 })
    registry.register({ channel: 'system', intervalMs: 1000 })
    registry.register({
      channel: 'claude',
      commands: {
        focus: async (p, ctx) => {
          if (!ctx?.loopback && !ctx?.paired) throw new Error('refused')
          focused.push(p)
          return { ok: true }
        },
      },
    })
    let policy: Record<string, { subscriptions: string[]; commands: string[] } | null> = {
      'dev-a': { subscriptions: ['system', 'claude'], commands: ['claude'] },
      'dev-b': { subscriptions: ['system'], commands: [] },
    }
    hub.setPolicy((id) => policy[id] ?? null)
    hub.setDevicePayload((id) => ({ id, screenId: policy[id] ? 'tablet' : null }))
    hub.setHostView((_id, _channel, data) => data)
    const count = (channel: string) => (registry as any).states.get(channel).subscribers as number
    const paired = (deviceId: string) => {
      const socket = new FakeSocket()
      hub.attach(socket, { loopback: false, paired: true, deviceId })
      return socket
    }
    const attach = <S extends FakeSocket>(socket: S, deviceId: string): S => {
      hub.attach(socket, { loopback: false, paired: true, deviceId })
      return socket
    }
    return { hub, registry, focused, count, paired, attach, setPolicy: (p: typeof policy) => { policy = p } }
  }

  /** Like `ws`: close() only starts the handshake, and `close` fires later, if ever. */
  class LingeringSocket extends FakeSocket {
    terminated = false
    override close(code?: number) { this.closedWith = code }
    terminate() { this.terminated = true; this.emit('close') }
  }

  afterEach(() => { vi.useRealTimers() })

  it('refuses companion to a paired socket even when its screen holds fremplay', async () => {
    const { hub, paired, registry, setPolicy } = pairedSetup()
    const steered: unknown[] = []
    registry.register({ channel: 'companion', intervalMs: 1000, commands: { control: async (p) => { steered.push(p); return { ok: true } } } })
    hub.broadcast('companion', { pairing: { code: 'ABCD' } })
    // What the policy builds for a screen holding fremplay, wildcard included.
    setPolicy({ 'dev-a': { subscriptions: ['companion', 'companion:*'], commands: ['companion'] } })
    const socket = paired('dev-a')
    socket.receive({ type: 'subscribe', channel: 'companion' })
    socket.receive({ type: 'subscribe', channel: 'companion:x' })
    socket.receive({ type: 'command', id: 'c1', channel: 'companion', name: 'control', payload: { action: 'toggle' } })
    await new Promise((r) => setTimeout(r, 0))
    expect(socket.sent).toEqual([REFUSED, REFUSED, { ...REFUSED, id: 'c1' }])
    expect(steered).toEqual([])
    expect((registry as any).states.get('companion').subscribers).toBe(0)
    // This Mac's dashboard still gets it.
    const local = new FakeSocket()
    hub.attach(local, { loopback: true, paired: false })
    local.receive({ type: 'subscribe', channel: 'companion' })
    expect(local.sent).toEqual([{ type: 'data', channel: 'companion', data: { pairing: { code: 'ABCD' } } }])
    registry.stop()
  })

  it('is not heard once closed, even before the close handshake ends', async () => {
    const { hub, count, focused, attach, registry } = pairedSetup()
    const socket = attach(new LingeringSocket(), 'dev-a')
    socket.receive({ type: 'subscribe', channel: 'system' })
    expect(count('system')).toBe(1)

    hub.closeDevice('dev-a')
    expect(socket.closedWith).toBe(4401)
    expect(count('system')).toBe(0)

    socket.receive({ type: 'command', id: 'c1', channel: 'claude', name: 'focus', payload: { pid: 1 } })
    socket.receive({ type: 'subscribe', channel: 'system' })
    await new Promise((r) => setTimeout(r, 0))
    expect(focused).toEqual([])
    expect(count('system')).toBe(0)
    expect(socket.sent).toEqual([])

    // The late `close` event changes nothing: detaching is idempotent.
    socket.emit('close')
    expect(count('system')).toBe(0)
    registry.stop()
  })

  it('is dropped without a handshake when the peer does not finish closing', () => {
    vi.useFakeTimers()
    const { hub, attach, registry } = pairedSetup()
    const a = attach(new LingeringSocket(), 'dev-a'), b = attach(new LingeringSocket(), 'dev-b')
    hub.closeRemote()
    expect(a.terminated).toBe(false)
    vi.advanceTimersByTime(DEVICE_TERMINATE_MS)
    expect(a.terminated).toBe(true)
    expect(b.terminated).toBe(true)
    registry.stop()
  })

  it('fails closed when the policy throws, without throwing out of the message handler', async () => {
    const { hub, count, focused, paired, registry } = pairedSetup()
    hub.setPolicy(() => { throw new Error('config unreadable') })
    const socket = paired('dev-a')
    expect(() => socket.receive({ type: 'subscribe', channel: 'system' })).not.toThrow()
    expect(() => socket.receive({ type: 'command', id: 'c1', channel: 'claude', name: 'focus', payload: {} })).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    expect(count('system')).toBe(0)
    expect(focused).toEqual([])
    expect(socket.sent).toEqual([REFUSED, { ...REFUSED, id: 'c1' }])
    // The host channel stays open: a device with no screen still gets the page.
    socket.receive({ type: 'subscribe', channel: 'config' })
    expect(socket.sent).toHaveLength(2)
    registry.stop()
  })

  it('drops what a throwing policy can no longer vouch for on refresh', () => {
    const { hub, count, paired, registry } = pairedSetup()
    const socket = paired('dev-a')
    socket.receive({ type: 'subscribe', channel: 'system' })
    hub.setPolicy(() => { throw new Error('config unreadable') })
    expect(() => hub.refreshDevice('dev-a')).not.toThrow()
    expect(count('system')).toBe(0)
    registry.stop()
  })

  it('still revokes on refresh when the device payload throws, and sends nothing', () => {
    const { hub, count, paired, registry, setPolicy } = pairedSetup()
    const socket = paired('dev-a')
    socket.receive({ type: 'subscribe', channel: 'system' })
    setPolicy({ 'dev-a': { subscriptions: [], commands: [] } })
    hub.setDevicePayload(() => { throw new Error('store unreadable') })
    expect(() => hub.refreshDevice('dev-a')).not.toThrow()
    expect(count('system')).toBe(0)
    expect(socket.sent).toEqual([])
    expect(() => socket.receive({ type: 'subscribe', channel: 'device' })).not.toThrow()
    expect(socket.sent).toEqual([])
    registry.stop()
  })

  it('is refused a channel its screen does not show, and leaves no subscriber', () => {
    const { count, paired, registry } = pairedSetup()
    const socket = paired('dev-a')
    socket.receive({ type: 'subscribe', channel: 'spotify' })
    expect(socket.sent).toEqual([REFUSED])
    expect(count('spotify')).toBe(0)
    registry.stop()
  })

  it('may subscribe to the host config channel', () => {
    const { hub, paired, registry } = pairedSetup()
    const socket = paired('dev-a')
    socket.receive({ type: 'subscribe', channel: 'config' })
    hub.broadcast('config', { version: 1 })
    expect(socket.sent).toEqual([{ type: 'data', channel: 'config', data: { version: 1 } }])
    registry.stop()
  })

  it('may subscribe to its screen\'s channels', () => {
    const { count, paired, registry } = pairedSetup()
    const socket = paired('dev-a')
    socket.receive({ type: 'subscribe', channel: 'system' })
    expect(socket.sent).toEqual([])
    expect(count('system')).toBe(1)
    registry.stop()
  })

  it('loses what its new screen no longer allows, and hears about it on the device channel', () => {
    const { hub, count, paired, registry, setPolicy } = pairedSetup()
    const socket = paired('dev-a')
    socket.receive({ type: 'subscribe', channel: 'system' })
    socket.receive({ type: 'subscribe', channel: 'config' })
    expect(count('system')).toBe(1)

    setPolicy({ 'dev-a': { subscriptions: ['spotify'], commands: [] } })
    hub.refreshDevice('dev-a')

    expect(count('system')).toBe(0)
    expect(socket.sent).toEqual([{ type: 'data', channel: 'device', data: { id: 'dev-a', screenId: 'tablet' } }])
    // `config` is the host's, and survives any screen.
    hub.broadcast('config', 2)
    hub.broadcast('system', { cpu: 1 })
    expect(socket.sent.slice(1)).toEqual([{ type: 'data', channel: 'config', data: 2 }])
    registry.stop()
  })

  it('hears nothing on a host channel until a view is set', () => {
    const registry = new ProviderRegistry(() => {})
    const hub = new Hub(registry)
    const socket = new FakeSocket()
    hub.attach(socket, { loopback: false, paired: true, deviceId: 'dev-a' })
    socket.receive({ type: 'subscribe', channel: 'config' })
    hub.broadcast('config', { secret: 'the Mac\'s whole config' })
    expect(socket.sent).toEqual([])
    registry.stop()
  })

  it('is sent its own view of the config, and again only when that view changes', () => {
    const { hub, paired, registry } = pairedSetup()
    let screen = 'tab-a'
    hub.setHostView((id, channel, data) => (channel === 'config' ? { id, screen, of: (data as { n: number }).n } : null))
    const socket = paired('dev-a')
    const local = new FakeSocket()
    hub.attach(local, { loopback: true, paired: false })
    socket.receive({ type: 'subscribe', channel: 'config' })
    local.receive({ type: 'subscribe', channel: 'config' })
    hub.broadcast('config', { n: 1 })
    expect(socket.sent).toEqual([{ type: 'data', channel: 'config', data: { id: 'dev-a', screen: 'tab-a', of: 1 } }])
    expect(local.sent).toEqual([{ type: 'data', channel: 'config', data: { n: 1 } }])
    // A refresh that changes nothing in the view sends no config again.
    hub.refreshDevice('dev-a')
    expect(socket.sent.filter((m: any) => m.channel === 'config')).toHaveLength(1)
    // Moved to another screen: the new view comes before the `device` message.
    screen = 'tab-b'
    hub.refreshDevice('dev-a')
    const after = socket.sent.slice(-2)
    expect(after[0]).toEqual({ type: 'data', channel: 'config', data: { id: 'dev-a', screen: 'tab-b', of: 1 } })
    expect(after[1].channel).toBe('device')
    // A view that throws sends nothing, and throws nothing.
    hub.setHostView(() => { throw new Error('x') })
    expect(() => hub.broadcast('config', { n: 2 })).not.toThrow()
    expect(socket.sent.filter((m: any) => m.channel === 'config')).toHaveLength(2)
    registry.stop()
  })

  it('answers a command on a channel it may not use and on one that does not exist the same way', async () => {
    const { paired, registry, setPolicy } = pairedSetup()
    // `ghost:x` is in the policy but registered nowhere; `spotify` is registered but not allowed.
    setPolicy({ 'dev-a': { subscriptions: [], commands: ['claude', 'ghost:x'] } })
    const socket = paired('dev-a')
    socket.receive({ type: 'command', id: 'a', channel: 'ghost:x', name: 'nope', payload: {} })
    socket.receive({ type: 'command', id: 'b', channel: 'spotify', name: 'nope', payload: {} })
    socket.receive({ type: 'command', id: 'c', channel: 'nowhere:1', name: 'nope', payload: {} })
    await new Promise((r) => setTimeout(r, 0))
    expect(socket.sent).toEqual([{ ...REFUSED, id: 'a' }, { ...REFUSED, id: 'b' }, { ...REFUSED, id: 'c' }])
    registry.stop()
  })

  it('hears its own view of a widget channel named with the view, and the full one locally', () => {
    const { hub, paired, registry, setPolicy } = pairedSetup()
    setPolicy({ 'dev-a': { subscriptions: ['brightness'], commands: [] } })
    hub.setHostView((_id, channel, data) => (channel === 'brightness' ? { only: (data as { a: number }).a } : null), ['brightness'])
    const socket = paired('dev-a')
    const local = new FakeSocket()
    hub.attach(local, { loopback: true, paired: false })
    socket.receive({ type: 'subscribe', channel: 'brightness' })
    local.receive({ type: 'subscribe', channel: 'brightness' })
    hub.broadcast('brightness', { a: 1, b: 2 })
    expect(socket.sent).toEqual([{ type: 'data', channel: 'brightness', data: { only: 1 } }])
    expect(local.sent).toEqual([{ type: 'data', channel: 'brightness', data: { a: 1, b: 2 } }])
    registry.stop()
  })

  it('hears the theme through the devices view, without the next switch, and no dev-tool channel', () => {
    const { hub, paired, registry } = pairedSetup()
    hub.setHostView((_id, channel, data) => deviceHostView(channel, data, 'tablet'), ['brightness'])
    const socket = paired('dev-a')
    socket.receive({ type: 'subscribe', channel: 'theme' })
    socket.receive({ type: 'subscribe', channel: 'widget-dev' })
    hub.broadcast('theme', { id: 'edge', phase: 'night', scheduled: true, next: { at: '2026-10-19T06:12:00.000Z', to: 'day' } })
    hub.broadcast('widget-dev', { id: 'w' })
    expect(socket.sent).toEqual([{ type: 'data', channel: 'theme', data: { id: 'edge', phase: 'night', scheduled: true } }])
    registry.stop()
  })

  it('hears a notified event on a host channel through its view, and nothing when the view has none', () => {
    const { hub, paired, registry } = pairedSetup()
    hub.setHostView((_id, channel, data) => (channel === 'theme' ? { seen: data } : null))
    const socket = paired('dev-a')
    const local = new FakeSocket()
    hub.attach(local, { loopback: true, paired: false })
    for (const s of [socket, local]) {
      s.receive({ type: 'subscribe', channel: 'theme' })
      s.receive({ type: 'subscribe', channel: 'widget-dev' })
    }
    hub.notify('widget-dev', { ids: ['w'], manifest: false })
    hub.notify('theme', 1)
    // Twice the same event is two events: no deduplication on a notify.
    hub.notify('theme', 1)
    expect(socket.sent).toEqual([
      { type: 'data', channel: 'theme', data: { seen: 1 } },
      { type: 'data', channel: 'theme', data: { seen: 1 } },
    ])
    expect(local.sent).toHaveLength(3)
    expect(local.sent[0]).toEqual({ type: 'data', channel: 'widget-dev', data: { ids: ['w'], manifest: false } })
    registry.stop()
  })

  it('with no screen, is held to the host channels', () => {
    const { paired, registry } = pairedSetup()
    const socket = paired('dev-unknown')
    socket.receive({ type: 'subscribe', channel: 'system' })
    socket.receive({ type: 'subscribe', channel: 'config' })
    expect(socket.sent).toEqual([REFUSED])
    registry.stop()
  })

  it('runs a command its screen allows, with its paired context', async () => {
    const { focused, paired, registry } = pairedSetup()
    const socket = paired('dev-a')
    socket.receive({ type: 'command', id: 'c1', channel: 'claude', name: 'focus', payload: { pid: 1 } })
    await new Promise((r) => setTimeout(r, 0))
    expect(socket.sent).toEqual([{ type: 'result', id: 'c1', result: { ok: true } }])
    expect(focused).toEqual([{ pid: 1 }])
    registry.stop()
  })

  it('is refused a command its screen does not allow, with the request id, and nothing runs', async () => {
    const { focused, paired, registry } = pairedSetup()
    const socket = paired('dev-b')
    socket.receive({ type: 'command', id: 'c1', channel: 'claude', name: 'focus', payload: { pid: 1 } })
    await new Promise((r) => setTimeout(r, 0))
    expect(socket.sent).toEqual([{ ...REFUSED, id: 'c1' }])
    expect(focused).toEqual([])
    registry.stop()
  })

  it('gets its own payload replayed when it subscribes to the device channel', () => {
    const { paired, registry } = pairedSetup()
    const socket = paired('dev-b')
    socket.receive({ type: 'subscribe', channel: 'device' })
    expect(socket.sent).toEqual([{ type: 'data', channel: 'device', data: { id: 'dev-b', screenId: 'tablet' } }])
    registry.stop()
  })

  it('closes only the device that is closed', () => {
    const { hub, paired, registry } = pairedSetup()
    const a1 = paired('dev-a'), a2 = paired('dev-a'), b = paired('dev-b')
    hub.closeDevice('dev-a')
    expect(a1.closedWith).toBe(DEVICE_CLOSE_CODE)
    expect(a2.closedWith).toBe(4401)
    expect(b.closedWith).toBeUndefined()
    registry.stop()
  })

  it('releases its subscriptions when closed', () => {
    const { hub, count, paired, registry } = pairedSetup()
    const socket = paired('dev-a')
    socket.receive({ type: 'subscribe', channel: 'system' })
    hub.closeDevice('dev-a')
    expect(count('system')).toBe(0)
    // Gone from the hub: a refresh reaches nothing.
    hub.refreshDevice('dev-a')
    expect(socket.sent).toEqual([])
    registry.stop()
  })

  it('is closed by closeRemote, which leaves local sockets open', () => {
    const { hub, paired, registry } = pairedSetup()
    const a = paired('dev-a'), b = paired('dev-b')
    const local = new FakeSocket()
    hub.attach(local, { loopback: true, paired: false })
    hub.closeRemote()
    expect(a.closedWith).toBe(4401)
    expect(b.closedWith).toBe(4401)
    expect(local.closedWith).toBeUndefined()
    local.receive({ type: 'subscribe', channel: 'config' })
    hub.broadcast('config', 1)
    expect(local.sent).toEqual([{ type: 'data', channel: 'config', data: 1 }])
    registry.stop()
  })
})

describe('the device channel', () => {
  it('tells a local socket nothing', () => {
    let hub!: Hub
    const registry = new ProviderRegistry((c, d) => hub.broadcast(c, d), (c) => hub.forget(c))
    hub = new Hub(registry)
    hub.setDevicePayload((id) => ({ id }))
    const local = new FakeSocket()
    hub.attach(local, { loopback: true, paired: false })
    local.receive({ type: 'subscribe', channel: 'device' })
    hub.broadcast('device', { id: 'forged' })
    expect(local.sent).toEqual([])
  })

  it('leaves a local socket unrestricted by any policy', () => {
    let hub!: Hub
    const registry = new ProviderRegistry((c, d) => hub.broadcast(c, d), (c) => hub.forget(c))
    hub = new Hub(registry)
    hub.setPolicy(() => ({ subscriptions: [], commands: [] }))
    const local = new FakeSocket()
    hub.attach(local, { loopback: true, paired: false })
    local.receive({ type: 'subscribe', channel: 'spotify' })
    hub.broadcast('spotify', 1)
    expect(local.sent).toEqual([{ type: 'data', channel: 'spotify', data: 1 }])
  })
})
