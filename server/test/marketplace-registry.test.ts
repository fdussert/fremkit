import { describe, expect, it } from 'vitest'
import { MAX_INDEX_BYTES, Registry, RegistryError, releaseOf } from '../src/marketplace/registry.js'
import type { RegistryIndex } from '../src/marketplace/index-schema.js'

const HOST = 'registry.example.com'
const URL_ = `https://${HOST}/index.json`
const HASH = 'a'.repeat(64)

function widget(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'demo', version: '1.0.0', sdk: 1, name: 'Demo', description: 'D', icon: 'layout-grid',
    permissions: { subscriptions: [], commands: [], network: [] }, connections: [],
    size: 100, sha256: HASH, url: `https://${HOST}/widgets/demo-1.0.0.zip`,
    publishedAt: '2026-09-18T12:00:00.000Z', previous: [],
    ...over,
  }
}

function index(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { registry: 'fremkit-sietch', generatedAt: '2026-09-18T12:00:00.000Z', schema: 1, widgets: [widget()], ...over }
}

/** A `fetch` that answers one body, and counts how often it was called. */
function serve(body: string | Buffer, init: { status?: number } = {}) {
  const calls: string[] = []
  const f = async (url: string): Promise<Response> => {
    calls.push(url)
    return new Response(typeof body === 'string' ? body : new Uint8Array(body), { status: init.status ?? 200 })
  }
  return { calls, fetch: f as never }
}

const PUBLIC = async (): Promise<boolean> => false

function make(body: string | Buffer, init: { status?: number; now?: () => number } = {}) {
  const served = serve(body, init)
  const registry = new Registry({ url: URL_, fetch: served.fetch, isPrivate: PUBLIC, now: init.now })
  return { registry, calls: served.calls }
}

describe('Registry.index', () => {
  it('reads and validates the index', async () => {
    const { registry } = make(JSON.stringify(index()))
    const read = await registry.index()
    expect(read.registry).toBe('fremkit-sietch')
    expect(read.widgets[0].id).toBe('demo')
  })

  it('caches it, and refreshes only when asked or when it is stale', async () => {
    let clock = 0
    const { registry, calls } = make(JSON.stringify(index()), { now: () => clock })
    await registry.index()
    await registry.index()
    expect(calls.length).toBe(1)
    await registry.index(true)
    expect(calls.length).toBe(2)
    clock += 25 * 60 * 60 * 1000
    await registry.index()
    expect(calls.length).toBe(3)
  })

  it('keeps the last index when a refresh fails, rather than reading as "all withdrawn"', async () => {
    let fail = false
    const registry = new Registry({
      url: URL_, isPrivate: PUBLIC,
      fetch: (async () => {
        if (fail) throw new Error('offline')
        return new Response(JSON.stringify(index()))
      }) as never,
    })
    await registry.index()
    fail = true
    expect((await registry.index(true)).widgets[0].id).toBe('demo')
    expect(registry.last).not.toBeNull()
  })

  it('refuses an index of the wrong schema version', async () => {
    const { registry } = make(JSON.stringify(index({ schema: 2 })))
    await expect(registry.index()).rejects.toThrow(RegistryError)
  })

  it('refuses an index that is not JSON, and one that does not validate', async () => {
    await expect(make('{ not json').registry.index()).rejects.toThrow(RegistryError)
    await expect(make(JSON.stringify(index({ widgets: [widget({ sha256: 'nope' })] }))).registry.index()).rejects.toThrow(RegistryError)
  })

  it('refuses an index naming a URL on another host', async () => {
    // The whole point of one registry: it publishes files, it does not name other servers.
    const off = index({ widgets: [widget({ url: 'https://evil.example.net/demo.zip' })] })
    await expect(make(JSON.stringify(off)).registry.index()).rejects.toThrow(RegistryError)
    const offPrevious = index({ widgets: [widget({ previous: [{ version: '0.9.0', url: 'https://evil.example.net/a.zip', sha256: HASH, size: 10 }] })] })
    await expect(make(JSON.stringify(offPrevious)).registry.index()).rejects.toThrow(RegistryError)
  })

  it('refuses a redirect rather than following one nothing checked', async () => {
    const { registry } = make('', { status: 302 })
    await expect(registry.index()).rejects.toThrow(RegistryError)
  })

  it('stops reading an index bigger than the ceiling', async () => {
    const huge = '['.repeat(MAX_INDEX_BYTES + 10)
    await expect(make(huge).registry.index()).rejects.toMatchObject({ key: 'marketplace.tooLarge' })
  })

  it('refuses a registry host that resolves to a private address', async () => {
    const registry = new Registry({ url: URL_, isPrivate: async () => true, fetch: (async () => new Response('{}')) as never })
    await expect(registry.index()).rejects.toThrow(RegistryError)
  })

  it('makes one request when several callers ask at once', async () => {
    let calls = 0
    const registry = new Registry({
      url: URL_, isPrivate: PUBLIC,
      fetch: (async () => { calls++; return new Response(JSON.stringify(index())) }) as never,
    })
    await Promise.all([registry.index(), registry.index(), registry.index()])
    expect(calls).toBe(1)
  })
})

describe('Registry.download', () => {
  it('refuses a URL off the registry host, and one over the ceiling', async () => {
    const { registry } = make(Buffer.from('zip'))
    await expect(registry.download({ url: 'https://evil.example.net/a.zip', sha256: HASH, size: 3 })).rejects.toThrow(RegistryError)
    await expect(registry.download({ url: `https://${HOST}/a.zip`, sha256: HASH, size: 99 * 1024 * 1024 })).rejects.toThrow(RegistryError)
  })

  it('reads the bytes for a URL on the registry host', async () => {
    const { registry } = make(Buffer.from('zip-bytes'))
    const bytes = await registry.download({ url: `https://${HOST}/widgets/demo-1.0.0.zip`, sha256: HASH, size: 9 })
    expect(bytes.toString()).toBe('zip-bytes')
  })

  it('stops at the size the index declared, so a lying length cannot fill the disk', async () => {
    const { registry } = make(Buffer.alloc(5000))
    await expect(registry.download({ url: `https://${HOST}/a.zip`, sha256: HASH, size: 10 })).rejects.toThrow(RegistryError)
  })
})

describe('releaseOf', () => {
  const entry = { ...widget({ previous: [{ version: '0.9.0', url: `https://${HOST}/widgets/demo-0.9.0.zip`, sha256: HASH, size: 90 }] }) } as unknown as RegistryIndex['widgets'][number]

  it('answers the current release when no version is named', () => {
    expect(releaseOf(entry)?.version).toBe('1.0.0')
    expect(releaseOf(entry, '1.0.0')?.version).toBe('1.0.0')
  })
  it('answers an older one that is still downloadable, and nothing for one that is not', () => {
    expect(releaseOf(entry, '0.9.0')?.size).toBe(90)
    expect(releaseOf(entry, '0.8.0')).toBeUndefined()
  })
})
