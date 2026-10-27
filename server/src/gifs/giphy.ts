import { giphyThumbUrl } from './store.js'

/** One search result: enough for the admin to draw a thumbnail and keep the id. */
export interface GiphyResult { giphyId: string; title: string; thumb: string; width: number; height: number }

export type GiphySearch =
  | { ok: true; results: GiphyResult[]; total: number }
  | { ok: false; error: 'unauthorized' | 'rateLimited' | 'unreachable' }

const SEARCH_URL = 'https://api.giphy.com/v1/gifs/search'
const PAGE_SIZE = 24
const TIMEOUT_MS = 8000
/** Same rule as the config schema's `giphyId`: it ends up in a URL path. */
const GIPHY_ID = /^[A-Za-z0-9]{1,64}$/

interface RawGif {
  id?: unknown
  title?: unknown
  images?: { fixed_width?: { width?: unknown; height?: unknown } }
}

function toSize(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

/**
 * One page of a Giphy search.
 *
 * The host is fixed and ours, not one a user or a widget named, so this goes through the plain
 * `fetch`. The API key travels as a query parameter, which is why nothing from the request or
 * from Giphy's answer is ever returned or logged: a failure is one of three codes.
 */
export async function searchGiphy(apiKey: string, q: string, offset: number, fetchImpl: typeof fetch = fetch): Promise<GiphySearch> {
  const url = new URL(SEARCH_URL)
  url.searchParams.set('api_key', apiKey)
  url.searchParams.set('q', q)
  url.searchParams.set('limit', String(PAGE_SIZE))
  url.searchParams.set('offset', String(offset))
  url.searchParams.set('rating', 'pg-13')
  let res: Response
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } })
  } catch {
    return { ok: false, error: 'unreachable' }
  }
  if (res.status === 401 || res.status === 403) return { ok: false, error: 'unauthorized' }
  if (res.status === 429) return { ok: false, error: 'rateLimited' }
  if (!res.ok) return { ok: false, error: 'unreachable' }
  let body: { data?: unknown; pagination?: { total_count?: unknown } }
  try {
    body = (await res.json()) as typeof body
  } catch {
    return { ok: false, error: 'unreachable' }
  }
  if (!body || !Array.isArray(body.data)) return { ok: false, error: 'unreachable' }
  const results: GiphyResult[] = []
  for (const raw of body.data as RawGif[]) {
    if (typeof raw?.id !== 'string' || !GIPHY_ID.test(raw.id)) continue
    const size = raw.images?.fixed_width
    results.push({
      giphyId: raw.id,
      title: typeof raw.title === 'string' ? raw.title : '',
      thumb: giphyThumbUrl(raw.id),
      width: toSize(size?.width),
      height: toSize(size?.height),
    })
  }
  const total = Number(body.pagination?.total_count)
  return { ok: true, results, total: Number.isFinite(total) && total >= 0 ? total : results.length }
}
