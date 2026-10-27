import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config, type Connection } from '../src/config/schema.js'
import type { ConfigStore } from '../src/config/store.js'
import { gifRoutes } from '../src/gifs/routes.js'
import { GifStore } from '../src/gifs/store.js'

const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32, 1)])
const KEY = 'SECRETKEY'
const GIPHY: Connection = { id: 'giphy-1', type: 'giphy', name: 'Giphy', fields: {} }
const SEARCH_PAYLOAD = {
  data: [{ id: 'a1', title: 'Hello', images: { fixed_width: { width: '200', height: '150' } } }],
  pagination: { total_count: 1 },
}

let dataDir: string
let app: FastifyInstance | undefined
beforeEach(async () => { dataDir = await mkdtemp(join(tmpdir(), 'fremkit-gif-routes-')) })
afterEach(async () => {
  await app?.close()
  app = undefined
  await rm(dataDir, { recursive: true, force: true })
})

function respond(url: string): Response {
  if (url.startsWith('https://api.giphy.com/')) return Response.json(SEARCH_PAYLOAD)
  if (url === 'https://example.com/page.html') return new Response('<!doctype html><p>hi</p>', { headers: { 'content-type': 'text/html' } })
  if (url === 'https://example.com/to-giphy') return new Response(null, { status: 302, headers: { location: 'https://media.giphy.com/media/abc/200w.gif' } })
  if (url === 'https://example.com/a.gif') return new Response(GIF, { headers: { 'content-type': 'image/gif' } })
  return new Response('', { status: 404 })
}

async function build(opts: { connections?: Connection[]; demo?: boolean; secretsFail?: boolean } = {}) {
  const config: Config = { ...DEFAULT_CONFIG, connections: opts.connections ?? [] }
  const store = { get: () => config } as unknown as ConfigStore
  const fetchImpl = vi.fn(async (input: string | URL) => respond(String(input)))
  const gifFetch = vi.fn(async (input: string | URL) => respond(String(input)))
  const gifs = new GifStore({ dataDir, fetchImpl: gifFetch, isPrivate: async () => false })
  const secretsFor = vi.fn(async (c: Connection): Promise<Record<string, string>> => {
    if (opts.secretsFail) throw new Error('keychain item fremkit/giphy-1 is locked')
    return c.id === GIPHY.id ? { apiKey: KEY } : {}
  })
  app = Fastify()
  await app.register(gifRoutes, { store, gifs, secretsFor, fetchImpl: fetchImpl as unknown as typeof fetch, demo: opts.demo })
  return { app, fetchImpl, gifFetch, gifs }
}

describe('GET /api/gifs/search', () => {
  it('answers unconfigured when no Giphy connection exists', async () => {
    const { app, fetchImpl } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/gifs/search?q=hello' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: false, error: 'unconfigured' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('searches with the stored key and never hands it back', async () => {
    const { app, fetchImpl } = await build({ connections: [GIPHY] })
    const res = await app.inject({ method: 'GET', url: '/api/gifs/search?q=hello&offset=24' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, total: 1, results: [{ giphyId: 'a1' }] })
    const called = new URL(String((fetchImpl.mock.calls[0] as unknown[])[0]))
    expect(called.searchParams.get('api_key')).toBe(KEY)
    expect(called.searchParams.get('offset')).toBe('24')
    expect(res.body).not.toContain(KEY)
  })

  it('answers unreachable when the key cannot be read, without the error text', async () => {
    const { app, fetchImpl } = await build({ connections: [GIPHY], secretsFail: true })
    const res = await app.inject({ method: 'GET', url: '/api/gifs/search?q=hello' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: false, error: 'unreachable' })
    expect(res.body).not.toContain('keychain')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses a query shorter than two characters', async () => {
    const { app, fetchImpl } = await build({ connections: [GIPHY] })
    expect((await app.inject({ method: 'GET', url: '/api/gifs/search?q=a' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/gifs/search?q=%20a%20' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/gifs/search' })).statusCode).toBe(400)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses a bad offset', async () => {
    const { app } = await build({ connections: [GIPHY] })
    expect((await app.inject({ method: 'GET', url: '/api/gifs/search?q=hello&offset=-1' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/gifs/search?q=hello&offset=abc' })).statusCode).toBe(400)
  })

  it('answers unconfigured in a demo without any network call', async () => {
    const { app, fetchImpl } = await build({ connections: [GIPHY], demo: true })
    const res = await app.inject({ method: 'GET', url: '/api/gifs/search?q=hello' })
    expect(res.json()).toEqual({ ok: false, error: 'unconfigured' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('POST /api/gifs/check and GET /api/gifs/cached', () => {
  it('refuses a page that is not a GIF', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'POST', url: '/api/gifs/check', payload: { url: 'https://example.com/page.html' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: false })
    expect(typeof res.json().error).toBe('string')
    expect(res.body).not.toContain('example.com')
  })

  it('caches a GIF, then serves it from the cache', async () => {
    const { app, gifFetch } = await build()
    const url = 'https://example.com/a.gif'
    const check = await app.inject({ method: 'POST', url: '/api/gifs/check', payload: { url } })
    expect(check.json()).toEqual({ ok: true })
    const cached = await app.inject({ method: 'GET', url: `/api/gifs/cached?url=${encodeURIComponent(url)}` })
    expect(cached.statusCode).toBe(200)
    expect(cached.headers['content-type']).toBe('image/gif')
    expect(cached.headers['cache-control']).toBe('private, max-age=86400')
    expect(cached.rawPayload.equals(GIF)).toBe(true)
    expect(gifFetch).toHaveBeenCalledTimes(1)
  })

  it('answers 404 for a GIF that is not cached, without fetching it', async () => {
    const { app, gifFetch } = await build()
    const res = await app.inject({ method: 'GET', url: `/api/gifs/cached?url=${encodeURIComponent('https://example.com/a.gif')}` })
    expect(res.statusCode).toBe(404)
    expect(gifFetch).not.toHaveBeenCalled()
  })

  it('answers 404 to a cross-site request for a cached GIF', async () => {
    const { app } = await build()
    const url = 'https://example.com/a.gif'
    await app.inject({ method: 'POST', url: '/api/gifs/check', payload: { url } })
    const res = await app.inject({
      method: 'GET',
      url: `/api/gifs/cached?url=${encodeURIComponent(url)}`,
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('refuses a Giphy link, which must never be cached', async () => {
    const { app, gifFetch } = await build()
    for (const url of ['https://media.giphy.com/x.gif', 'https://giphy.com/gifs/x', 'https://i.GIPHY.com/x.gif', 'https://media.giphy.com./x.gif', 'https://gph.is/abc']) {
      const res = await app.inject({ method: 'POST', url: '/api/gifs/check', payload: { url } })
      expect(res.statusCode).toBe(400)
    }
    expect(gifFetch).not.toHaveBeenCalled()
  })

  it('refuses a link that redirects to Giphy, and caches nothing', async () => {
    const { app, gifs } = await build()
    const res = await app.inject({ method: 'POST', url: '/api/gifs/check', payload: { url: 'https://example.com/to-giphy' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: false, error: expect.stringContaining('Giphy') })
    expect(await gifs.isCached('https://example.com/to-giphy')).toBe(false)
  })

  it('answers 404 for a GIF pruned after it was cached', async () => {
    const { app, gifs } = await build()
    const url = 'https://example.com/a.gif'
    await app.inject({ method: 'POST', url: '/api/gifs/check', payload: { url } })
    await unlink(gifs.cachedPath(url))
    const res = await app.inject({ method: 'GET', url: `/api/gifs/cached?url=${encodeURIComponent(url)}` })
    expect(res.statusCode).toBe(404)
  })

  it('refuses a URL that is not https or too long', async () => {
    const { app, gifFetch } = await build()
    for (const url of ['http://example.com/a.gif', 'not a url', `https://example.com/${'a'.repeat(2048)}.gif`]) {
      const res = await app.inject({ method: 'POST', url: '/api/gifs/check', payload: { url } })
      expect(res.statusCode).toBe(400)
    }
    expect(gifFetch).not.toHaveBeenCalled()
  })
})

describe('locality', () => {
  it('answers 404 to a request that is not from this Mac, on all three routes', async () => {
    const { app, fetchImpl, gifFetch } = await build({ connections: [GIPHY] })
    const remoteAddress = '192.0.2.10'
    const url = encodeURIComponent('https://example.com/a.gif')
    expect((await app.inject({ method: 'GET', url: '/api/gifs/search?q=hello', remoteAddress })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/gifs/check', payload: { url: 'https://example.com/a.gif' }, remoteAddress })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/gifs/cached?url=${url}`, remoteAddress })).statusCode).toBe(404)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(gifFetch).not.toHaveBeenCalled()
  })
})
