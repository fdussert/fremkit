import { EventEmitter } from 'node:events'
import { expect, it } from 'vitest'
import { ProviderRegistry } from '../src/providers/registry.js'
import { Hub } from '../src/ws/hub.js'
class Socket extends EventEmitter {
  sent: unknown[] = []
  send(value: string) { this.sent.push(JSON.parse(value)) }
  subscribe(channel: string) { this.emit('message', JSON.stringify({ type: 'subscribe', channel })) }
}
it('invalidates client caches on replacement/removal without removing valid subscriptions', () => {
  let hub!: Hub
  const providers = new ProviderRegistry((c, d) => hub.broadcast(c, d), (c) => hub.forget(c))
  hub = new Hub(providers)
  providers.register({ channel: 'gmail:account-a' })
  providers.register({ channel: 'gmail:account-b' })
  const a = new Socket(); const b = new Socket()
  hub.attach(a); hub.attach(b)
  a.subscribe('gmail:account-a'); b.subscribe('gmail:account-b')
  hub.broadcast('gmail:account-a', 'old snapshot')
  providers.register({ channel: 'gmail:account-a' })
  expect(a.sent.at(-1)).toEqual({ type: 'invalidate', channel: 'gmail:account-a' })
  expect(b.sent).toEqual([])
  hub.broadcast('gmail:account-a', 'fresh snapshot')
  expect(a.sent.at(-1)).toEqual({ type: 'data', channel: 'gmail:account-a', data: 'fresh snapshot' })
  providers.unregister('gmail:account-a')
  expect(a.sent.at(-1)).toEqual({ type: 'invalidate', channel: 'gmail:account-a' })
  const late = new Socket(); hub.attach(late); late.subscribe('gmail:account-a')
  expect(late.sent).toEqual([])
})
