import { describe, expect, it, vi } from 'vitest'
import { boundSecretsToReveal, buildSecretsPayload, createConnectionsStore } from '../src/admin/connections'
import type { ConnectionSummary, ConnectionTypeInfo } from '../src/shared/types'

const TYPES: ConnectionTypeInfo[] = [
  { id: 'azure-devops', name: 'Azure DevOps', description: '', icon: 'layout-grid', fields: [
    { key: 'organization', label: 'Organisation', required: true },
    { key: 'pat', label: 'Jeton', secret: true, required: true },
  ] },
  { id: 'bambu', name: 'Bambu Lab', description: '', icon: 'hard-drive', fields: [] },
]

const CONNECTIONS: ConnectionSummary[] = [
  { id: 'ado-x1z9', type: 'azure-devops', name: 'Travail', fields: { organization: 'example-org' }, secrets: { pat: true } },
  { id: 'bambu-a1b2', type: 'bambu', name: 'Imprimante', fields: {}, secrets: {} },
]

function fakeApi(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getConnectionTypes: vi.fn(async () => TYPES),
    getConnections: vi.fn(async () => CONNECTIONS),
    putConnection: vi.fn(async () => CONNECTIONS[0]),
    deleteConnection: vi.fn(async () => undefined),
    testConnection: vi.fn(async () => ({ ok: true as const, detail: 'Connexion établie' })),
    shareConnection: vi.fn(async () => ({ ok: true })),
    ...overrides,
  }
}

describe('connections store', () => {
  it('loads the types and the connections', async () => {
    const store = createConnectionsStore({ api: fakeApi() })
    await store.load()
    expect(store.state.types.map((t) => t.id)).toEqual(['azure-devops', 'bambu'])
    expect(store.state.connections).toHaveLength(2)
    expect(store.state.loaded).toBe(true)
  })

  it('filters by type for the connection setting drop-down', async () => {
    const store = createConnectionsStore({ api: fakeApi() })
    await store.load()
    expect(store.ofType('azure-devops').map((c) => c.id)).toEqual(['ado-x1z9'])
    expect(store.ofType('nope')).toEqual([])
  })

  it('suggests an unused id built from the type', async () => {
    const store = createConnectionsStore({ api: fakeApi(), uid: () => 'k3m1' })
    await store.load()
    expect(store.suggestId('azure-devops')).toBe('azure-devops-k3m1')
    // A declared type's id carries colons, which a connection id may not.
    expect(store.suggestId('decl:homey-flows:homey-flows')).toBe('homey-flows-k3m1')
  })

  it('reloads after a save and keeps the error message of a failed one', async () => {
    const api = fakeApi({ putConnection: vi.fn(async () => { throw new Error('le champ « Projet » est obligatoire') }) })
    const store = createConnectionsStore({ api })
    await store.load()
    await expect(store.save('ado-x1z9', { type: 'azure-devops', name: 'Travail', fields: {} })).rejects.toThrow('Projet')
    expect(api.getConnections).toHaveBeenCalledTimes(1)
    await store.save('ado-x1z9', { type: 'azure-devops', name: 'Travail', fields: {} }).catch(() => {})
    expect(store.state.error).toContain('Projet')
  })

  it('reloads after a successful save and after a delete', async () => {
    const api = fakeApi()
    const store = createConnectionsStore({ api })
    await store.load()
    await store.save('ado-x1z9', { type: 'azure-devops', name: 'Travail', fields: { organization: 'example-org' } })
    expect(api.getConnections).toHaveBeenCalledTimes(2)
    await store.remove('ado-x1z9')
    expect(api.getConnections).toHaveBeenCalledTimes(3)
  })

  it('surfaces the 409 of a connection still in use', async () => {
    const api = fakeApi({ deleteConnection: vi.fn(async () => { throw new Error('Connexion utilisée par : ado-pipelines (page « Accueil »)') }) })
    const store = createConnectionsStore({ api })
    await store.load()
    await expect(store.remove('ado-x1z9')).rejects.toThrow('Connexion utilisée')
    expect(store.state.error).toContain('ado-pipelines')
  })

  it('clears a previous error when the next call succeeds', async () => {
    const putConnection = vi.fn(async (): Promise<ConnectionSummary> => { throw new Error('le champ « Projet » est obligatoire') })
    const api = fakeApi({ putConnection })
    const store = createConnectionsStore({ api })
    await store.load()
    await store.save('ado-x1z9', { type: 'azure-devops', name: 'Travail', fields: {} }).catch(() => {})
    expect(store.state.error).not.toBe('')
    putConnection.mockImplementation(async () => CONNECTIONS[0])
    await store.save('ado-x1z9', { type: 'azure-devops', name: 'Travail', fields: {} })
    expect(store.state.error).toBe('')
    expect(store.state.busy).toBe(false)
  })

  it('clears the error on demand', async () => {
    const api = fakeApi({ deleteConnection: vi.fn(async () => { throw new Error('Connexion utilisée par : ado-pipelines') }) })
    const store = createConnectionsStore({ api })
    await store.load()
    await store.remove('ado-x1z9').catch(() => {})
    expect(store.state.error).not.toBe('')
    store.clearError()
    expect(store.state.error).toBe('')
  })

  it('never suggests an id an existing connection already uses', async () => {
    const ids = ['x1z9', 'x1z9', 'k3m1']
    const store = createConnectionsStore({ api: fakeApi(), uid: () => ids.shift() ?? 'zzzz' })
    await store.load()
    expect(store.suggestId('ado')).toBe('ado-k3m1')
  })
})

describe('buildSecretsPayload', () => {
  it('leaves an untouched secret out, so the server keeps the stored one', () => {
    expect(buildSecretsPayload({}, {})).toEqual({})
    expect(buildSecretsPayload({ pat: 'ghp_x' }, { pat: false })).toEqual({})
  })

  it('sends a secret the user typed in', () => {
    expect(buildSecretsPayload({ pat: 'ghp_x' }, { pat: true })).toEqual({ pat: 'ghp_x' })
  })

  it('sends an empty string for a secret that was typed in and then emptied', () => {
    expect(buildSecretsPayload({ pat: '' }, { pat: true })).toEqual({ pat: '' })
  })

  it('leaves a revealed but untyped secret out', () => {
    // « Modifier » shows an empty input and writes '' into the values map; until the user types,
    // the key is not touched and must not reach the server as a deletion.
    expect(buildSecretsPayload({ pat: '' }, {})).toEqual({})
  })

  it('sends only the touched keys of a multi-secret type', () => {
    const values = { pat: 'ghp_x', password: '', token: 'kept' }
    expect(buildSecretsPayload(values, { pat: true, password: true, token: false })).toEqual({ pat: 'ghp_x', password: '' })
  })
})

describe('boundSecretsToReveal', () => {
  const type: ConnectionTypeInfo = {
    id: 'bambu', name: 'Bambu', description: '', icon: 'printer',
    secretBindings: ['host', 'serial'],
    fields: [
      { key: 'host', label: 'Host' },
      { key: 'serial', label: 'Serial' },
      { key: 'model', label: 'Model' },
      { key: 'accessCode', label: 'Access code', secret: true },
    ],
  }
  const stored: ConnectionSummary = {
    id: 'bambu-x1', type: 'bambu', name: 'Printer',
    fields: { host: '192.0.2.10', serial: 'PRINTER-1', model: 'X1C' },
    secrets: { accessCode: true },
  }

  it('offers the stored secret again when a bound field moves', () => {
    expect(boundSecretsToReveal(type, stored, 'host', '198.51.100.7')).toEqual(['accessCode'])
    expect(boundSecretsToReveal(type, stored, 'serial', 'PRINTER-2')).toEqual(['accessCode'])
  })
  it('stays quiet when the bound field is put back, or was never bound', () => {
    expect(boundSecretsToReveal(type, stored, 'host', '192.0.2.10')).toEqual([])
    expect(boundSecretsToReveal(type, stored, 'model', 'P1S')).toEqual([])
  })
  it('has nothing to offer on a new connection, or when no secret is stored', () => {
    expect(boundSecretsToReveal(type, null, 'host', '198.51.100.7')).toEqual([])
    expect(boundSecretsToReveal(type, { ...stored, secrets: {} }, 'host', '198.51.100.7')).toEqual([])
  })
  it('does nothing for a type that binds nothing', () => {
    expect(boundSecretsToReveal({ ...type, secretBindings: [] }, stored, 'host', '198.51.100.7')).toEqual([])
    expect(boundSecretsToReveal({ ...type, secretBindings: undefined }, stored, 'host', '198.51.100.7')).toEqual([])
  })
})
