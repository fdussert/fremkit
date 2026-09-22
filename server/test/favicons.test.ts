import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readdir, utimes, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { pickIconHref, largestSize } from '../src/favicons/pick.js'
import { FaviconStore, cacheKey, extensionFor, isFresh, sniffImageType, FAILED_TTL_MS, FAVICON_TTL_MS, MAX_ICON_BYTES, MAX_CACHED_ICONS } from '../src/favicons/store.js'
import { faviconRoutes } from '../src/favicons/routes.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

/** A minimal `fetch` over a table of URL → response description. */
type Route = { status?: number; type?: string; body?: Buffer | string; location?: string; headers?: Record<string, string> }
function fakeFetch(routes: Record<string, Route | (() => Route)>, calls: string[] = []) {
  return async (input: string): Promise<Response> => {
    calls.push(input)
    const entry = routes[input]
    if (!entry) return new Response(null, { status: 404 })
    const route = typeof entry === 'function' ? entry() : entry
    const headers: Record<string, string> = { ...route.headers }
    if (route.type) headers['content-type'] = route.type
    if (route.location) headers['location'] = route.location
    const bytes = route.body === undefined ? null
      : new Uint8Array(Buffer.isBuffer(route.body) ? route.body : Buffer.from(route.body))
    return new Response(route.status && [204, 301, 302, 303, 307, 308].includes(route.status) ? null : bytes,
      { status: route.status ?? 200, headers })
  }
}

/**
 * These tests answer for the network with `fakeFetch`, so the private-address check must not go
 * to the resolver either: every host they name is treated as public unless a test says otherwise.
 */
const PUBLIC = async (): Promise<boolean> => false

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'fremkit-favicons-')) })
afterEach(() => { /* the temp dir is left to the OS, as elsewhere in the suite */ })

describe('pickIconHref', () => {
  it('prefers an apple-touch-icon over a plain icon', () => {
    const html = `<link rel="icon" href="/small.png"><link rel="apple-touch-icon" href="/touch.png">`
    expect(pickIconHref(html, 'https://example.com/a/b')).toBe('https://example.com/touch.png')
  })
  it('picks the largest sizes among equals, first one winning a tie', () => {
    const html = `<link rel="icon" sizes="16x16" href="/a.png"><link rel="icon" sizes="180x180" href="/b.png"><link rel="icon" sizes="32x32" href="/c.png">`
    expect(pickIconHref(html, 'https://example.com/')).toBe('https://example.com/b.png')
    expect(pickIconHref(`<link rel="icon" href="/a.png"><link rel="icon" href="/b.png">`, 'https://example.com/'))
      .toBe('https://example.com/a.png')
  })
  it('accepts "shortcut icon" and reads sizes="any" as the biggest', () => {
    const html = `<link rel="shortcut icon" sizes="512x512" href="/big.png"><link rel="icon" sizes="any" href="/v.webp">`
    expect(pickIconHref(html, 'https://example.com/')).toBe('https://example.com/v.webp')
    expect(largestSize('16x16 32x32')).toBe(32)
    expect(largestSize(null)).toBe(0)
  })
  it('skips an SVG link, by type or by extension, however big it claims to be', () => {
    const byExt = `<link rel="icon" sizes="512x512" href="/big.png"><link rel="icon" sizes="any" href="/v.svg">`
    expect(pickIconHref(byExt, 'https://example.com/')).toBe('https://example.com/big.png')
    const byType = `<link rel="icon" href="/a.png"><link rel="apple-touch-icon" type="image/svg+xml" href="/v">`
    expect(pickIconHref(byType, 'https://example.com/')).toBe('https://example.com/a.png')
    expect(pickIconHref(`<link rel="icon" href="/only.svg">`, 'https://example.com/')).toBeNull()
  })
  it('resolves a relative href against the page URL, and against <base> when there is one', () => {
    expect(pickIconHref(`<link rel="icon" href="icon.png">`, 'https://example.com/a/b/page.html'))
      .toBe('https://example.com/a/b/icon.png')
    expect(pickIconHref(`<base href="https://cdn.example.com/assets/"><link rel="icon" href="icon.png">`, 'https://example.com/a/'))
      .toBe('https://cdn.example.com/assets/icon.png')
  })
  it('ignores links with no icon rel, a non-http scheme, or no href, and returns null when there is none', () => {
    expect(pickIconHref(`<link rel="stylesheet" href="/x.css">`, 'https://example.com/')).toBeNull()
    expect(pickIconHref(`<link rel="icon" href="data:image/png;base64,AA">`, 'https://example.com/')).toBeNull()
    expect(pickIconHref(`<link rel="icon">`, 'https://example.com/')).toBeNull()
    expect(pickIconHref('<html><head></head></html>', 'https://example.com/')).toBeNull()
  })
})

describe('cache key and freshness', () => {
  it('keys on the origin alone, so every page of a site shares one icon', () => {
    const a = cacheKey(new URL('https://example.com/foo/bar?x=1').origin)
    expect(a).toBe(cacheKey(new URL('https://example.com/').origin))
    expect(a).not.toBe(cacheKey(new URL('https://other.example.com/').origin))
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
  it('is fresh for a week', () => {
    const now = 1_000_000_000_000
    expect(isFresh(now - 1000, now)).toBe(true)
    expect(isFresh(now - FAVICON_TTL_MS + 1, now)).toBe(true)
    expect(isFresh(now - FAVICON_TTL_MS - 1, now)).toBe(false)
  })
  it('maps only image content types to an extension', () => {
    expect(extensionFor('image/png; charset=binary')).toBe('png')
    expect(extensionFor('image/vnd.microsoft.icon')).toBe('ico')
    expect(extensionFor('text/html')).toBeNull()
    expect(extensionFor(null)).toBeNull()
  })

  it('accepts a favicon.ico served as application/octet-stream when its bytes are an image', async () => {
    const store = new FaviconStore({ dir, isPrivate: PUBLIC, fetchImpl: fakeFetch({
      'https://example.com/': { type: 'text/html', body: '<html><head></head></html>' },
      'https://example.com/favicon.ico': { type: 'application/octet-stream', body: PNG },
    }) })
    const icon = await store.get('https://example.com')
    expect(icon?.contentType).toBe('image/png')
  })

  it('recognises an icon by its bytes when the site declares no image type', () => {
    const ico = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0])
    expect(sniffImageType(ico)).toBe('image/x-icon')
    expect(sniffImageType(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(12)]))).toBe('image/png')
    // An SVG is a document that can carry script, and the icon would be served from this
    // server's own origin: the bytes of one are not an image we recognise.
    expect(sniffImageType(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(sniffImageType(Buffer.from('<svg onload="fetch(1)" xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(sniffImageType(Buffer.from('<html><body>login</body></html>'))).toBeNull()
    expect(sniffImageType(Buffer.alloc(4))).toBeNull()
  })
})

describe('FaviconStore', () => {
  it('fetches the declared icon and caches it under the origin hash', async () => {
    const calls: string[] = []
    const store = new FaviconStore({ dir, isPrivate: PUBLIC, fetchImpl: fakeFetch({
      'https://example.com/': { type: 'text/html', body: '<link rel="apple-touch-icon" href="/touch.png">' },
      'https://example.com/touch.png': { type: 'image/png', body: PNG },
    }, calls) })
    const icon = await store.get('https://example.com')
    expect(icon?.contentType).toBe('image/png')
    expect(icon?.body.equals(PNG)).toBe(true)
    expect(await readdir(dir)).toEqual([`${cacheKey('https://example.com')}.png`])
    // Second call is served from disk: no new request.
    const before = calls.length
    expect((await store.get('https://example.com'))?.body.equals(PNG)).toBe(true)
    expect(calls.length).toBe(before)
  })

  it('falls back to /favicon.ico at the origin when the page declares nothing', async () => {
    const store = new FaviconStore({ dir, isPrivate: PUBLIC, fetchImpl: fakeFetch({
      'https://example.com/': { type: 'text/html', body: '<html><head><title>x</title></head></html>' },
      'https://example.com/favicon.ico': { type: 'image/x-icon', body: PNG },
    }) })
    expect((await store.get('https://example.com'))?.contentType).toBe('image/x-icon')
  })

  it('refuses a non-image content type', async () => {
    const store = new FaviconStore({ dir, isPrivate: PUBLIC, fetchImpl: fakeFetch({
      'https://example.com/': { type: 'text/html', body: '<link rel="icon" href="/evil.html">' },
      'https://example.com/evil.html': { type: 'text/html', body: '<h1>not an icon</h1>' },
      'https://example.com/favicon.ico': { type: 'text/plain', body: 'nope' },
    }) })
    expect(await store.get('https://example.com')).toBeNull()
    expect(await readdir(dir).catch(() => [])).toEqual([])
  })

  it('refuses an icon past the size cap', async () => {
    const huge = Buffer.alloc(MAX_ICON_BYTES + 10, 1)
    const store = new FaviconStore({ dir, isPrivate: PUBLIC, fetchImpl: fakeFetch({
      'https://example.com/': { type: 'text/html', body: '<link rel="icon" href="/big.png">' },
      'https://example.com/big.png': { type: 'image/png', body: huge },
      'https://example.com/favicon.ico': { status: 404 },
    }) })
    expect(await store.get('https://example.com')).toBeNull()
  })

  it('never follows a redirect that leaves http(s)', async () => {
    const calls: string[] = []
    const store = new FaviconStore({ dir, isPrivate: PUBLIC, fetchImpl: fakeFetch({
      'https://example.com/': { status: 302, location: 'file:///etc/passwd' },
      'https://example.com/favicon.ico': { status: 302, location: 'file:///etc/passwd' },
    }, calls) })
    expect(await store.get('https://example.com')).toBeNull()
    expect(calls.some((c) => c.startsWith('file:'))).toBe(false)
  })

  it('gives up past three redirects', async () => {
    const hop = (n: number): Route => ({ status: 302, location: `/hop${n + 1}` })
    const routes: Record<string, Route> = { 'https://example.com/': hop(0) }
    for (let i = 1; i <= 9; i++) routes[`https://example.com/hop${i}`] = hop(i)
    const calls: string[] = []
    const store = new FaviconStore({ dir, isPrivate: PUBLIC, fetchImpl: fakeFetch(routes, calls) })
    expect(await store.get('https://example.com')).toBeNull()
    // The page walk stops after three hops; /favicon.ico is a plain 404 in this table.
    expect(calls.filter((c) => c === 'https://example.com/').length).toBe(1)
    expect(calls.filter((c) => c.startsWith('https://example.com/hop')).length).toBe(3)
  })

  it('follows a redirect to the real icon', async () => {
    const store = new FaviconStore({ dir, isPrivate: PUBLIC, fetchImpl: fakeFetch({
      'https://example.com/': { type: 'text/html', body: '<link rel="icon" href="/i">' },
      'https://example.com/i': { status: 301, location: 'https://cdn.example.com/i.png' },
      'https://cdn.example.com/i.png': { type: 'image/png', body: PNG },
    }) })
    expect((await store.get('https://example.com'))?.body.equals(PNG)).toBe(true)
  })

  it('serves the stale icon when the refresh fails, and re-fetches once it expires', async () => {
    let now = 1_000_000_000_000
    let live = true
    const routes: Record<string, Route | (() => Route)> = {
      'https://example.com/': () => live
        ? { type: 'text/html', body: '<link rel="icon" href="/a.png">' }
        : { status: 500 },
      'https://example.com/a.png': () => live ? { type: 'image/png', body: PNG } : { status: 500 },
      'https://example.com/favicon.ico': () => ({ status: 500 }),
    }
    const calls: string[] = []
    const store = new FaviconStore({ dir, isPrivate: PUBLIC, now: () => now, fetchImpl: fakeFetch(routes, calls) })
    expect((await store.get('https://example.com'))?.body.equals(PNG)).toBe(true)

    // A week later the file is stale, and the site is down: the old icon is served anyway.
    const file = join(dir, `${cacheKey('https://example.com')}.png`)
    const old = new Date(now - FAVICON_TTL_MS - 1000)
    await utimes(file, old, old)
    live = false
    calls.length = 0
    expect((await store.get('https://example.com'))?.body.equals(PNG)).toBe(true)
    expect(calls.length).toBeGreaterThan(0)
  })
})

describe('FaviconStore and a site that negotiates', () => {
  it('asks the page for HTML: a site that answers 406 to */* still yields the icon it declares', async () => {
    // Seen on a workspace login page: `Accept: */*` got a 406 with a text/calendar body; asked for
    // text/html the same page answered with its <head> and its icons.
    const calls: { url: string; accept: string }[] = []
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      const accept = String((init?.headers as Record<string, string>)?.accept ?? '')
      calls.push({ url: input, accept })
      if (input === 'https://ws.example.com/') {
        if (!accept.startsWith('text/html')) return new Response('BEGIN:VCALENDAR', { status: 406, headers: { 'content-type': 'text/calendar' } })
        return new Response('<link rel="icon" href="https://cdn.example.com/i.png">', { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (input === 'https://cdn.example.com/i.png') return new Response(new Uint8Array(PNG), { status: 200, headers: { 'content-type': 'image/png' } })
      return new Response(null, { status: 404 })
    }
    const store = new FaviconStore({ dir, fetchImpl, isPrivate: PUBLIC })
    const icon = await store.get('https://ws.example.com')
    expect(icon?.contentType).toBe('image/png')
    expect(calls[0].accept.startsWith('text/html')).toBe(true)
    expect(calls[1].accept.startsWith('image/')).toBe(true)
  })

  it('remembers an origin that yielded nothing, and asks again only after FAILED_TTL_MS', async () => {
    let now = 1_000_000
    const calls: string[] = []
    const routes: Record<string, Route> = {}
    const store = new FaviconStore({ dir, fetchImpl: fakeFetch(routes, calls), now: () => now, isPrivate: PUBLIC })
    expect(await store.get('https://none.example.com')).toBeNull()
    const asked = calls.length
    expect(asked).toBeGreaterThan(0)
    // The widget's retry, half a minute later: answered from memory, the site not touched.
    now += 30_000
    expect(await store.get('https://none.example.com')).toBeNull()
    expect(calls.length).toBe(asked)
    // Past the grace period the site is asked again — and this time it has an icon.
    now += FAILED_TTL_MS
    routes['https://none.example.com/favicon.ico'] = { type: 'image/png', body: PNG }
    expect((await store.get('https://none.example.com'))?.contentType).toBe('image/png')
    expect(calls.length).toBeGreaterThan(asked)
  })
})

describe('FaviconStore and SVG', () => {
  it('refuses an SVG icon, declared or sniffed, and keeps no file', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'
    for (const type of ['image/svg+xml', 'application/octet-stream']) {
      const store = new FaviconStore({ dir, isPrivate: PUBLIC, fetchImpl: fakeFetch({
        'https://example.com/': { type: 'text/html', body: '<link rel="icon" href="/i">' },
        'https://example.com/i': { type, body: svg },
        'https://example.com/favicon.ico': { type, body: svg },
      }) })
      expect(await store.get('https://example.com'), type).toBeNull()
      expect(await readdir(dir)).toEqual([])
    }
  })

  it('falls back to the .ico when the only declared icon is an SVG', async () => {
    const store = new FaviconStore({ dir, isPrivate: PUBLIC, fetchImpl: fakeFetch({
      'https://example.com/': { type: 'text/html', body: '<link rel="icon" href="/logo.svg">' },
      'https://example.com/favicon.ico': { type: 'image/png', body: PNG },
    }) })
    expect((await store.get('https://example.com'))?.contentType).toBe('image/png')
  })

  it('deletes SVG files an older version left in the cache', async () => {
    await mkdir(dir, { recursive: true })
    const key = cacheKey('https://example.com')
    await writeFile(join(dir, `${key}.svg`), '<svg/>')
    await writeFile(join(dir, `${key}.svg.tmp`), '<svg/>')
    await writeFile(join(dir, `${key}.png`), PNG)
    const store = new FaviconStore({ dir, isPrivate: PUBLIC, fetchImpl: fakeFetch({}) })
    await store.purgeUnservable()
    expect(await readdir(dir)).toEqual([`${key}.png`])
  })

  it('never serves a cached SVG even before the purge has run', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${cacheKey('https://example.com')}.svg`), '<svg/>')
    const store = new FaviconStore({ dir, isPrivate: PUBLIC, fetchImpl: fakeFetch({}) })
    expect(await store.get('https://example.com')).toBeNull()
    expect(extensionFor('image/svg+xml')).toBeNull()
  })
})

function app(store: FaviconStore) {
  const f = Fastify()
  f.register(faviconRoutes, { dir, store })
  return f
}

describe('GET /api/favicon', () => {
  it('answers the image with a day of caching', async () => {
    const store = new FaviconStore({ dir, isPrivate: PUBLIC, fetchImpl: fakeFetch({
      'https://example.com/': { type: 'text/html', body: '<link rel="icon" href="/a.png">' },
      'https://example.com/a.png': { type: 'image/png', body: PNG },
    }) })
    const res = await app(store).inject({ url: `/api/favicon?url=${encodeURIComponent('https://example.com/deep/page?token=secret')}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('image/png')
    expect(res.headers['cache-control']).toContain('max-age=86400')
    expect(Buffer.from(res.rawPayload).equals(PNG)).toBe(true)
  })

  it('answers a bodyless 404 when there is no icon', async () => {
    const store = new FaviconStore({ dir, isPrivate: PUBLIC, fetchImpl: fakeFetch({}) })
    const res = await app(store).inject({ url: `/api/favicon?url=${encodeURIComponent('https://example.com/secret-path')}` })
    expect(res.statusCode).toBe(404)
    expect(res.body).toBe('')
  })

  it('refuses a missing, malformed or non-http url with a bodyless 400', async () => {
    const a = app(new FaviconStore({ dir, isPrivate: PUBLIC, fetchImpl: fakeFetch({}) }))
    for (const url of ['/api/favicon', '/api/favicon?url=', '/api/favicon?url=nope',
      `/api/favicon?url=${encodeURIComponent('file:///etc/passwd')}`]) {
      const res = await a.inject({ url })
      expect(res.statusCode, url).toBe(400)
      expect(res.body).toBe('')
    }
  })

  it('refuses a cross-site read, which is how a page would embed it as an <img>', async () => {
    const store = new FaviconStore({ dir, isPrivate: PUBLIC, fetchImpl: fakeFetch({}) })
    const res = await app(store).inject({
      url: `/api/favicon?url=${encodeURIComponent('https://example.com/')}`,
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(res.statusCode).toBe(403)
    // Same-site, same-origin and no header at all (curl, the helper) still pass.
    for (const site of ['same-origin', 'same-site', 'none', undefined]) {
      const ok = await app(store).inject({
        url: `/api/favicon?url=${encodeURIComponent('https://example.com/')}`,
        headers: site ? { 'sec-fetch-site': site } : {},
      })
      expect(ok.statusCode, String(site)).not.toBe(403)
    }
  })

  it('refuses a private or local host, so it cannot knock on this machine', async () => {
    const calls: string[] = []
    const store = new FaviconStore({ dir, isPrivate: PUBLIC, fetchImpl: fakeFetch({}, calls) })
    for (const url of ['http://127.0.0.1:4242/', 'http://localhost:4242/', 'http://169.254.169.254/',
      'http://10.0.0.1/', 'http://[::1]/',
      // Hex IPv4-mapped IPv6, which is what new URL() canonicalises [::ffff:127.0.0.1] to.
      'http://[::ffff:7f00:1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::7f00:1]/',
      'http://[::ffff:a9fe:a9fe]/']) {
      const res = await app(store).inject({ url: `/api/favicon?url=${encodeURIComponent(url)}` })
      expect(res.statusCode, url).toBe(404)
    }
    expect(calls).toEqual([])
  })

  it('serves a file the cache already holds without any fetch', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${cacheKey('https://example.com')}.png`), PNG)
    const calls: string[] = []
    const store = new FaviconStore({ dir, isPrivate: PUBLIC, fetchImpl: fakeFetch({}, calls) })
    const res = await app(store).inject({ url: `/api/favicon?url=${encodeURIComponent('https://example.com/other')}` })
    expect(res.statusCode).toBe(200)
    expect(calls).toEqual([])
  })
})

describe('the size of the icon cache', () => {
  it('keeps at most MAX_CACHED_ICONS files, dropping the least recently written', async () => {
    await mkdir(dir, { recursive: true })
    // One more than the cap, each with a distinct mtime so "oldest" is unambiguous.
    const origins = Array.from({ length: MAX_CACHED_ICONS + 3 }, (_, i) => `https://site-${i}.example`)
    for (const [i, origin] of origins.entries()) {
      const file = join(dir, `${cacheKey(origin)}.png`)
      await writeFile(file, PNG)
      const when = new Date(1_000_000 + i * 1000)
      await utimes(file, when, when)
    }
    const store = new FaviconStore({ dir, isPrivate: PUBLIC, fetchImpl: fakeFetch({
      'https://fresh.example/': { type: 'text/html', body: '<link rel="icon" href="/a.png">' },
      'https://fresh.example/a.png': { type: 'image/png', body: PNG },
    }) })
    // Writing one more is what triggers the trim.
    expect((await store.get('https://fresh.example'))?.contentType).toBe('image/png')
    const remaining = await readdir(dir)
    expect(remaining.length).toBe(MAX_CACHED_ICONS)
    // The newcomer stayed and the three oldest went.
    expect(remaining).toContain(`${cacheKey('https://fresh.example')}.png`)
    for (const gone of origins.slice(0, 3)) expect(remaining).not.toContain(`${cacheKey(gone)}.png`)
  })
})

/**
 * The route checks the origin it was asked for; the store then follows whatever the far end
 * chooses. A redirect and a declared `<link rel=icon>` are both the far end choosing.
 */
describe('FaviconStore and private addresses', () => {
  /** Everything on 127.0.0.1 / 169.254.169.254 is private here; the resolver is not consulted. */
  const isPrivate = async (host: string) => host === '127.0.0.1' || host === '169.254.169.254'

  it('refuses to follow a redirect into the machine itself', async () => {
    const calls: string[] = []
    const store = new FaviconStore({
      dir, isPrivate,
      fetchImpl: fakeFetch({
        'https://example.com/': { status: 301, location: 'http://127.0.0.1:4242/api/config' },
        'https://example.com/favicon.ico': { status: 301, location: 'http://127.0.0.1:4242/secret.png' },
      }, calls),
    })
    expect(await store.get('https://example.com')).toBeNull()
    expect(calls.some((c) => c.includes('127.0.0.1'))).toBe(false)
  })

  it('refuses the icon a page declares on a private host', async () => {
    const calls: string[] = []
    const store = new FaviconStore({
      dir, isPrivate,
      fetchImpl: fakeFetch({
        'https://example.com/': {
          type: 'text/html',
          body: '<link rel="icon" href="http://169.254.169.254/latest/meta-data/iam/x.png">',
        },
      }, calls),
    })
    expect(await store.get('https://example.com')).toBeNull()
    expect(calls.some((c) => c.includes('169.254.169.254'))).toBe(false)
  })

  it('still fetches a public icon, declared or by redirect', async () => {
    const store = new FaviconStore({
      dir, isPrivate,
      fetchImpl: fakeFetch({
        'https://example.com/': { type: 'text/html', body: '<link rel="icon" href="/icon.png">' },
        'https://example.com/icon.png': { status: 302, location: 'https://cdn.example.com/i.png' },
        'https://cdn.example.com/i.png': { type: 'image/png', body: PNG },
      }),
    })
    expect(await store.get('https://example.com')).toMatchObject({ contentType: 'image/png' })
  })
})
