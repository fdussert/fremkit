import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProviderRegistry } from '../src/providers/registry.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
it('does not publish a late idle poll or carry it into a resubscribed service lifecycle', async () => {
  const cached: unknown[] = []
  const registry = new ProviderRegistry((_channel, value) => cached.push(value))
  let release!: (value: string) => void
  let polls = 0
  registry.register({ channel: 'gmail:account-a', intervalMs: 100, poll: async () => {
    polls++
    return polls === 1 ? new Promise<string>((resolve) => { release = resolve }) : 'fresh'
  } })
  registry.addSubscriber('gmail:account-a')
  await vi.advanceTimersByTimeAsync(0)
  registry.removeSubscriber('gmail:account-a')
  registry.addSubscriber('gmail:account-a')
  release('retired snapshot')
  await vi.advanceTimersByTimeAsync(1)
  expect(cached).toEqual(['fresh'])
  registry.stop()
  expect(vi.getTimerCount()).toBe(0)
})

it('rejects a command result returned after replacement or suspension', async () => {
  const registry = new ProviderRegistry(() => {})
  let release!: (value: string) => void
  registry.register({ channel: 'gmail:account-a', commands: { read: async () => new Promise<string>((resolve) => { release = resolve }) } })
  const result = registry.runCommand('gmail:account-a', 'read', {})
  const rejected = expect(result).rejects.toThrow(/retired/)
  registry.suspend('gmail:account-a')
  release('private result')
  await rejected
  await expect(registry.runCommand('gmail:account-a', 'read', {})).rejects.toThrow()
})
