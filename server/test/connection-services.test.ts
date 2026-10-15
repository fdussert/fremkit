import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionManager } from '../src/connections/manager.js'
import { ConnectionTypeRegistry } from '../src/connections/registry.js'
import type { ConnectionServiceContext, ConnectionType } from '../src/connections/types.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import type { SecretStore } from '../src/secrets/types.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
const connection = (id = 'account-a') => ({ id, type: 'test-account', name: id, fields: {} })
function setup() {
  const values = new Map<string, string>([['account-a/token', 'initial'], ['account-b/token', 'other']])
  const secrets: SecretStore = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value) },
    delete: async (key) => { values.delete(key) },
  }
  const contexts: ConnectionServiceContext[] = []
  const events: string[] = []
  const cached = new Map<string, unknown>()
  const providers = new ProviderRegistry((channel, data) => cached.set(channel, data), (channel) => cached.delete(channel))
  const type: ConnectionType = {
    id: 'test-account', name: 'Test account', description: '', icon: 'mail',
    fields: [{ key: 'token', label: 'Token', secret: true }],
    test: async () => ({ ok: true, detail: 'ok' }),
    services: ['gmail', 'google-calendar'].map((id) => ({
      id, channelPrefix: id,
      createProvider: (ctx: ConnectionServiceContext) => {
        contexts.push(ctx)
        return {
          channel: ctx.channel, intervalMs: 100,
          start: () => { events.push(`start:${ctx.channel}`) },
          stop: () => { events.push(`stop:${ctx.channel}`) },
          poll: () => ctx.account.request(async ({ secrets }) => secrets.token),
          commands: { read: () => ctx.account.request(async ({ secrets }) => secrets.token) },
        }
      },
    })),
  }
  const types = new ConnectionTypeRegistry([type])
  const manager = new ConnectionManager({ registry: providers, types, secrets })
  return { manager, providers, values, secrets, contexts, events, cached, types, type }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('connection services', () => {
  it('creates independent channels per account and starts only a subscribed service', async () => {
    const { manager, providers, contexts, events, cached, types } = setup()
    await manager.sync([connection(), connection('account-b')])
    expect(providers.channels()).toEqual(['gmail:account-a', 'google-calendar:account-a', 'gmail:account-b', 'google-calendar:account-b'])
    expect(contexts[0].account).toBe(contexts[1].account)
    expect(contexts[0].account).not.toBe(contexts[2].account)
    expect(types.describe()[0].services).toEqual([{ id: 'gmail', channelPrefix: 'gmail' }, { id: 'google-calendar', channelPrefix: 'google-calendar' }])
    expect(manager.channelFor(connection(), 'gmail')).toBe('gmail:account-a')
    expect(() => manager.channelFor(connection())).toThrow(/service/)
    expect(() => manager.channelFor(connection(), 'unknown')).toThrow(/service/)
    providers.addSubscriber('gmail:account-a')
    await vi.advanceTimersByTimeAsync(0)
    expect(events).toEqual(['start:gmail:account-a'])
    expect([...cached]).toEqual([['gmail:account-a', 'initial']])
    providers.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('replaces every service on credential change, inherits subscriptions, and clears caches', async () => {
    const { manager, providers, contexts, events, cached, values } = setup()
    await manager.sync([connection()])
    providers.addSubscriber('gmail:account-a')
    providers.addSubscriber('google-calendar:account-a')
    await vi.advanceTimersByTimeAsync(0)
    const old = contexts[0]
    values.set('account-a/token', 'replacement')
    await manager.sync([connection()])
    expect(old.account.signal.aborted).toBe(true)
    expect(cached.size).toBe(0)
    expect(events.filter((e) => e.startsWith('stop:'))).toEqual(['stop:gmail:account-a', 'stop:google-calendar:account-a'])
    await vi.advanceTimersByTimeAsync(0)
    expect([...cached.values()]).toEqual(['replacement', 'replacement'])
    await old.saveSecret!('token', 'stale')
    expect(values.get('account-a/token')).toBe('replacement')
    await manager.forget(connection())
    expect(providers.channels()).toEqual([])
    expect(cached.size).toBe(0)
    expect(values.size).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a factory escaping its declared service channel without partially registering the account', async () => {
    const { manager, providers, type } = setup()
    type.services![1].createProvider = () => ({ channel: 'gmail:someone-else' })
    await expect(manager.sync([connection()])).rejects.toThrow(/channel/)
    expect(providers.channels()).toEqual([])
  })
})

describe('account credential concurrency', () => {
  it('shares one refresh across services and reuses a newer revision for delayed unauthorized replies', async () => {
    const { manager, contexts, values, providers } = setup()
    await manager.sync([connection(), connection('account-b')])
    const exchange = deferred<Record<string, string>>()
    let refreshes = 0
    const refresh = async () => { refreshes++; return exchange.promise }
    const first = contexts[0].account.refresh(0, refresh)
    const second = contexts[1].account.refresh(0, refresh)
    exchange.resolve({ token: 'renewed' })
    expect((await first).revision).toBe(1)
    expect((await second).secrets.token).toBe('renewed')
    expect((await contexts[1].account.refresh(0, refresh)).secrets.token).toBe('renewed')
    expect(refreshes).toBe(1)
    expect(values.get('account-a/token')).toBe('renewed')
    expect(await providers.runCommand('google-calendar:account-a', 'read', null)).toBe('renewed')
    expect(await providers.runCommand('gmail:account-b', 'read', null)).toBe('other')
    await manager.sync([connection(), connection('account-b')])
    expect(contexts).toHaveLength(4)
  })

  it('aborts removed accounts without awaiting their refresh and rejects late requests and writes', async () => {
    const { manager, contexts, values, providers } = setup()
    await manager.sync([connection()])
    const gate = deferred<Record<string, string>>()
    const pending = contexts[0].account.refresh(0, async () => gate.promise)
    const failed = expect(pending).rejects.toThrow(/retired/)
    const requestGate = deferred<string>()
    const request = contexts[1].account.request(async () => requestGate.promise)
    const requestFailed = expect(request).rejects.toThrow(/retired/)
    await manager.forget(connection())
    expect(contexts[0].account.signal.aborted).toBe(true)
    gate.resolve({ token: 'late' })
    requestGate.resolve('private snapshot')
    await Promise.all([failed, requestFailed])
    expect(values.has('account-a/token')).toBe(false)
    expect(providers.channels()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('finishes an already-started secret write before deleting the account', async () => {
    const { manager, contexts, values, secrets } = setup()
    await manager.sync([connection()])
    const gate = deferred<void>()
    const started = deferred<void>()
    secrets.set = async (key, value) => { started.resolve(); await gate.promise; values.set(key, value) }
    const write = contexts[0].saveSecret!('token', 'late')
    await started.promise
    const forgetting = manager.forget(connection())
    gate.resolve()
    await Promise.all([write, forgetting])
    expect(values.has('account-a/token')).toBe(false)
  })

  it('managed credential replacement prevents a stale refresh overwriting the new credentials', async () => {
    const { manager, providers, contexts, cached, values } = setup()
    await manager.sync([connection()])
    providers.addSubscriber('gmail:account-a')
    await vi.advanceTimersByTimeAsync(0)
    const gate = deferred<Record<string, string>>()
    const pending = contexts[0].account.refresh(0, async () => gate.promise)
    const failed = expect(pending).rejects.toThrow(/retired/)
    await manager.updateSecrets(connection(), { token: 'user-replacement' })
    expect(cached.size).toBe(0)
    gate.resolve({ token: 'stale-refresh' })
    await failed
    await manager.sync([connection()])
    await vi.advanceTimersByTimeAsync(0)
    expect(values.get('account-a/token')).toBe('user-replacement')
    expect(cached.get('gmail:account-a')).toBe('user-replacement')
    providers.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a refresh committing over a newer provider credential write', async () => {
    const { manager, contexts, values } = setup()
    await manager.sync([connection()])
    const gate = deferred<Record<string, string>>()
    const pending = contexts[0].account.refresh(0, async () => gate.promise)
    await contexts[1].saveSecret!('token', 'newer')
    gate.resolve({ token: 'older' })
    expect((await pending).secrets.token).toBe('newer')
    expect(values.get('account-a/token')).toBe('newer')
  })

  it('does not persist undeclared refresh keys and permits retry after failure', async () => {
    const { manager, contexts, values } = setup()
    await manager.sync([connection()])
    await expect(contexts[0].account.refresh(0, async () => ({ token: 'changed', host: 'forbidden' }))).rejects.toThrow(/secret/)
    expect(values.get('account-a/token')).toBe('initial')
    expect((await contexts[0].account.refresh(0, async () => ({ token: 'valid' }))).secrets.token).toBe('valid')
  })
})

it('refuses multi-key refresh before any credential is written', async () => {
  const { manager, contexts, type, values } = setup()
  // A malformed runtime type must not bypass the one-bundle exchange guard.
  type.fields.push({ key: 'refreshToken', label: 'Refresh token', secret: true })
  await manager.sync([connection()])
  await expect(contexts[0].account.refresh(0, async () => ({ token: 'partial', refreshToken: 'new-refresh' }))).rejects.toThrow(/bundle/)
  expect(values.get('account-a/token')).toBe('initial')
  expect(values.has('account-a/refreshToken')).toBe(false)
})

it('rejects a multi-service type splitting credentials across several secret items', () => {
  const { type } = setup()
  expect(() => new ConnectionTypeRegistry([{ ...type, fields: [...type.fields, { key: 'refreshToken', label: 'Refresh', secret: true }] }])).toThrow(/bundle/)
})

it('cancels a cooperative in-flight refresh when an account is removed', async () => {
  const { manager, contexts } = setup()
  await manager.sync([connection()])
  const started = deferred<void>()
  let activeRequests = 0
  const refresh = contexts[0].account.refresh(0, async (_credentials, signal) => {
    activeRequests++
    started.resolve()
    return new Promise<Record<string, string>>((_resolve, reject) => signal.addEventListener('abort', () => {
      activeRequests--; reject(new Error('aborted'))
    }, { once: true }))
  })
  const rejected = expect(refresh).rejects.toThrow('aborted')
  await started.promise
  await manager.forget(connection())
  await rejected
  expect(activeRequests).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps the last queued account configuration after overlapping refresh and sync', async () => {
  const { manager, contexts, values, providers } = setup()
  await manager.sync([connection()])
  const gate = deferred<Record<string, string>>()
  const refresh = contexts[0].account.refresh(0, async () => gate.promise)
  const rejected = expect(refresh).rejects.toThrow(/retired/)
  const first = manager.sync([{ ...connection(), fields: { version: 'first' } }])
  const second = manager.sync([{ ...connection(), fields: { version: 'last' } }])
  await Promise.all([first, second])
  gate.resolve({ token: 'obsolete' })
  await rejected
  expect(contexts.at(-1)!.fields.version).toBe('last')
  expect(values.get('account-a/token')).toBe('initial')
  expect(providers.channels()).toEqual(['gmail:account-a', 'google-calendar:account-a'])
  expect(vi.getTimerCount()).toBe(0)
})

it('rejects ambiguous service registrations before any account is created', () => {
  const { type } = setup()
  expect(() => new ConnectionTypeRegistry([{ ...type, services: [] }])).toThrow()
  expect(() => new ConnectionTypeRegistry([{ ...type, createProvider: () => ({ channel: 'bad' }) }])).toThrow()
  expect(() => new ConnectionTypeRegistry([{ ...type, services: [type.services![0], type.services![0]] }])).toThrow()
})
