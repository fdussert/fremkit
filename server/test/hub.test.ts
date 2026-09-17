import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Hub } from '../src/ws/hub.js'
import { ProviderRegistry } from '../src/providers/registry.js'

class FakeSocket extends EventEmitter {
  sent: any[] = []
  send(data: string) { this.sent.push(JSON.parse(data)) }
  receive(msg: unknown) { this.emit('message', Buffer.from(JSON.stringify(msg))) }
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
    hub.attach(socket, { loopback: true })
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

  it('is dropped when the provider is replaced, so the old host is not shown', () => {
    let hub!: Hub
    const registry = new ProviderRegistry((c, d) => hub.broadcast(c, d), (c) => hub.forget(c))
    hub = new Hub(registry)
    registry.register({ channel: 'homey:x', intervalMs: 1000 })
    hub.broadcast('homey:x', { devices: ['old host'] })
    registry.register({ channel: 'homey:x', intervalMs: 1000 })
    expect(subscribe(hub, 'homey:x').sent).toEqual([])
  })

  it('is dropped when the last subscriber leaves, so the next one polls afresh', () => {
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
