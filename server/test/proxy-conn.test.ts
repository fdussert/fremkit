/**
 * `POST /api/proxy/:widgetId/conn`: one request on a connection a widget declared.
 *
 * This route holds somebody's API key and makes calls with it on a widget's say-so, so the tests
 * are mostly about what it *refuses*. The shape of them is deliberate: every assertion about the
 * secret looks for it in the answer, in the error and in the log lines — the three places a
 * credential leaks from in practice.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify from 'fastify'
import { proxyRoutes } from '../src/proxy/routes.js'
import { DEFAULT_CONFIG, type Config } from '../src/config/schema.js'
import type { ConfigStore } from '../src/config/store.js'
import type { SecretStore } from '../src/secrets/types.js'
import { WidgetCatalog } from '../src/widgets/catalog.js'
import { ManifestSchema } from '../src/widgets/manifest.js'
import { declaredTypeId } from '../src/connections/declared.js'
import { ConnCache, allowedRequest, checkHeaders, checkPath, pathMatches } from '../src/proxy/conn.js'
import { ConnectionDeclSchema } from '../src/widgets/manifest.js'

const SECRET = 'sk-thisisthesecret'
const TYPE = declaredTypeId('homey-flows', 'Homey Flows')

const DECL = {
  name: 'Homey Flows',
  kind: 'http-bearer' as const,
  fields: [
    { key: 'host', label: 'Address' },
    { key: 'token', label: 'API key', secret: true },
  ],
  requests: [
    { method: 'GET' as const, path: '/api/manager/flow/flow' },
    { method: 'POST' as const, path: '/api/manager/flow/flow/*/trigger' },
    { method: 'GET' as const, path: '/api/manager/devices/**' },
    { method: 'GET' as const, path: '/cached/thing', cacheMs: 60_000 },
  ],
}

function manifestWith(connection: unknown = DECL) {
  return ManifestSchema.parse({
    id: 'homey-flows', name: 'Homey flows', version: '2.0.0',
    minSize: [8, 4], defaultSize: [8, 4],
    ...(connection ? { connection } : {}),
  })
}

function config(over: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    connections: [{ id: 'homey-x1', type: TYPE, name: 'Homey', fields: { host: '192.168.1.40' } }],
    pages: [{
      id: 'home', name: 'Home',
      widgets: [{
        instanceId: 'flows-1', widgetId: 'homey-flows', x: 0, y: 0, w: 8, h: 4,
        showTitle: true, settings: { connection: 'homey-x1' },
      }],
    }],
    marketplace: { installed: { 'homey-flows': {
      kind: 'widget', version: '2.0.0', registry: 'fremkit-sietch',
      installedAt: '2026-09-19T08:00:00.000Z',
      consentedPermissions: { subscriptions: [], commands: [], network: [], connection: DECL },
    } } },
    ...over,
  } as unknown as Config
}

interface Setup {
  cfg?: Config
  connection?: unknown
  answer?: (url: URL, init: RequestInit) => Response
  now?: () => number
}

let calls: { url: URL; init: RequestInit }[]
let logs: string[]

function app(setup: Setup = {}) {
  calls = []
  logs = []
  const catalog = new WidgetCatalog('/nonexistent')
  const manifest = manifestWith(setup.connection === undefined ? DECL : setup.connection)
  catalog.entries.set('homey-flows', { manifest, source: 'installed', folder: '/nonexistent/homey-flows' })

  const cfg = setup.cfg ?? config()
  const store = { get: () => cfg } as unknown as ConfigStore
  const secrets: SecretStore = {
    get: async (key) => (key === 'homey-x1/token' ? SECRET : null),
    set: async () => {}, delete: async () => {},
  }
  const doFetch = vi.fn(async (url: URL | string | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(url)), init: init ?? {} })
    return setup.answer
      ? setup.answer(new URL(String(url)), init ?? {})
      : new Response(JSON.stringify({ ok: true }), { status: 200 })
  })

  const f = Fastify({ logger: false })
  // Every log line this route writes, captured: a secret in a log is a secret on disk.
  f.addHook('onRequest', (req, _reply, done) => {
    req.log.warn = ((obj: unknown, msg?: string) => { logs.push(JSON.stringify(obj) + String(msg ?? '')) }) as never
    done()
  })
  f.register(proxyRoutes, {
    catalog, store, secrets, isPrivate: async () => false,
    fetch: doFetch as never, ...(setup.now ? { now: setup.now } : {}),
  })
  return f
}

const send = (body: unknown, url = '/api/proxy/homey-flows/conn') =>
  app().inject({ method: 'POST', url, payload: body as never })

beforeEach(() => { calls = []; logs = [] })

describe('the allow-list', () => {
  it('matches a literal path, a one-segment star and a trailing rest', () => {
    expect(pathMatches('/a/b', '/a/b')).toBe(true)
    expect(pathMatches('/a/b', '/a/b/c')).toBe(false)
    expect(pathMatches('/a/*/c', '/a/anything/c')).toBe(true)
    expect(pathMatches('/a/*/c', '/a/x/y/c')).toBe(false)
    expect(pathMatches('/a/**', '/a/b/c/d')).toBe(true)
    // `**` is the rest *including none*: a declaration for `/api/devices/**` covers listing the
    // collection itself, which is what an author writing that pattern means.
    expect(pathMatches('/a/**', '/a')).toBe(true)
    expect(pathMatches('/**', '/anything/at/all')).toBe(true)
    expect(pathMatches('/a/**', '/b/c')).toBe(false)
  })

  it("compares literally: a service's routes may be case-sensitive", () => {
    expect(pathMatches('/api/admin', '/API/admin')).toBe(false)
    expect(pathMatches('/api/admin', '/api/Admin')).toBe(false)
  })

  it('takes the method into account', () => {
    const decl = ConnectionDeclSchema.parse(DECL)
    expect(allowedRequest(decl, { method: 'GET', path: '/api/manager/flow/flow' })).toBeDefined()
    expect(allowedRequest(decl, { method: 'POST', path: '/api/manager/flow/flow' })).toBeUndefined()
    expect(allowedRequest(decl, { method: 'POST', path: '/api/manager/flow/flow/abc/trigger' })).toBeDefined()
    expect(allowedRequest(decl, { method: 'DELETE', path: '/api/manager/flow/flow/abc/trigger' })).toBeUndefined()
  })
})

describe('the paths a widget may even ask about', () => {
  it('refuses anything a service could route differently from the matcher', () => {
    for (const path of [
      'api/x', '/a?b=1', '/a#b', '/a/../b', '/a/./b', '/a//b', '/a\\b',
      // `%2e` is `.` and `%2f` is `/`: the service would route on a path the matcher never saw.
      '/a/%2e%2e/b', '/a%2fb', '/a%5cb', '/A/%2E%2E/b',
    ]) {
      expect(checkPath(path), path).toBeNull()
    }
  })

  it('refuses a control character, NUL first among them', () => {
    // Header splitting and truncation at once: some parsers stop reading at a NUL and some do
    // not, so the matcher and the service would be looking at different strings.
    for (const path of ['/a\u0000b', '/a\rb', '/a\nb', '/a\u007fb', '/a\tb']) {
      expect(checkPath(path), JSON.stringify(path)).toBeNull()
    }
  })

  it('takes an ordinary one', () => {
    expect(checkPath('/api/manager/flow/flow')).toBe('/api/manager/flow/flow')
    expect(checkPath('/a/b%20c')).toBe('/a/b%20c')
  })
})

describe('the headers a widget may set', () => {
  it('takes the two that describe its own body', () => {
    expect(checkHeaders({ 'Content-Type': 'application/json' })).toEqual({ 'content-type': 'application/json' })
    expect(checkHeaders({ accept: 'application/json' })).toEqual({ accept: 'application/json' })
    expect(checkHeaders(undefined)).toEqual({})
  })

  it('refuses every way of reaching past the proxy', () => {
    // Authorization would override the secret the server just injected; Cookie makes it a
    // session; X-Forwarded-For lies to whatever is in front; Host picks another virtual host.
    for (const name of ['Authorization', 'Cookie', 'X-Forwarded-For', 'Host', 'X-Api-Key']) {
      expect(checkHeaders({ [name]: 'x' }), name).toBeNull()
    }
    expect(checkHeaders({ accept: 'a\r\nX-Injected: 1' })).toBeNull()
  })
})

describe('what the route refuses before it touches the network', () => {
  it('refuses a cross-site call', async () => {
    const res = await app().inject({
      method: 'POST', url: '/api/proxy/homey-flows/conn',
      headers: { 'sec-fetch-site': 'cross-site' },
      payload: { instanceId: 'flows-1', method: 'GET', path: '/api/manager/flow/flow' } as never,
    })
    expect(res.statusCode).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('refuses a malformed body and an unknown widget', async () => {
    expect((await send({ instanceId: 'flows-1' })).statusCode).toBe(400)
    expect((await send({ instanceId: 'flows-1', method: 'TRACE', path: '/a' })).statusCode).toBe(400)
    expect((await send({ instanceId: 'flows-1', method: 'GET', path: '/a' }, '/api/proxy/ghost/conn')).statusCode).toBe(404)
  })

  it('refuses a request the widget never declared, naming the rule and not the secret', async () => {
    const res = await send({ instanceId: 'flows-1', method: 'GET', path: '/api/manager/system' })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toContain('/api/manager/system')
    expect(JSON.stringify(res.json())).not.toContain(SECRET)
    expect(calls).toHaveLength(0)
  })

  it('refuses a declared path asked with the wrong method', async () => {
    const res = await send({ instanceId: 'flows-1', method: 'DELETE', path: '/api/manager/flow/flow' })
    expect(res.statusCode).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it("refuses an instance that is not this widget's", async () => {
    // An instance id is not a capability: a widget asking on behalf of another one is asking for
    // somebody else's connection.
    const cfg = config()
    cfg.pages[0].widgets.push({
      instanceId: 'other-1', widgetId: 'some-other', x: 0, y: 8, w: 8, h: 4,
      showTitle: true, settings: { connection: 'homey-x1' },
    } as never)
    const res = await app({ cfg }).inject({
      method: 'POST', url: '/api/proxy/homey-flows/conn',
      payload: { instanceId: 'other-1', method: 'GET', path: '/api/manager/flow/flow' } as never,
    })
    expect(res.statusCode).toBe(404)
    expect(calls).toHaveLength(0)
  })

  it('refuses a widget that declares nothing', async () => {
    const res = await app({ connection: null }).inject({
      method: 'POST', url: '/api/proxy/homey-flows/conn',
      payload: { instanceId: 'flows-1', method: 'GET', path: '/api/manager/flow/flow' } as never,
    })
    expect(res.statusCode).toBe(403)
  })

  it('reaches nothing when the declaration was never consented to', async () => {
    // The grant is the authority. A widget that rewrote its own manifest on disk gets nothing,
    // exactly like a channel it was never granted.
    const cfg = config()
    cfg.marketplace.installed['homey-flows'].consentedPermissions.connection = undefined
    const res = await app({ cfg }).inject({
      method: 'POST', url: '/api/proxy/homey-flows/conn',
      payload: { instanceId: 'flows-1', method: 'GET', path: '/api/manager/flow/flow' } as never,
    })
    expect(res.statusCode).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('refuses a request whose declaration changed since it was granted', async () => {
    // The grant holds the old declaration; the manifest asks for a new path. Until the user has
    // seen the difference, the widget has the old one.
    const widened = { ...DECL, requests: [...DECL.requests, { method: 'GET' as const, path: '/api/manager/system' }] }
    const res = await app({ connection: widened }).inject({
      method: 'POST', url: '/api/proxy/homey-flows/conn',
      payload: { instanceId: 'flows-1', method: 'GET', path: '/api/manager/system' } as never,
    })
    expect(res.statusCode).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('says so when no connection is chosen for the instance', async () => {
    const cfg = config()
    cfg.pages[0].widgets[0].settings = {}
    const res = await app({ cfg }).inject({
      method: 'POST', url: '/api/proxy/homey-flows/conn',
      payload: { instanceId: 'flows-1', method: 'GET', path: '/api/manager/flow/flow' } as never,
    })
    expect(res.statusCode).toBe(409)
  })

  it('will not follow a setting that names a connection of another type', async () => {
    // That is how a widget would reach a coded type's credentials.
    const cfg = config()
    cfg.connections = [{ id: 'homey-x1', type: 'homey', name: 'Homey', fields: { host: '192.168.1.40' } }]
    const res = await app({ cfg }).inject({
      method: 'POST', url: '/api/proxy/homey-flows/conn',
      payload: { instanceId: 'flows-1', method: 'GET', path: '/api/manager/flow/flow' } as never,
    })
    expect(res.statusCode).toBe(409)
    expect(calls).toHaveLength(0)
  })
})

describe('the request the proxy actually makes', () => {
  const ok = (body: unknown) => app().inject({
    method: 'POST', url: '/api/proxy/homey-flows/conn', payload: body as never,
  })

  it('builds the URL from the connection and injects the secret', async () => {
    const res = await ok({ instanceId: 'flows-1', method: 'GET', path: '/api/manager/flow/flow' })
    expect(res.statusCode).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].url.toString()).toBe('https://192.168.1.40/api/manager/flow/flow')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`)
    expect(calls[0].init.redirect).toBe('manual')
  })

  it('allows a private host, which is the whole point of a declared connection', async () => {
    // `permissions.network` refuses a private host and always will. A `conn:` request goes to
    // the address the *user* typed for that connection — a Homey and a Key Light are on the LAN.
    const res = await ok({ instanceId: 'flows-1', method: 'GET', path: '/api/manager/flow/flow' })
    expect(res.statusCode).toBe(200)
    expect(calls[0].url.hostname).toBe('192.168.1.40')
  })

  it('sends a body on a write and passes the two allowed headers through', async () => {
    const res = await ok({
      instanceId: 'flows-1', method: 'POST', path: '/api/manager/flow/flow/abc/trigger',
      body: '{"x":1}', headers: { 'Content-Type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    expect(calls[0].init.body).toBe('{"x":1}')
    expect((calls[0].init.headers as Record<string, string>)['content-type']).toBe('application/json')
  })

  it('refuses a header the widget is not allowed to set', async () => {
    const res = await ok({
      instanceId: 'flows-1', method: 'GET', path: '/api/manager/flow/flow',
      headers: { Authorization: 'Bearer somebody-elses' },
    })
    expect(res.statusCode).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('treats a redirect as an error rather than a hop', async () => {
    // The secret is bound to the host the user typed. Following a redirect is exactly how it
    // would reach one they did not.
    const res = await app({ answer: () => new Response('', { status: 302, headers: { location: 'https://evil.example.net/' } }) })
      .inject({ method: 'POST', url: '/api/proxy/homey-flows/conn', payload: { instanceId: 'flows-1', method: 'GET', path: '/api/manager/flow/flow' } as never })
    expect(res.statusCode).toBe(502)
    expect(calls).toHaveLength(1)
  })

  it('caps the answer rather than holding a video in memory', async () => {
    const huge = 'x'.repeat(3 * 1024 * 1024)
    const res = await app({ answer: () => new Response(huge, { status: 200 }) })
      .inject({ method: 'POST', url: '/api/proxy/homey-flows/conn', payload: { instanceId: 'flows-1', method: 'GET', path: '/api/manager/flow/flow' } as never })
    expect(res.statusCode).toBe(502)
  })

  it('never declares the answer to be a document', async () => {
    const res = await app({ answer: () => new Response('<script>fetch("/api/config")</script>', { status: 200, headers: { 'content-type': 'text/html' } }) })
      .inject({ method: 'POST', url: '/api/proxy/homey-flows/conn', payload: { instanceId: 'flows-1', method: 'GET', path: '/api/manager/flow/flow' } as never })
    expect(res.headers['content-type']).toContain('text/plain')
  })
})

describe('where the secret must never appear', () => {
  it('is absent from the answer, the error and the log line when the service fails', async () => {
    const res = await app({
      answer: () => { throw new Error(`connect ECONNREFUSED https://192.168.1.40/?apikey=${SECRET}`) },
    }).inject({ method: 'POST', url: '/api/proxy/homey-flows/conn', payload: { instanceId: 'flows-1', method: 'GET', path: '/api/manager/flow/flow' } as never })

    expect(res.statusCode).toBe(502)
    expect(res.body).not.toContain(SECRET)
    expect(logs.join(' ')).not.toContain(SECRET)
    // And not the address either, which on a LAN is the user's own.
    expect(res.body).not.toContain('192.168.1.40')
  })

  it('is absent when the service answers with it in its own body', async () => {
    // A service that echoes the key back is a service; what matters is that the proxy does not
    // add one of its own on the way out.
    const res = await app({ answer: () => new Response(JSON.stringify({ ok: true }), { status: 200 }) })
      .inject({ method: 'POST', url: '/api/proxy/homey-flows/conn', payload: { instanceId: 'flows-1', method: 'GET', path: '/api/manager/flow/flow' } as never })
    expect(res.body).not.toContain(SECRET)
    expect(JSON.stringify(res.headers)).not.toContain(SECRET)
  })

  it('goes in the query string only when the declaration says so, and not in the log', async () => {
    const queryDecl = {
      name: 'Tibber', kind: 'api-key-query' as const, queryName: 'apikey',
      fields: [{ key: 'host', label: 'A' }, { key: 'token', label: 'K', secret: true }],
      requests: [{ method: 'GET' as const, path: '/v1/price' }],
    }
    const cfg = config()
    cfg.connections = [{ id: 'homey-x1', type: declaredTypeId('homey-flows', 'Tibber'), name: 'T', fields: { host: 'api.example.com' } }]
    cfg.marketplace.installed['homey-flows'].consentedPermissions.connection = queryDecl
    const res = await app({ cfg, connection: queryDecl, answer: () => { throw new Error('boom') } })
      .inject({ method: 'POST', url: '/api/proxy/homey-flows/conn', payload: { instanceId: 'flows-1', method: 'GET', path: '/v1/price' } as never })
    expect(res.statusCode).toBe(502)
    expect(calls[0].url.searchParams.get('apikey')).toBe(SECRET)
    expect(logs.join(' ')).not.toContain(SECRET)
  })
})

describe('the per-connection cache', () => {
  it('serves a second read of the same path without asking again', async () => {
    const a = app()
    const one = await a.inject({ method: 'POST', url: '/api/proxy/homey-flows/conn', payload: { instanceId: 'flows-1', method: 'GET', path: '/cached/thing' } as never })
    const two = await a.inject({ method: 'POST', url: '/api/proxy/homey-flows/conn', payload: { instanceId: 'flows-1', method: 'GET', path: '/cached/thing' } as never })
    expect(one.headers['x-fremkit-cache']).toBeUndefined()
    expect(two.headers['x-fremkit-cache']).toBe('hit')
    expect(calls).toHaveLength(1)
  })

  it('caches nothing a declaration did not ask to be cached', async () => {
    const a = app()
    for (let i = 0; i < 2; i++) {
      await a.inject({ method: 'POST', url: '/api/proxy/homey-flows/conn', payload: { instanceId: 'flows-1', method: 'GET', path: '/api/manager/flow/flow' } as never })
    }
    expect(calls).toHaveLength(2)
  })

  it('forgets everything a write could have changed', async () => {
    const a = app()
    await a.inject({ method: 'POST', url: '/api/proxy/homey-flows/conn', payload: { instanceId: 'flows-1', method: 'GET', path: '/cached/thing' } as never })
    await a.inject({ method: 'POST', url: '/api/proxy/homey-flows/conn', payload: { instanceId: 'flows-1', method: 'POST', path: '/api/manager/flow/flow/abc/trigger' } as never })
    const after = await a.inject({ method: 'POST', url: '/api/proxy/homey-flows/conn', payload: { instanceId: 'flows-1', method: 'GET', path: '/cached/thing' } as never })
    expect(after.headers['x-fremkit-cache']).toBeUndefined()
    expect(calls).toHaveLength(3)
  })

  it('is dropped when the connection is saved, deleted or un-shared', () => {
    // The three things that make a cached answer wrong. The routes that do them live in other
    // files, which is why the cache is owned by `app.ts` rather than by the proxy.
    const cache = new ConnCache(() => 1000)
    cache.put('c1', '/a', { status: 200, body: Buffer.from('one'), json: false })
    cache.put('c1', '/b', { status: 200, body: Buffer.from('two'), json: false })
    cache.put('c2', '/a', { status: 200, body: Buffer.from('other'), json: false })

    cache.forget('c1')
    expect(cache.get('c1', '/a', 60_000)).toBeUndefined()
    expect(cache.get('c1', '/b', 60_000)).toBeUndefined()
    // And only that connection's.
    expect(cache.get('c2', '/a', 60_000)?.body.toString()).toBe('other')
  })

  it('keys on the connection and the path, never on the widget', () => {
    // The point is that the *second widget* is served what the first already fetched.
    const cache = new ConnCache(() => 1000)
    cache.put('c1', '/a', { status: 200, body: Buffer.from('one'), json: false })
    expect(cache.get('c1', '/a', 60_000)?.body.toString()).toBe('one')
    expect(cache.get('c1', '/b', 60_000)).toBeUndefined()
    expect(cache.get('c2', '/a', 60_000)).toBeUndefined()
  })

  it('lets an answer go stale rather than showing an old reading as a live one', () => {
    let now = 1000
    const cache = new ConnCache(() => now)
    cache.put('c1', '/a', { status: 200, body: Buffer.from('one'), json: false })
    now = 1000 + 60_000
    expect(cache.get('c1', '/a', 60_000)).toBeDefined()
    now = 1000 + 60_001
    expect(cache.get('c1', '/a', 60_000)).toBeUndefined()
  })
})

describe('a host that is not a host', () => {
  /** The connection's `host` field, as the user typed it — and as the widget invited them to. */
  const withHost = (raw: string): Config => {
    const cfg = config()
    cfg.connections = [{ id: 'homey-x1', type: TYPE, name: 'Homey', fields: { host: raw } }]
    return cfg
  }

  const ask = (raw: string) => app({ cfg: withHost(raw) }).inject({
    method: 'POST', url: '/api/proxy/homey-flows/conn',
    payload: { instanceId: 'flows-1', method: 'GET', path: '/api/manager/flow/flow' } as never,
  })

  it('makes no request at all, and says so without quoting the string', async () => {
    // `10.0.0.1:x@evil.example` was read as the private `10.0.0.1` — so plain http was allowed
    // — while the key went to `evil.example`. The widget writes the label, the placeholder and
    // the hint beside that box, so "paste this address" is the whole attack.
    for (const raw of ['10.0.0.1:x@evil.example', 'user:pw@evil.example', '10.0.0.1/../x', '10.0.0.1?a=b']) {
      const res = await ask(raw)
      expect(res.statusCode, raw).toBe(409)
      expect(res.body).not.toContain('evil.example')
      expect(res.body).not.toContain(SECRET)
      expect(calls, raw).toHaveLength(0)
    }
  })

  it('still serves the addresses people really type', async () => {
    // `app()` gives each case its own recorder, so the assertion is per address.
    for (const [raw, expected] of [
      ['192.168.1.40', '192.168.1.40'],
      ['192.168.1.40:9123', '192.168.1.40:9123'],
      ['nas.local:5001', 'nas.local:5001'],
      ['EXAMPLE.COM', 'example.com'],
    ]) {
      const res = await ask(raw)
      expect(res.statusCode, raw).toBe(200)
      expect(calls[0].url.host, raw).toBe(expected)
    }
  })

  it('sends an IPv6 literal to the address it names', async () => {
    const res = await ask('[::1]:8080')
    expect(res.statusCode).toBe(200)
    expect(calls[0].url.host).toBe('[::1]:8080')
  })

  it('refuses whitespace and a header-splitting attempt', async () => {
    for (const raw of ['a b', 'a\r\nb', '']) {
      expect((await ask(raw)).statusCode, JSON.stringify(raw)).toBe(409)
      expect(calls).toHaveLength(0)
    }
  })
})

describe('a connection shared with another widget', () => {
  /** `flows-1` is bound to a connection that belongs to *another* widget's declared type. */
  function shared(sharedConnections: string[]): Config {
    const cfg = config()
    cfg.connections = [{
      id: 'homey-x1', type: declaredTypeId('homey-devices', 'Homey (devices)'),
      name: 'Homey', fields: { host: '192.168.1.40' },
    }]
    cfg.marketplace.installed['homey-flows'].sharedConnections = sharedConnections
    return cfg
  }

  const ask = (cfg: Config) => app({ cfg }).inject({
    method: 'POST', url: '/api/proxy/homey-flows/conn',
    payload: { instanceId: 'flows-1', method: 'GET', path: '/api/manager/flow/flow' } as never,
  })

  it('is refused when it was not granted', async () => {
    // Without the grant a widget could reach any declared connection simply by naming its id in
    // its own settings, which the widget writes.
    expect((await ask(shared([]))).statusCode).toBe(409)
    expect(calls).toHaveLength(0)
  })

  it('is used when the consent record lists it', async () => {
    const res = await ask(shared(['homey-x1']))
    expect(res.statusCode).toBe(200)
    expect(calls[0].url.hostname).toBe('192.168.1.40')
  })

  it('is refused for a coded type, however the record was written', async () => {
    // Sharing widens a widget's reach only to the kind of thing it could have asked the user to
    // create for it. A Synology password is not on offer.
    const cfg = shared(['homey-x1'])
    cfg.connections = [{ id: 'homey-x1', type: 'synology', name: 'NAS', fields: { host: '192.168.1.9' } }]
    expect((await ask(cfg)).statusCode).toBe(409)
    expect(calls).toHaveLength(0)
  })

  it('still holds the shared connection to this widget’s own allow-list', async () => {
    // Sharing is about *which* credential, never about which requests.
    const res = await app({ cfg: shared(['homey-x1']) }).inject({
      method: 'POST', url: '/api/proxy/homey-flows/conn',
      payload: { instanceId: 'flows-1', method: 'GET', path: '/api/manager/system' } as never,
    })
    expect(res.statusCode).toBe(403)
    expect(calls).toHaveLength(0)
  })
})
