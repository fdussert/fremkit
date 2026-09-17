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

describe('a provider that has been replaced', () => {
  /**
   * A provider whose poll hangs until the test lets it through. `let()` releases a poll that is
   * already waiting *and* opens the gate for later ones, so calling it up front gives a provider
   * that simply polls normally.
   */
  function gated(channel: string, data: unknown) {
    let release: (() => void) | undefined
    let open = false
    const polls: unknown[] = []
    const provider: Provider = {
      channel,
      intervalMs: 1000,
      async poll() {
        polls.push(data)
        if (open) return data
        await new Promise<void>((r) => { release = r })
        return data
      },
    }
    return { provider, polls, let: () => { open = true; release?.() } }
  }

  it('does not publish the old provider\'s answer once it has been replaced', async () => {
    const published: [string, unknown][] = []
    const registry = new ProviderRegistry((channel, data) => published.push([channel, data]))
    const old = gated('conn', 'from the old credentials')
    registry.register(old.provider)
    registry.addSubscriber('conn')
    await vi.advanceTimersByTimeAsync(0)
    expect(old.polls).toHaveLength(1)

    // The connection was edited: the manager rebuilds the provider on the same channel while the
    // old poll is still in flight.
    const fresh = gated('conn', 'from the new credentials')
    fresh.let()
    registry.register(fresh.provider)
    old.let()
    await vi.advanceTimersByTimeAsync(0)

    expect(published.map(([, d]) => d)).not.toContain('from the old credentials')
  })

  it('does not keep polling the old provider after it has been replaced', async () => {
    const registry = new ProviderRegistry(() => {})
    const old = gated('conn', 'old')
    registry.register(old.provider)
    registry.addSubscriber('conn')
    await vi.advanceTimersByTimeAsync(0)
    expect(old.polls).toHaveLength(1)

    const fresh = gated('conn', 'new')
    fresh.let()
    registry.register(fresh.provider)
    old.let()
    await vi.advanceTimersByTimeAsync(0)
    const after = old.polls.length

    // An orphaned state used to re-arm its own timer and go on polling the device for ever,
    // with the credentials the user had just changed.
    await vi.advanceTimersByTimeAsync(5000)
    expect(old.polls).toHaveLength(after)
  })

  it('does not keep polling a channel that was unregistered mid-poll', async () => {
    const registry = new ProviderRegistry(() => {})
    const old = gated('conn', 'old')
    registry.register(old.provider)
    registry.addSubscriber('conn')
    await vi.advanceTimersByTimeAsync(0)

    // The connection was deleted outright.
    registry.unregister('conn')
    old.let()
    await vi.advanceTimersByTimeAsync(0)
    const after = old.polls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(old.polls).toHaveLength(after)
  })

  it('keeps the new provider polling normally', async () => {
    const registry = new ProviderRegistry(() => {})
    const old = gated('conn', 'old')
    registry.register(old.provider)
    registry.addSubscriber('conn')
    await vi.advanceTimersByTimeAsync(0)

    const fresh = gated('conn', 'new')
    fresh.let()
    registry.register(fresh.provider)
    old.let()
    await vi.advanceTimersByTimeAsync(0)
    const started = fresh.polls.length
    expect(started).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(3000)
    expect(fresh.polls.length).toBeGreaterThan(started)
  })
})

describe('runCommand and the prototype chain', () => {
  it('refuses a command name that is a prototype member', async () => {
    const registry = new ProviderRegistry(() => {})
    registry.register({
      channel: 'test', intervalMs: 1000,
      commands: { real: async () => 'ok' },
    })
    expect(await registry.runCommand('test', 'real', null)).toBe('ok')
    // A command name arrives in a widget's message; a plain property read answered these off
    // Function.prototype and the registry then called them.
    for (const name of ['constructor', 'toString', 'call', 'apply', 'bind', '__proto__', 'valueOf']) {
      await expect(registry.runCommand('test', name, null), name).rejects.toThrow(/commande inconnue/)
    }
  })
  it('still refuses a plainly unknown command', async () => {
    const registry = new ProviderRegistry(() => {})
    registry.register({ channel: 'test', intervalMs: 1000, commands: { real: async () => 'ok' } })
    await expect(registry.runCommand('test', 'nope', null)).rejects.toThrow(/commande inconnue/)
    await expect(registry.runCommand('ghost', 'real', null)).rejects.toThrow(/canal inconnu/)
  })
})
