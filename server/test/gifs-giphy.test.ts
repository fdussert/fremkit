import { describe, expect, it, vi } from 'vitest'
import { searchGiphy } from '../src/gifs/giphy.js'
import { giphyThumbUrl } from '../src/gifs/store.js'
import { giphyType } from '../src/connections/types/giphy.js'
import { tr } from '../src/i18n.js'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const PAYLOAD = {
  data: [
    { id: 'a1', title: 'Hello wave', images: { fixed_width: { width: '200', height: '150' } } },
    { id: 'b2', title: 'Hi there', images: { fixed_width: { width: '200', height: '112' } } },
  ],
  pagination: { total_count: 4321, count: 2, offset: 0 },
}

describe('searchGiphy', () => {
  it('maps the results to thumbnails and sizes', async () => {
    const fetchImpl = vi.fn(async () => json(PAYLOAD))
    const result = await searchGiphy('k', 'hello', 24, fetchImpl as unknown as typeof fetch)
    expect(result).toEqual({
      ok: true,
      total: 4321,
      results: [
        { giphyId: 'a1', title: 'Hello wave', thumb: giphyThumbUrl('a1'), width: 200, height: 150 },
        { giphyId: 'b2', title: 'Hi there', thumb: giphyThumbUrl('b2'), width: 200, height: 112 },
      ],
    })
    const url = new URL(String((fetchImpl.mock.calls[0] as unknown[])[0]))
    expect(url.origin + url.pathname).toBe('https://api.giphy.com/v1/gifs/search')
    expect(url.searchParams.get('api_key')).toBe('k')
    expect(url.searchParams.get('q')).toBe('hello')
    expect(url.searchParams.get('limit')).toBe('24')
    expect(url.searchParams.get('offset')).toBe('24')
    expect(url.searchParams.get('rating')).toBe('pg-13')
  })

  it('drops an entry whose id could not be a Giphy id', async () => {
    const payload = { data: [{ id: '../x', images: {} }, PAYLOAD.data[0]], pagination: { total_count: 2 } }
    const result = await searchGiphy('k', 'hello', 0, (async () => json(payload)) as unknown as typeof fetch)
    expect(result.ok && result.results.map((r) => r.giphyId)).toEqual(['a1'])
  })

  it('answers unauthorized to 401 and 403', async () => {
    for (const status of [401, 403]) {
      const result = await searchGiphy('k', 'hello', 0, (async () => json({ message: 'Invalid key' }, status)) as unknown as typeof fetch)
      expect(result).toEqual({ ok: false, error: 'unauthorized' })
    }
  })

  it('answers rateLimited to 429', async () => {
    const result = await searchGiphy('k', 'hello', 0, (async () => json({}, 429)) as unknown as typeof fetch)
    expect(result).toEqual({ ok: false, error: 'rateLimited' })
  })

  it('answers unreachable to a failure, without quoting the key', async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error('GET https://api.giphy.com/v1/gifs/search?api_key=SECRETKEY failed')
    }
    const result = await searchGiphy('SECRETKEY', 'hello', 0, fetchImpl as unknown as typeof fetch)
    expect(result).toEqual({ ok: false, error: 'unreachable' })
    expect(JSON.stringify(result)).not.toContain('SECRETKEY')
  })

  it('answers unreachable to a 500 and to a body that is not JSON', async () => {
    expect(await searchGiphy('k', 'hello', 0, (async () => json({}, 500)) as unknown as typeof fetch))
      .toEqual({ ok: false, error: 'unreachable' })
    expect(await searchGiphy('k', 'hello', 0, (async () => new Response('<html>')) as unknown as typeof fetch))
      .toEqual({ ok: false, error: 'unreachable' })
  })
})

describe('giphyType', () => {
  it('keeps its key as a required secret and publishes nothing', () => {
    expect(giphyType.id).toBe('giphy')
    expect(giphyType.fields).toEqual([expect.objectContaining({ key: 'apiKey', secret: true, required: true })])
    expect(giphyType.createProvider).toBeUndefined()
  })

  it('tests the key with one search', async () => {
    const fetchFn = vi.fn(async () => json(PAYLOAD))
    const result = await giphyType.test({}, { apiKey: 'k' }, { fetchFn })
    expect(result.ok).toBe(true)
    expect(result.ok && result.detail).toContain('4321')
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toContain('api_key=k')
  })

  it('reports a refused key without quoting it', async () => {
    const result = await giphyType.test({}, { apiKey: 'SECRETKEY' }, { fetchFn: async () => json({}, 403) })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('SECRETKEY')
  })

  it('says Giphy, not the GIF, is unreachable', async () => {
    const result = await giphyType.test({}, { apiKey: 'k' }, { fetchFn: async () => { throw new Error('down') } })
    expect(result).toEqual({ ok: false, error: tr(undefined, 'giphy.unreachable') })
  })

  it('refuses an empty key without calling Giphy', async () => {
    const fetchFn = vi.fn(async () => json(PAYLOAD))
    const result = await giphyType.test({}, {}, { fetchFn })
    expect(result.ok).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
