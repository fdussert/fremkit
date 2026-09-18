import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import { createServer, type Server } from 'node:http'
import { proxyRoutes, MAX_BODY_BYTES } from '../src/proxy/routes.js'
import { WidgetCatalog } from '../src/widgets/catalog.js'
import { ManifestSchema } from '../src/widgets/manifest.js'
import { BYTES_CSP, isByteRoute } from '../src/http/headers.js'

let upstream: Server
let port: number

beforeAll(async () => {
  upstream = createServer((req, res) => {
    if (req.url?.startsWith('/redirect-out')) {
      res.writeHead(302, { 'location': 'http://example.invalid/' })
      res.end()
      return
    }
    if (req.url?.startsWith('/redirect-in')) {
      res.writeHead(302, { 'location': '/x?y=2' })
      res.end()
      return
    }
    // A remote server claiming its answer is a document, which the proxy must not repeat.
    if (req.url?.startsWith('/html')) {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end('<script>fetch("/api/config")</script>')
      return
    }
    if (req.url?.startsWith('/huge')) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ pad: 'x'.repeat(MAX_BODY_BYTES + 1024) }))
      return
    }
    if (req.url?.startsWith('/huge-unstated')) {
      res.setHeader('content-type', 'application/json')
      res.setHeader('transfer-encoding', 'chunked')
      res.write('[')
      res.write('"x",'.repeat(Math.ceil(MAX_BODY_BYTES / 4) + 16))
      res.end('"y"]')
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ path: req.url, method: req.method }))
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  port = (upstream.address() as { port: number }).port
})
afterAll(() => upstream.close())

/**
 * The upstream has to live on loopback, which is exactly what the proxy refuses in production.
 * `isPrivate` stands in for the resolution step so the rest of the route can be exercised; the
 * real check is covered by its own tests and by the two cases below that leave it in place.
 */
function app(network: string[], opts: { real?: boolean } = {}) {
  const catalog = new WidgetCatalog('/nonexistent')
  const manifest = ManifestSchema.parse({ id: 'weather', name: 'W', version: '1', minSize: [4, 2], defaultSize: [4, 2], permissions: { network: ['api.example.com'] } })
  // Written past the schema on purpose: a manifest could not declare a private host (see below).
  manifest.permissions.network = network
  catalog.manifests.set('weather', manifest)
  const f = Fastify()
  f.register(proxyRoutes, { catalog, ...(opts.real ? {} : { isPrivate: async () => false }) })
  return f
}

const at = (path: string) => `/api/proxy/weather?url=${encodeURIComponent(`http://127.0.0.1:${port}${path}`)}`

describe('proxy', () => {
  it('forwards a GET to an allowed host', async () => {
    const res = await app(['127.0.0.1']).inject({ url: at('/x?y=1') })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.json()).toEqual({ path: '/x?y=1', method: 'GET' })
  })
  it('refuses a host not in the allowlist', async () => {
    const res = await app(['api.example.com']).inject({ url: at('/') })
    expect(res.statusCode).toBe(403)
  })
  it('refuses unknown widget, missing url, bad url and non-http scheme', async () => {
    const a = app(['127.0.0.1'])
    expect((await a.inject({ url: `/api/proxy/ghost?url=${encodeURIComponent('http://127.0.0.1/')}` })).statusCode).toBe(404)
    expect((await a.inject({ url: `/api/proxy/weather` })).statusCode).toBe(400)
    expect((await a.inject({ url: `/api/proxy/weather?url=nope` })).statusCode).toBe(400)
    expect((await a.inject({ url: `/api/proxy/weather?url=${encodeURIComponent('file:///etc/passwd')}` })).statusCode).toBe(400)
  })
  it('refuses non-GET', async () => {
    const res = await app(['127.0.0.1']).inject({ method: 'POST', url: at('/') })
    expect(res.statusCode).toBe(404)
  })
  it('redirect to a host outside the allowlist → 403', async () => {
    const res = await app(['127.0.0.1']).inject({ url: at('/redirect-out') })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ error: expect.stringContaining('redirection vers un hôte non autorisé') })
  })
  it('redirect to the same allowed host → 200 with body', async () => {
    const res = await app(['127.0.0.1']).inject({ url: at('/redirect-in') })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ path: '/x?y=2', method: 'GET' })
  })
})

describe('proxy hardening', () => {
  it('never repeats the upstream content type', async () => {
    const res = await app(['127.0.0.1']).inject({ url: at('/html') })
    expect(res.statusCode).toBe(200)
    // The bytes still arrive — a widget may want them — but not as a document.
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(res.body).toContain('<script>')
  })

  it('is one of the routes the global sandbox headers cover', async () => {
    expect(isByteRoute('/api/proxy/weather?url=https://example.com/')).toBe(true)
    expect(BYTES_CSP).toContain('sandbox')
  })

  it('refuses an answer past the cap, declared or not', async () => {
    for (const path of ['/huge', '/huge-unstated']) {
      const res = await app(['127.0.0.1']).inject({ url: at(path) })
      expect(res.statusCode, path).toBe(502)
      expect(res.json().error, path).toMatch(/trop volumineuse/)
    }
  })

  it('refuses a private host even when the manifest names it', async () => {
    // The real check, no stand-in: the upstream is on loopback, which is what it exists to stop.
    const res = await app(['127.0.0.1'], { real: true }).inject({ url: at('/x') })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toMatch(/hôte privé ou local/)
  })

  it('refuses loopback written as an IPv4-mapped IPv6 address', async () => {
    // `new URL()` canonicalises `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, and the hex form used
    // to read as a public address — so a manifest naming it proxied any local service.
    for (const host of ['[::ffff:7f00:1]', '[::ffff:127.0.0.1]', '[::7f00:1]', '[::1]',
      '[0:0:0:0:0:ffff:7f00:1]']) {
      const url = `http://${host}:${port}/x`
      const res = await app([new URL(url).hostname], { real: true })
        .inject({ url: `/api/proxy/weather?url=${encodeURIComponent(url)}` })
      expect(res.statusCode, host).toBe(403)
      expect(res.json().error, host).toMatch(/hôte privé ou local/)
    }
  })

  it('says nothing about why the upstream failed', async () => {
    const res = await app(['127.0.0.1']).inject({
      url: `/api/proxy/weather?url=${encodeURIComponent('http://127.0.0.1:1/secret-path?key=hunter2')}`,
    })
    expect(res.statusCode).toBe(502)
    expect(res.body).not.toContain('hunter2')
    expect(res.body).not.toContain('secret-path')
    expect(res.json().error).toBe('le serveur distant n’a pas répondu')
  })
})

describe('permissions.network in a manifest', () => {
  const parse = (network: string[]) =>
    ManifestSchema.safeParse({ id: 'w', name: 'W', version: '1', minSize: [4, 2], defaultSize: [4, 2], permissions: { network } })

  it('refuses a private or local address', async () => {
    for (const host of ['127.0.0.1', '0.0.0.0', '10.1.2.3', '192.168.1.1',
      '172.16.0.1', '169.254.169.254', '[::1]', 'fe80::1', 'fd00::1']) {
      expect(parse([host]).success, host).toBe(false)
    }
  })
  it('accepts the public hosts the widgets here declare', async () => {
    for (const host of ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'example.com', '198.51.100.7']) {
      expect(parse([host]).success, host).toBe(true)
    }
  })
})
