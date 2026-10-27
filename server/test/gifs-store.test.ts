import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GifFetchError,
  GifStore,
  MAX_GIF_BYTES,
  TEMP_TTL_MS,
  giphyFullUrl,
  giphyThumbUrl,
} from '../src/gifs/store.js'

const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32, 1)])
const A = 'https://example.com/a.gif'
const B = 'https://example.com/b.gif'

let dataDir: string
beforeEach(async () => { dataDir = await mkdtemp(join(tmpdir(), 'fremkit-gifs-')) })
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }) })

function gifResponse(body: Uint8Array | ReadableStream<Uint8Array> = GIF, headers: Record<string, string> = {}): Response {
  return new Response(body as BodyInit, { status: 200, headers: { 'content-type': 'image/gif', ...headers } })
}

function store(fetchImpl: (url: string) => Promise<Response>, extra: { isPrivate?: (h: string) => Promise<boolean>; now?: () => number } = {}) {
  const fn = vi.fn((input: string | URL) => fetchImpl(String(input)))
  const s = new GifStore({
    dataDir,
    fetchImpl: fn,
    isPrivate: extra.isPrivate ?? (async () => false),
    now: extra.now,
  })
  return { s, fn }
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p } catch (err) {
    expect(err).toBeInstanceOf(GifFetchError)
    return (err as GifFetchError).code
  }
  throw new Error('expected a GifFetchError')
}

async function list(sub: string): Promise<string[]> {
  try { return await readdir(join(dataDir, 'gifs', sub)) } catch { return [] }
}

describe('giphy urls', () => {
  it('builds the full and thumbnail forms', () => {
    expect(giphyFullUrl('abc')).toBe('https://i.giphy.com/abc.gif')
    expect(giphyThumbUrl('abc')).toBe('https://media.giphy.com/media/abc/200w.gif')
  })
})

describe('GifStore.ensureCached', () => {
  it('writes the GIF at cachedPath with mode 0600 and fetches it only once', async () => {
    const { s, fn } = store(async () => gifResponse())
    const path = await s.ensureCached(A)
    expect(path).toBe(s.cachedPath(A))
    expect(path.startsWith(join(dataDir, 'gifs', 'cache'))).toBe(true)
    expect(path).toMatch(/[0-9a-f]{64}\.gif$/)
    const body = await readFile(path)
    expect(body.subarray(0, 6).toString()).toBe('GIF89a')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(dataDir, 'gifs', 'cache'))).mode & 0o777).toBe(0o700)
    expect(await s.isCached(A)).toBe(true)
    await s.ensureCached(A)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('accepts GIF87a', async () => {
    const { s } = store(async () => gifResponse(Buffer.from('GIF87a....')))
    await expect(s.ensureCached(A)).resolves.toBe(s.cachedPath(A))
  })

  it('dedupes concurrent downloads of the same URL', async () => {
    const { s, fn } = store(async () => gifResponse())
    const [p1, p2] = await Promise.all([s.ensureCached(A), s.ensureCached(A)])
    expect(p1).toBe(p2)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('refuses an HTML body and leaves nothing in the cache', async () => {
    const { s } = store(async () => new Response('<!doctype html><p>hi</p>', { headers: { 'content-type': 'text/html' } }))
    expect(await codeOf(s.ensureCached(A))).toBe('notGif')
    expect(await list('cache')).toEqual([])
    expect(await s.isCached(A)).toBe(false)
  })

  it('refuses a declared content-length over the cap', async () => {
    const { s } = store(async () => gifResponse(GIF, { 'content-length': '20000000' }))
    expect(await codeOf(s.ensureCached(A))).toBe('tooLarge')
    expect(await list('cache')).toEqual([])
  })

  it('stops reading a chunked body past the cap', async () => {
    let sent = 0
    const chunk = new Uint8Array(1024 * 1024)
    chunk.set(Buffer.from('GIF89a'))
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_GIF_BYTES + 4 * chunk.byteLength) { controller.close(); return }
        sent += chunk.byteLength
        controller.enqueue(chunk)
      },
    })
    const { s } = store(async () => gifResponse(body))
    expect(await codeOf(s.ensureCached(A))).toBe('tooLarge')
    expect(sent).toBeLessThan(MAX_GIF_BYTES + 3 * chunk.byteLength)
    expect(await list('cache')).toEqual([])
  })

  it('refuses a redirect to a private host', async () => {
    const isPrivate = vi.fn(async (host: string) => host === '127.0.0.1')
    const { s, fn } = store(async (url) => url === A
      ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/x.gif' } })
      : gifResponse(), { isPrivate })
    expect(await codeOf(s.ensureCached(A))).toBe('privateHost')
    expect(isPrivate).toHaveBeenCalledWith('127.0.0.1')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('refuses a private host given directly', async () => {
    const { s, fn } = store(async () => gifResponse(), { isPrivate: async () => true })
    expect(await codeOf(s.ensureCached('http://192.0.2.1/x.gif'))).toBe('privateHost')
    expect(fn).not.toHaveBeenCalled()
  })

  it('gives up after three redirects', async () => {
    let n = 0
    const { s, fn } = store(async () => new Response(null, { status: 302, headers: { location: `https://example.com/r${++n}.gif` } }))
    expect(await codeOf(s.ensureCached(A))).toBe('unreachable')
    expect(fn).toHaveBeenCalledTimes(4)
  })

  it('refuses a URL carrying credentials without fetching it or naming it', async () => {
    const { s, fn } = store(async () => gifResponse())
    const url = 'https://user:hunter2@example.com/a.gif'
    let error: unknown
    try { await s.ensureCached(url) } catch (err) { error = err }
    expect(error).toBeInstanceOf(GifFetchError)
    expect((error as GifFetchError).code).toBe('unreachable')
    expect((error as Error).message).not.toContain('hunter2')
    expect(fn).not.toHaveBeenCalled()
  })

  it('refuses a non-http scheme and a failed fetch as unreachable, without the URL in the message', async () => {
    const { s } = store(async () => { throw new Error('boom') })
    expect(await codeOf(s.ensureCached('file:///etc/passwd'))).toBe('unreachable')
    let error: unknown
    try { await s.ensureCached(A) } catch (err) { error = err }
    expect((error as GifFetchError).code).toBe('unreachable')
    expect((error as Error).message).not.toContain('example.com')
  })

  it('treats a non-2xx answer as unreachable', async () => {
    const { s } = store(async () => new Response('nope', { status: 404 }))
    expect(await codeOf(s.ensureCached(A))).toBe('unreachable')
  })
})

describe('GifStore.tempCopy', () => {
  it('downloads the full Giphy URL into tmp, never cache, and replaces the previous temp', async () => {
    const { s, fn } = store(async () => gifResponse())
    const first = await s.tempCopy('abc')
    expect(fn).toHaveBeenCalledWith('https://i.giphy.com/abc.gif', expect.anything())
    expect(first.startsWith(join(dataDir, 'gifs', 'tmp'))).toBe(true)
    expect((await stat(first)).mode & 0o777).toBe(0o600)
    expect(await list('cache')).toEqual([])
    const second = await s.tempCopy('def')
    expect(second).not.toBe(first)
    await expect(stat(first)).rejects.toThrow()
    expect(await list('tmp')).toHaveLength(1)
    expect(await list('cache')).toEqual([])
  })
})

describe('GifStore.sweepTemp', () => {
  it('keeps a temp file younger than the TTL and deletes an older one', async () => {
    let clock = Date.now()
    const { s } = store(async () => gifResponse(), { now: () => clock })
    const path = await s.tempCopy('abc')
    clock += 9 * 60_000
    await s.sweepTemp()
    await expect(stat(path)).resolves.toBeTruthy()
    clock += 2 * 60_000
    expect(11 * 60_000).toBeGreaterThan(TEMP_TTL_MS)
    await s.sweepTemp()
    await expect(stat(path)).rejects.toThrow()
  })
})

describe('GifStore.prune', () => {
  it('keeps the files of the URLs given and deletes the others', async () => {
    const { s } = store(async () => gifResponse())
    await s.ensureCached(A)
    await s.ensureCached(B)
    await s.prune([A])
    expect(await s.isCached(A)).toBe(true)
    expect(await s.isCached(B)).toBe(false)
  })
})
