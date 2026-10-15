import Fastify from 'fastify'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ConfigStore } from '../src/config/store.js'
import { WidgetCatalog } from '../src/widgets/catalog.js'
import { connectionRoutes } from '../src/connections/routes.js'
import { ConnectionManager } from '../src/connections/manager.js'
import { ConnectionTypeRegistry } from '../src/connections/registry.js'
import type { ConnectionType } from '../src/connections/types.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import type { SecretStore } from '../src/secrets/types.js'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn() })
async function setup(failRollback = false, pause?: { entered: () => void; wait: Promise<void> }) {
  const dir = await mkdtemp(join(tmpdir(), 'fremkit-credential-recovery-'))
  const file = join(dir, 'fremkit.json')
  const store = new ConfigStore(file); await store.load()
  const connection = { id: 'account-a', type: 'test-account', name: 'Account', fields: { host: 'old.example.com' } }
  await store.update((cfg) => ({ ...cfg, connections: [connection] }))
  const values = new Map([['account-a/first', 'old-first'], ['account-a/second', 'old-second']])
  const secrets: SecretStore = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      if (value === 'new-second' || (failRollback && value === 'old-first')) throw new Error('store unavailable')
      values.set(key, value)
      if (value === 'new-first' && pause) { pause.entered(); await pause.wait }
    },
    delete: async (key) => { values.delete(key) },
  }
  const type: ConnectionType = {
    id: 'test-account', name: 'Account', description: '', icon: 'mail', secretBindings: ['host'],
    fields: [{ key: 'host', label: 'Host' }, { key: 'first', label: 'First', secret: true }, { key: 'second', label: 'Second', secret: true }],
    test: async () => ({ ok: true, detail: 'ok' }),
    createProvider: (ctx) => ({ channel: ctx.channel, commands: { read: async () => ({ host: ctx.fields.host, ...ctx.secrets }) } }),
  }
  const types = new ConnectionTypeRegistry([type])
  const registry = new ProviderRegistry(() => {})
  const manager = new ConnectionManager({ types, registry, secrets })
  await manager.sync([connection])
  store.onChange((cfg) => { void manager.sync(cfg.connections) })
  const app = Fastify()
  await app.register(connectionRoutes, { types, manager, secrets, store, catalog: new WidgetCatalog(join(dir, 'widgets')) })
  cleanup.push(async () => { await app.close(); registry.stop() })
  const put = () => app.inject({ method: 'PUT', url: '/api/connections/account-a', payload: { type: 'test-account', fields: { host: 'new.example.com' }, secrets: { first: 'new-first', second: 'new-second' } } })
  const restart = async (fromBackup = false) => {
    if (fromBackup) await writeFile(file, 'interrupted config')
    const reloaded = new ConfigStore(file); await reloaded.load()
    const providers = new ProviderRegistry(() => {})
    const fresh = new ConnectionManager({ types, registry: providers, secrets })
    await fresh.sync(reloaded.get().connections)
    return { reloaded, providers }
  }
  return { put, restart }
}

it('restores the previous binding and secrets after a failed form batch, including after restart', async () => {
  const { put, restart } = await setup()
  expect((await put()).statusCode).toBe(500)
  const { providers } = await restart()
  expect(await providers.runCommand('test-account:account-a', 'read', null)).toEqual({ host: 'old.example.com', first: 'old-first', second: 'old-second' })
})

it('keeps an account durably absent when secret rollback fails', async () => {
  const { put, restart } = await setup(true)
  expect((await put()).statusCode).toBe(500)
  const { reloaded, providers } = await restart()
  expect(reloaded.get().connections).toEqual([])
  expect(providers.channels()).toEqual([])
})

it('cannot reconstruct providers from an interrupted batch before its rollback runs', async () => {
  let entered!: () => void; let release!: () => void
  const started = new Promise<void>((r) => { entered = r })
  const wait = new Promise<void>((r) => { release = r })
  const { put, restart } = await setup(false, { entered, wait })
  const request = put(); void request.then(() => {})
  await started
  try {
    const { reloaded, providers } = await restart()
    expect(reloaded.get().connections).toEqual([])
    expect(providers.channels()).toEqual([])
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fallback = await restart(true)
      expect(fallback.reloaded.get().connections).toEqual([])
      expect(fallback.providers.channels()).toEqual([])
    } finally { quiet.mockRestore() }
  } finally { release(); await request }
})
