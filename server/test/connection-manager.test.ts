import { describe, expect, it } from 'vitest'
import { ConnectionManager } from '../src/connections/manager.js'
import { ConnectionTypeRegistry } from '../src/connections/registry.js'
import type { ConnectionType } from '../src/connections/types.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import { FileSecretStore } from '../src/secrets/file.js'
import type { SecretStore } from '../src/secrets/types.js'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const built: { channel: string; token: string; org: string }[] = []
/** The writers handed to the last provider built, so a test can call them late on purpose. */
let lastWriters: { save?: (k: string, v: string) => Promise<void>; forget?: (k: string) => Promise<void> } = {}

const fakeType: ConnectionType = {
  id: 'azure-devops',
  name: 'Azure DevOps',
  description: '',
  icon: 'layout-grid',
  fields: [
    { key: 'organization', label: 'Organisation', required: true },
    { key: 'pat', label: 'Jeton', secret: true, required: true },
  ],
  test: async () => ({ ok: true, detail: 'ok' }),
  createProvider: (ctx) => {
    built.push({ channel: ctx.channel, token: ctx.secrets.pat ?? '', org: ctx.fields.organization ?? '' })
    lastWriters = { save: ctx.saveSecret, forget: ctx.forgetSecret }
    return { channel: ctx.channel, intervalMs: 1000, poll: async () => ({ org: ctx.fields.organization }) }
  },
}

async function makeManager() {
  built.length = 0
  const providers = new ProviderRegistry(() => {})
  const secrets = new FileSecretStore(join(await mkdtemp(join(tmpdir(), 'fremkit-cm-')), 'secrets.json'))
  const manager = new ConnectionManager({ registry: providers, types: new ConnectionTypeRegistry([fakeType]), secrets })
  return { providers, secrets, manager }
}

const conn = (fields: Record<string, string>) => ({ id: 'ado-x1z9', type: 'azure-devops', name: 'Travail', fields })

describe('ConnectionManager', () => {
  it('registers one provider per connection on the <type>:<id> channel', async () => {
    const { providers, secrets, manager } = await makeManager()
    await secrets.set('ado-x1z9/pat', 'token-1')
    await manager.sync([conn({ organization: 'example-org' })])
    expect(providers.channels()).toEqual(['azure-devops:ado-x1z9'])
    expect(built).toEqual([{ channel: 'azure-devops:ado-x1z9', token: 'token-1', org: 'example-org' }])
  })

  it('leaves an unchanged connection alone', async () => {
    const { manager, secrets } = await makeManager()
    await secrets.set('ado-x1z9/pat', 'token-1')
    await manager.sync([conn({ organization: 'example-org' })])
    await manager.sync([conn({ organization: 'example-org' })])
    expect(built).toHaveLength(1)
  })

  it('rebuilds the provider when a field changes', async () => {
    const { manager, secrets } = await makeManager()
    await secrets.set('ado-x1z9/pat', 'token-1')
    await manager.sync([conn({ organization: 'example-org' })])
    await manager.sync([conn({ organization: 'other-org' })])
    expect(built).toHaveLength(2)
    expect(built[1].org).toBe('other-org')
  })

  it('rebuilds the provider when only the secret changes', async () => {
    const { manager, secrets } = await makeManager()
    await secrets.set('ado-x1z9/pat', 'token-1')
    await manager.sync([conn({ organization: 'example-org' })])
    await secrets.set('ado-x1z9/pat', 'token-2')
    await manager.sync([conn({ organization: 'example-org' })])
    expect(built).toHaveLength(2)
    expect(built[1].token).toBe('token-2')
  })

  it('unregisters the provider of a connection that disappeared', async () => {
    const { providers, manager, secrets } = await makeManager()
    await secrets.set('ado-x1z9/pat', 'token-1')
    await manager.sync([conn({ organization: 'example-org' })])
    await manager.sync([])
    expect(providers.channels()).toEqual([])
  })

  it('ignores a connection whose type is unknown', async () => {
    const { providers, manager } = await makeManager()
    await manager.sync([{ id: 'nope-1', type: 'not-a-type', name: 'x', fields: {} }])
    expect(providers.channels()).toEqual([])
  })

  it('serializes overlapping syncs, so the last caller wins', async () => {
    built.length = 0
    const providers = new ProviderRegistry(() => {})
    // A store whose reads are slow enough to interleave: without the queue the first sync would
    // finish last and register the provider it built from the OLD secret.
    const values = new Map<string, string>([['ado-x1z9/pat', 'token-1']])
    let reads = 0
    let firstReadStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => { firstReadStarted = resolve })
    const slow: SecretStore = {
      get: async (key) => {
        reads += 1
        // The value as it stood when the read began, like a keychain lookup already in flight.
        const value = values.get(key) ?? null
        if (reads === 1) {
          firstReadStarted()
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        return value
      },
      set: async (key, value) => { values.set(key, value) },
      delete: async (key) => { values.delete(key) },
    }
    const manager = new ConnectionManager({ registry: providers, types: new ConnectionTypeRegistry([fakeType]), secrets: slow })

    const first = manager.sync([conn({ organization: 'example-org' })])
    await started
    // The route writes the new PAT while the first sync is still reading the old one.
    values.set('ado-x1z9/pat', 'token-2')
    const second = manager.sync([conn({ organization: 'example-org' })])
    await Promise.all([first, second])

    expect(built.map((b) => b.token)).toEqual(['token-1', 'token-2'])
    expect(built[built.length - 1].token).toBe('token-2')
  })

  it('forgets every secret of a connection', async () => {
    const { manager, secrets } = await makeManager()
    await secrets.set('ado-x1z9/pat', 'token-1')
    await manager.forget(conn({ organization: 'example-org' }))
    expect(await secrets.get('ado-x1z9/pat')).toBeNull()
  })
})

describe('a provider writing its own secrets', () => {
  it('writes and forgets under its own connection, and only its type\'s keys', async () => {
    const { secrets, manager } = await makeManager()
    await secrets.set('ado-x1z9/pat', 'token-1')
    await manager.sync([conn({ organization: 'example-org' })])

    await lastWriters.save!('pat', 'token-2')
    expect(await secrets.get('ado-x1z9/pat')).toBe('token-2')
    // A key the type does not declare as a secret is not this provider's to write.
    await lastWriters.save!('organization', 'somewhere-else')
    expect(await secrets.get('ado-x1z9/organization')).toBeNull()
    await lastWriters.forget!('pat')
    expect(await secrets.get('ado-x1z9/pat')).toBeNull()
  })

  it('ignores a write from a generation that has been replaced', async () => {
    // A poll can still be in flight when the connection is rebuilt. A token obtained from the
    // *old* host must not land under the new one — which is exactly what a Synology device
    // token would be.
    const { secrets, manager } = await makeManager()
    await secrets.set('ado-x1z9/pat', 'token-1')
    await manager.sync([conn({ organization: 'first-org' })])
    const stale = lastWriters.save!

    await secrets.set('ado-x1z9/pat', 'token-2')
    await manager.sync([conn({ organization: 'second-org' })])
    expect(built).toHaveLength(2)

    await stale('pat', 'from-the-old-host')
    expect(await secrets.get('ado-x1z9/pat')).toBe('token-2')
    // The current generation still writes.
    await lastWriters.save!('pat', 'token-3')
    expect(await secrets.get('ado-x1z9/pat')).toBe('token-3')
  })

  it('ignores a write from a provider whose connection was forgotten', async () => {
    const { secrets, manager } = await makeManager()
    await secrets.set('ado-x1z9/pat', 'token-1')
    const connection = conn({ organization: 'example-org' })
    await manager.sync([connection])
    const stale = lastWriters.save!
    await manager.forget(connection)
    await stale('pat', 'resurrected')
    expect(await secrets.get('ado-x1z9/pat')).toBeNull()
  })

  it('ignores a write from a provider the sync dropped', async () => {
    const { secrets, manager } = await makeManager()
    await secrets.set('ado-x1z9/pat', 'token-1')
    await manager.sync([conn({ organization: 'example-org' })])
    const stale = lastWriters.save!
    await manager.sync([])
    await stale('pat', 'resurrected')
    expect(await secrets.get('ado-x1z9/pat')).toBe('token-1')
  })
})
