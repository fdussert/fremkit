import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ProviderRegistry } from '../src/providers/registry.js'
import type { Provider } from '../src/providers/types.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function make(values: (unknown | Error)[], intervalMs = 1000): { provider: Provider; polls: () => number } {
  let i = 0
  const provider: Provider = {
    channel: 'test', intervalMs,
    async poll() {
      const v = values[Math.min(i++, values.length - 1)]
      if (v instanceof Error) throw v
      return v
    },
    commands: { echo: async (p) => ({ echoed: p }) },
  }
  return { provider, polls: () => i }
}

describe('ProviderRegistry', () => {
  it('does not poll without subscribers', async () => {
    const publish = vi.fn()
    const { provider, polls } = make([1])
    const reg = new ProviderRegistry(publish)
    reg.register(provider)
    await vi.advanceTimersByTimeAsync(5000)
    expect(polls()).toBe(0)
    expect(publish).not.toHaveBeenCalled()
  })
  it('polls at interval and publishes only on change', async () => {
    const publish = vi.fn()
    const { provider } = make([{ a: 1 }, { a: 1 }, { a: 2 }])
    const reg = new ProviderRegistry(publish)
    reg.register(provider)
    reg.addSubscriber('test')
    await vi.advanceTimersByTimeAsync(0)
    expect(publish).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(publish).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenLastCalledWith('test', { a: 2 })
    reg.stop()
  })
  it('stops polling when the last subscriber leaves', async () => {
    const publish = vi.fn()
    const { provider, polls } = make([1, 2, 3, 4])
    const reg = new ProviderRegistry(publish)
    reg.register(provider)
    reg.addSubscriber('test'); reg.addSubscriber('test')
    await vi.advanceTimersByTimeAsync(0)
    reg.removeSubscriber('test')
    await vi.advanceTimersByTimeAsync(1000)
    expect(polls()).toBe(2)
    reg.removeSubscriber('test')
    await vi.advanceTimersByTimeAsync(5000)
    expect(polls()).toBe(2)
  })
  it('publishes { error } once and backs off exponentially, capped at 60s', async () => {
    const publish = vi.fn()
    const { provider, polls } = make([new Error('boom')])
    const reg = new ProviderRegistry(publish)
    reg.register(provider)
    reg.addSubscriber('test')
    await vi.advanceTimersByTimeAsync(0)
    expect(publish).toHaveBeenCalledWith('test', { error: 'boom' })
    await vi.advanceTimersByTimeAsync(1000)   // retry after 1s
    expect(polls()).toBe(2)
    await vi.advanceTimersByTimeAsync(2000)   // after 2s
    expect(polls()).toBe(3)
    await vi.advanceTimersByTimeAsync(4000)   // after 4s
    expect(polls()).toBe(4)
    expect(publish).toHaveBeenCalledTimes(1)
    for (let k = 0; k < 10; k++) await vi.advanceTimersByTimeAsync(60000)
    const before = polls()
    await vi.advanceTimersByTimeAsync(60000)
    expect(polls()).toBe(before + 1)
    reg.stop()
  })
  it('runs commands and rejects unknown ones', async () => {
    const reg = new ProviderRegistry(vi.fn())
    reg.register(make([1]).provider)
    await expect(reg.runCommand('test', 'echo', 42)).resolves.toEqual({ echoed: 42 })
    await expect(reg.runCommand('test', 'nope', null)).rejects.toThrow(/inconnue/)
    await expect(reg.runCommand('ghost', 'echo', null)).rejects.toThrow(/inconnu/)
  })
})

describe('dynamic providers', () => {
  const makeProvider = () => {
    const started: string[] = []
    return {
      started,
      provider: {
        channel: 'azure-devops:ado-x1z9',
        intervalMs: 50,
        start: () => { started.push('start') },
        stop: () => { started.push('stop') },
        poll: async () => ({ tick: started.length }),
      },
    }
  }

  it('starts on the first subscriber and stops on the last unsubscribe', async () => {
    const published: unknown[] = []
    const registry = new ProviderRegistry((_c, d) => published.push(d))
    const { started, provider } = makeProvider()
    registry.register(provider)
    registry.addSubscriber(provider.channel)
    expect(started).toEqual(['start'])
    registry.removeSubscriber(provider.channel)
    expect(started).toEqual(['start', 'stop'])
    registry.stop()
  })

  it('lists its channels and forgets an unregistered one', () => {
    const registry = new ProviderRegistry(() => {})
    const { provider } = makeProvider()
    registry.register(provider)
    expect(registry.channels()).toContain('azure-devops:ado-x1z9')
    registry.unregister('azure-devops:ado-x1z9')
    expect(registry.has('azure-devops:ado-x1z9')).toBe(false)
    expect(registry.channels()).toEqual([])
  })

  it('stops a provider it unregisters while it has subscribers', () => {
    const registry = new ProviderRegistry(() => {})
    const { started, provider } = makeProvider()
    registry.register(provider)
    registry.addSubscriber(provider.channel)
    registry.unregister(provider.channel)
    expect(started).toEqual(['start', 'stop'])
  })

  it('carries subscribers over when a channel is re-registered', async () => {
    const registry = new ProviderRegistry(() => {})
    const first = makeProvider()
    registry.register(first.provider)
    registry.addSubscriber(first.provider.channel)
    const second = makeProvider()
    registry.register(second.provider)
    expect(first.started).toEqual(['start', 'stop'])
    expect(second.started).toEqual(['start'])
    registry.stop()
  })

  it('never stops a provider that was never started, nor twice in a row', () => {
    const registry = new ProviderRegistry(() => {})
    const { started, provider } = makeProvider()
    registry.register(provider)
    registry.unregister(provider.channel)
    expect(started).toEqual([])

    const again = makeProvider()
    registry.register(again.provider)
    registry.addSubscriber(again.provider.channel)
    registry.removeSubscriber(again.provider.channel)
    registry.removeSubscriber(again.provider.channel)
    registry.stop()
    expect(again.started).toEqual(['start', 'stop'])
  })
})
