import Fastify from 'fastify'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ConfigStore } from '../src/config/store.js'
import { WidgetCatalog } from '../src/widgets/catalog.js'
import { connectionRoutes } from '../src/connections/routes.js'
import { ConnectionManager } from '../src/connections/manager.js'
import { ConnectionTypeRegistry } from '../src/connections/registry.js'
import type { ConnectionType, ConnectionProviderContext } from '../src/connections/types.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import type { SecretStore } from '../src/secrets/types.js'

it('a PUT waits for an old provider write, then replaces its credentials without late overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fremkit-service-routes-'))
  const store = new ConfigStore(join(dir, 'fremkit.json')); await store.load()
  const connection = { id: 'account-a', type: 'test-account', name: 'Account', fields: {} }
  await store.update((cfg) => ({ ...cfg, connections: [connection] }))
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  let started!: () => void
  const entered = new Promise<void>((r) => { started = r })
  const values = new Map([['account-a/token', 'initial']])
  const secrets: SecretStore = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => { if (value === 'old-provider') { started(); await gate }; values.set(key, value) },
    delete: async (key) => { values.delete(key) },
  }
  let context!: ConnectionProviderContext
  const type: ConnectionType = {
    id: 'test-account', name: 'Account', description: '', icon: 'mail', fields: [{ key: 'token', label: 'Token', secret: true }],
    test: async () => ({ ok: true, detail: 'ok' }),
    createProvider: (ctx) => { context = ctx; return { channel: ctx.channel } },
  }
  const types = new ConnectionTypeRegistry([type])
  const registry = new ProviderRegistry(() => {})
  const manager = new ConnectionManager({ types, registry, secrets })
  await manager.sync([connection])
  const app = Fastify()
  await app.register(connectionRoutes, { types, manager, secrets, store, catalog: new WidgetCatalog(join(dir, 'widgets')) })
  try {
    const pending = context.saveSecret!('token', 'old-provider')
    await entered
    const request = app.inject({ method: 'PUT', url: '/api/connections/account-a', payload: { type: 'test-account', fields: {}, secrets: { token: 'user-replacement' } } })
    void request.then(() => {})
    // Allow the route to queue its transaction behind the already-started provider write.
    await new Promise((r) => setTimeout(r, 10))
    release()
    await pending
    expect((await request).statusCode).toBe(200)
    expect(values.get('account-a/token')).toBe('user-replacement')
  } finally { await app.close(); registry.stop() }
})

it('never starts a provider with newly saved fields and the previous credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fremkit-service-config-'))
  const store = new ConfigStore(join(dir, 'fremkit.json')); await store.load()
  const connection = { id: 'account-a', type: 'test-account', name: 'Account', fields: { host: 'old.example.com' } }
  await store.update((cfg) => ({ ...cfg, connections: [connection] }))
  const values = new Map([['account-a/token', 'initial']])
  const secrets: SecretStore = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value) },
    delete: async (key) => { values.delete(key) },
  }
  const starts: string[] = []
  const type: ConnectionType = {
    id: 'test-account', name: 'Account', description: '', icon: 'mail',
    fields: [{ key: 'host', label: 'Host' }, { key: 'token', label: 'Token', secret: true }], secretBindings: ['host'],
    test: async () => ({ ok: true, detail: 'ok' }),
    createProvider: (ctx) => ({ channel: ctx.channel, start: () => { starts.push(ctx.fields.host + '/' + ctx.secrets.token) } }),
  }
  const types = new ConnectionTypeRegistry([type])
  const registry = new ProviderRegistry(() => {})
  const manager = new ConnectionManager({ types, registry, secrets })
  await manager.sync([connection]); registry.addSubscriber('test-account:account-a')
  store.onChange((cfg) => { void manager.sync(cfg.connections) })
  const app = Fastify()
  await app.register(connectionRoutes, { types, manager, secrets, store, catalog: new WidgetCatalog(join(dir, 'widgets')) })
  try {
    const response = await app.inject({ method: 'PUT', url: '/api/connections/account-a', payload: { type: 'test-account', fields: { host: 'new.example.com' }, secrets: { token: 'replacement' } } })
    expect(response.statusCode).toBe(200)
    expect(starts).toEqual(['old.example.com/initial', 'new.example.com/replacement'])
  } finally { await app.close(); registry.stop() }
})

for (const phase of ['before quarantine', 'during quarantine']) {
  it(`serializes DELETE after a PUT paused ${phase}, without resurrecting the account`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fremkit-service-delete-'))
    const file = join(dir, 'fremkit.json')
    const store = new ConfigStore(file); await store.load()
    const connection = { id: 'account-a', type: 'test-account', name: 'Account', fields: {} }
    await store.update((cfg) => ({ ...cfg, connections: [connection] }))
    let release!: () => void; let entered!: () => void
    const wait = new Promise<void>((r) => { release = r })
    const started = new Promise<void>((r) => { entered = r })
    let armed = false; let reads = 0
    const values = new Map([['account-a/token', 'initial']])
    const secrets: SecretStore = {
      get: async (key) => {
        if (armed && ++reads === 2 && phase === 'before quarantine') { entered(); await wait }
        return values.get(key) ?? null
      },
      set: async (key, value) => {
        if (value === 'replacement' && phase === 'during quarantine') { entered(); await wait }
        values.set(key, value)
      },
      delete: async (key) => { values.delete(key) },
    }
    const stops: string[] = []
    const type: ConnectionType = {
      id: 'test-account', name: 'Account', description: '', icon: 'mail',
      fields: [{ key: 'token', label: 'Token', secret: true }],
      test: async () => ({ ok: true, detail: 'ok' }),
      services: ['gmail', 'google-calendar'].map((id) => ({ id, channelPrefix: id,
        createProvider: (ctx) => ({ channel: ctx.channel, start: () => {}, stop: () => { stops.push(ctx.channel) } }),
      })),
    }
    const types = new ConnectionTypeRegistry([type])
    const registry = new ProviderRegistry(() => {})
    const manager = new ConnectionManager({ types, registry, secrets })
    await manager.sync([connection]); registry.addSubscriber('gmail:account-a')
    store.onChange((cfg) => { void manager.sync(cfg.connections) })
    const app = Fastify()
    await app.register(connectionRoutes, { types, manager, secrets, store, catalog: new WidgetCatalog(join(dir, 'widgets')) })
    try {
      armed = true
      const put = app.inject({ method: 'PUT', url: '/api/connections/account-a', payload: { type: 'test-account', secrets: { token: 'replacement' } } })
      void put.then(() => {})
      await started
      const remove = app.inject({ method: 'DELETE', url: '/api/connections/account-a' })
      void remove.then(() => {})
      await new Promise<void>((r) => setImmediate(r))
      release()
      expect((await put).statusCode).toBe(200)
      expect((await remove).statusCode).toBe(204)
      expect(store.get().connections).toEqual([])
      expect(values.size).toBe(0)
      expect(registry.channels()).toEqual([])
      expect(stops).toContain('gmail:account-a')
      const restarted = new ConfigStore(file); await restarted.load()
      const freshRegistry = new ProviderRegistry(() => {})
      await new ConnectionManager({ types, registry: freshRegistry, secrets }).sync(restarted.get().connections)
      expect(restarted.get().connections).toEqual([])
      expect(freshRegistry.channels()).toEqual([])
      freshRegistry.stop()
    } finally { release(); await app.close(); registry.stop() }
  })
}
