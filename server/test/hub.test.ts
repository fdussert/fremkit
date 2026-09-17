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
