import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { ProviderRegistry } from '../src/providers/registry.js'
import { HEALTH_CHANNEL, healthSnapshot, publishHealth, type HealthSnapshot } from '../src/providers/health.js'
import { Hub } from '../src/ws/hub.js'
import { ManifestSchema } from '../src/widgets/manifest.js'

/**
 * The editor's widget health reads how each provider's last poll went from one channel. These
 * tests hold the two things that make it safe to publish: it carries codes, never a thrown
 * message, and nothing but the Mac's own pages can subscribe to it.
 */
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

class FakeSocket extends EventEmitter {
  sent: any[] = []
  send(data: string) { this.sent.push(JSON.parse(data)) }
  receive(msg: unknown) { this.emit('message', Buffer.from(JSON.stringify(msg))) }
  close() { this.emit('close') }
}

function setup(answers: Record<string, () => Promise<unknown>>) {
  const sent: HealthSnapshot[] = []
  const registry = new ProviderRegistry(() => {})
  for (const [channel, poll] of Object.entries(answers)) registry.register({ channel, intervalMs: 1000, poll })
  const stop = publishHealth(registry, (channel, data) => {
    expect(channel).toBe(HEALTH_CHANNEL)
    sent.push(data)
  }, 50)
  return { registry, sent, stop }
}

describe('the health channel', () => {
  it('says nothing about a channel nobody has polled yet', () => {
    const { sent, stop } = setup({ github: async () => ({ runs: [] }) })
    expect(sent).toEqual([{ channels: {} }])
    stop()
  })

  it('publishes each polled channel’s outcome, and again only when it changes', async () => {
    let answer: unknown = { error: 'offline' }
    const { registry, sent, stop } = setup({ 'github:gh-1': async () => answer })
    registry.addSubscriber('github:gh-1')
    await vi.advanceTimersByTimeAsync(60)
    expect(sent.at(-1)).toEqual({ channels: { 'github:gh-1': 'offline' } })
    const count = sent.length

    // The same failure again is not news.
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent.length).toBe(count)

    answer = { runs: [] }
    await vi.advanceTimersByTimeAsync(1000 + 60)
    expect(sent.at(-1)).toEqual({ channels: { 'github:gh-1': null } })
    stop()
    registry.stop()
  })

  it('reduces a thrown message to a code, so a host or a path in it never leaves', async () => {
    const { registry, sent, stop } = setup({
      'synology:nas': async () => { throw new Error('connect ECONNREFUSED 192.0.2.10:5001 /Users/someone') },
      'calendar:c1': async () => ({ error: 'fetch failed for https://example.com/secret.ics' }),
    })
    registry.addSubscriber('synology:nas')
    registry.addSubscriber('calendar:c1')
    await vi.advanceTimersByTimeAsync(60)
    expect(sent.at(-1)).toEqual({ channels: { 'synology:nas': 'exception', 'calendar:c1': 'error' } })
    expect(JSON.stringify(sent)).not.toMatch(/192\.0\.2|example\.com|Users/)
    stop()
    registry.stop()
  })

  it('forgets a channel whose provider went away', async () => {
    const { registry, sent, stop } = setup({ 'github:gh-1': async () => ({ error: 'unauthorized' }) })
    registry.addSubscriber('github:gh-1')
    await vi.advanceTimersByTimeAsync(60)
    expect(sent.at(-1)?.channels['github:gh-1']).toBe('unauthorized')
    registry.unregister('github:gh-1')
    await vi.advanceTimersByTimeAsync(60)
    expect(sent.at(-1)).toEqual({ channels: {} })
    stop()
  })

  it('reads the registry’s status as it is', () => {
    expect(healthSnapshot([
      { channel: 'a', watched: true, lastError: null },
      { channel: 'b', watched: false, lastError: 'offline' },
      { channel: 'c', watched: true },
    ])).toEqual({ channels: { a: null, b: 'offline' } })
  })
})

describe('who may hear the health channel', () => {
  it('is a channel no widget manifest may declare', () => {
    const base = { id: 'w', name: 'W', version: '1.0.0', minSize: [4, 2], defaultSize: [4, 2] }
    expect(ManifestSchema.safeParse({ ...base, subscriptions: [HEALTH_CHANNEL] }).success).toBe(false)
  })

  it('is refused to a paired device, whatever its screen allows', () => {
    let hub!: Hub
    const registry = new ProviderRegistry((c, d) => hub.broadcast(c, d))
    hub = new Hub(registry)
    hub.setPolicy(() => ({ subscriptions: ['system'], commands: [] }))
    hub.broadcast(HEALTH_CHANNEL, { channels: { 'github:gh-1': 'offline' } })
    const device = new FakeSocket()
    hub.attach(device, { loopback: false, paired: true, deviceId: 'dev-a' })
    device.receive({ type: 'subscribe', channel: HEALTH_CHANNEL })
    expect(device.sent.some((m) => m.type === 'data')).toBe(false)
    expect(device.sent[0]?.type).toBe('error')

    // The Mac's own editor hears it.
    const local = new FakeSocket()
    hub.attach(local, { loopback: true, paired: false })
    local.receive({ type: 'subscribe', channel: HEALTH_CHANNEL })
    expect(local.sent).toEqual([{ type: 'data', channel: HEALTH_CHANNEL, data: { channels: { 'github:gh-1': 'offline' } } }])
  })
})
