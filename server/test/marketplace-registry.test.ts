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

  it('keeps the last index when a background read fails, rather than reading as "all withdrawn"', async () => {
    let clock = 0
    let fail = false
    const registry = new Registry({
      url: URL_, isPrivate: PUBLIC, now: () => clock,
      fetch: (async () => {
        if (fail) throw new Error('offline')
        return new Response(JSON.stringify(index()))
      }) as never,
    })
    await registry.index()
    fail = true
    // Stale, so this one really does go out — and falls back to what it had.
    clock += 25 * 60 * 60 * 1000
    expect((await registry.index()).widgets[0].id).toBe('demo')
    expect(registry.last).not.toBeNull()
  })

  it('throws on a forced read instead of handing back the index it already had', async () => {
    // `force` is what `POST /api/marketplace/refresh` is made of. Answering "all fine" with a
    // cached index would say the registry was read when nothing was.
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
    await expect(registry.index(true)).rejects.toThrow(RegistryError)
    // And what it last knew is still there for the listing to fall back on.
    expect(registry.last?.widgets[0].id).toBe('demo')
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

describe('the development override', () => {
  const LOCAL = 'http://127.0.0.1:8080/index.json'

  function localIndex(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      registry: 'fremkit-sietch', generatedAt: '2026-09-18T12:00:00.000Z', schema: 1,
      widgets: [widget({ url: 'http://127.0.0.1:8080/widgets/demo-1.0.0.zip', ...over })],
    }
  }

  /** A private address, answered honestly — which is what the production rules refuse. */
  const PRIVATE = async (): Promise<boolean> => true

  it('refuses a local registry by default', async () => {
    const registry = new Registry({
      url: LOCAL, isPrivate: PRIVATE,
      fetch: (async () => new Response(JSON.stringify(localIndex()))) as never,
    })
    await expect(registry.index()).rejects.toMatchObject({ key: 'marketplace.badUrl' })
  })

  it('accepts one under dev, http and loopback included', async () => {
    const registry = new Registry({
      url: LOCAL, dev: true, isPrivate: PRIVATE,
      fetch: (async () => new Response(JSON.stringify(localIndex()))) as never,
    })
    const read = await registry.index()
    expect(read.widgets[0].url).toBe('http://127.0.0.1:8080/widgets/demo-1.0.0.zip')
  })

  it('still refuses a package URL on another host under dev', async () => {
    const registry = new Registry({
      url: LOCAL, dev: true, isPrivate: PRIVATE,
      fetch: (async () => new Response(JSON.stringify(localIndex({ url: 'http://evil.example.net/demo.zip' })))) as never,
    })
    await expect(registry.index()).rejects.toMatchObject({ key: 'marketplace.badUrl' })
  })

  it('still refuses a download on another host, and one over the ceiling, under dev', async () => {
    const registry = new Registry({
      url: LOCAL, dev: true, isPrivate: PRIVATE,
      fetch: (async () => new Response(new Uint8Array(Buffer.from('zip')))) as never,
    })
    await expect(registry.download({ url: 'http://evil.example.net/a.zip', sha256: HASH, size: 3 }))
      .rejects.toMatchObject({ key: 'marketplace.badUrl' })
    await expect(registry.download({ url: 'http://127.0.0.1:8080/a.zip', sha256: HASH, size: 99 * 1024 * 1024 }))
      .rejects.toMatchObject({ key: 'marketplace.tooLarge' })
  })

  it('refuses an https package URL from an http dev registry: one scheme, not a mixed case', async () => {
    const registry = new Registry({
      url: LOCAL, dev: true, isPrivate: PRIVATE,
      fetch: (async () => new Response(JSON.stringify(localIndex({ url: 'https://127.0.0.1:8080/demo.zip' })))) as never,
    })
    await expect(registry.index()).rejects.toMatchObject({ key: 'marketplace.badUrl' })
  })

  it('still refuses a redirect under dev', async () => {
    const registry = new Registry({
      url: LOCAL, dev: true, isPrivate: PRIVATE,
      fetch: (async () => new Response('', { status: 302 })) as never,
    })
    await expect(registry.index()).rejects.toMatchObject({ key: 'marketplace.unreachable' })
  })
})

describe('the category of an entry', () => {
  it('reads what the registry published', async () => {
    const { registry } = make(JSON.stringify(index({ widgets: [widget({ category: 'home' })] })))
    expect((await registry.index()).widgets[0].category).toBe('home')
  })

  it('reads an index published before categories reached it as `other`', async () => {
    // The key is simply absent there, and refusing the whole index over it would take every
    // widget out of the admin for the sake of a shelf label.
    const { registry } = make(JSON.stringify(index()))
    expect((await registry.index()).widgets[0].category).toBe('other')
  })

  it('files a category this build does not know under `other`', async () => {
    // A registry running ahead of this Fremkit: the widget belongs on a shelf that exists here
    // rather than taking the index down, which is the rule the manifest schema already applies.
    const { registry } = make(JSON.stringify(index({ widgets: [widget({ category: 'quantum' })] })))
    expect((await registry.index()).widgets[0].category).toBe('other')
  })
})

describe('themes in the index', () => {
  const theme = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'nuit', version: '1.0.0',
    name: { fr: 'Nuit', en: 'Night' }, description: { fr: 'Sombre', en: 'Dark' },
    tokens: { accent: '#d9b36a', bg: '#0b0d10', surface: '#151a21', text: '#e6e8eb' },
    size: 400, sha256: HASH, url: `https://${HOST}/themes/nuit-1.0.0.zip`,
    publishedAt: '2026-09-18T12:00:00.000Z', previous: [],
    ...over,
  })

  it('defaults to an empty list, so an index without the key still reads', async () => {
    const { registry } = make(JSON.stringify(index()))
    expect((await registry.index()).themes).toEqual([])
  })

  it('reads a theme entry beside the widgets', async () => {
    const { registry } = make(JSON.stringify(index({ themes: [theme()] })))
    const read = await registry.index()
    expect(read.widgets[0].id).toBe('demo')
    expect(read.themes[0].tokens.accent).toBe('#d9b36a')
  })

  it('holds a theme URL to the registry host like a widget\'s', async () => {
    const off = index({ themes: [theme({ url: 'https://evil.example.net/nuit.zip' })] })
    await expect(make(JSON.stringify(off)).registry.index()).rejects.toMatchObject({ key: 'marketplace.badUrl' })
    const offPrevious = index({ themes: [theme({ previous: [{ version: '0.9.0', url: 'https://evil.example.net/a.zip', sha256: HASH, size: 10 }] })] })
    await expect(make(JSON.stringify(offPrevious)).registry.index()).rejects.toMatchObject({ key: 'marketplace.badUrl' })
  })

  it('refuses a theme entry that does not validate, rather than dropping it', async () => {
    // An index is accepted whole or not at all: a half-read one would have the admin show a
    // registry that is quietly missing things.
    for (const over of [{ tokens: { accent: '#fff' } }, { version: 'latest' }, { sha256: 'nope' }]) {
      const bad = index({ themes: [theme(over)] })
      await expect(make(JSON.stringify(bad)).registry.index(), JSON.stringify(over)).rejects.toThrow(RegistryError)
    }
  })

  it('refuses a token that is not the shape of a colour', async () => {
    // The four go into a `style` attribute on a card; a value that could close the attribute
    // must not get as far as being rendered and escaped.
    const bad = index({ themes: [theme({ tokens: { accent: '#fff;" onload="x', bg: '#000', surface: '#111', text: '#eee' } })] })
    await expect(make(JSON.stringify(bad)).registry.index()).rejects.toThrow(RegistryError)
    // A function is still a colour: this refuses a shape, not an expression.
    const ok = index({ themes: [theme({ tokens: { accent: 'color-mix(in oklab, #fff 40%, #000)', bg: '#000', surface: '#111', text: '#eee' } })] })
    await expect(make(JSON.stringify(ok)).registry.index()).resolves.toBeTruthy()
  })

  it('does not move the schema version for the new key', async () => {
    const { registry } = make(JSON.stringify(index({ themes: [theme()] })))
    expect((await registry.index()).schema).toBe(1)
  })
})
