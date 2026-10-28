import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyBaseLogger } from 'fastify'
import { applyConfig } from '../src/backup/apply.js'
import { ConfigStore } from '../src/config/store.js'
import { ConnectionTypeRegistry } from '../src/connections/registry.js'
import { defaultConnectionTypes } from '../src/connections/types/index.js'
import type { SecretStore } from '../src/secrets/index.js'

const log = { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} } as unknown as FastifyBaseLogger

let dir: string | undefined
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

describe('applyConfig when the save fails', () => {
  it('puts back the secrets it dropped: the config in force still names those connections', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-apply-'))
    const store = new ConfigStore(join(dir, 'fremkit.json'))
    await store.load()
    await store.save({ ...store.get(), connections: [
      { id: 'gh-x1z9', type: 'github', name: 'Work', fields: { host: '' } },
      { id: 'gh-old1', type: 'github', name: 'Old', fields: { host: '' } },
    ] })
    const values = new Map([['gh-x1z9/token', 'issued for the old host'], ['gh-old1/token', 'kept too']])
    const secrets: SecretStore = {
      get: async (key) => values.get(key) ?? null,
      set: async (key, value) => { values.set(key, value) },
      delete: async (key) => { values.delete(key) },
    }
    const before = store.get()
    vi.spyOn(store, 'save').mockRejectedValue(Object.assign(new Error('rename failed'), { code: 'EPERM' }))
    // The incoming config moves one connection to another host and drops the other.
    const incoming = structuredClone(before)
    incoming.connections = [{ id: 'gh-x1z9', type: 'github', name: 'Work', fields: { host: 'https://198.51.100.9' } }]
    const result = await applyConfig({ store, types: new ConnectionTypeRegistry(defaultConnectionTypes()), secrets }, incoming, {}, log)
    expect(result).toEqual({ ok: false, failure: 'invalid' })
    expect(store.get()).toBe(before)
    expect(Object.fromEntries(values)).toEqual({ 'gh-x1z9/token': 'issued for the old host', 'gh-old1/token': 'kept too' })
  })
})
