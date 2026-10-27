import { open } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Connection } from '../config/schema.js'
import type { ConfigStore } from '../config/store.js'
import { isCrossSiteFetch } from '../http/guard.js'
import { tr } from '../i18n.js'
import { isLocalRequest } from '../net/remote.js'
import { searchGiphy } from './giphy.js'
import { GifFetchError, isGiphyHost, type GifStore } from './store.js'

const MIN_QUERY = 2
/** Giphy's API refuses offsets past this one. */
const MAX_OFFSET = 4999

const CheckBody = z.object({
  url: z.string().max(2048).url().refine((u) => u.startsWith('https://')),
})

/**
 * The editor's GIF routes, for filling the GIF board under its settings.
 *
 * - `GET /api/gifs/search` — a Giphy search, made here with the key of the first Giphy
 *   connection so the key never reaches the page.
 * - `POST /api/gifs/check` — downloads a pasted GIF link into the cache, or says why not.
 * - `GET /api/gifs/cached` — a GIF already in the cache, for the editor's thumbnails. Never
 *   fetches.
 *
 * All three are the editor's alone: anything but a request from this Mac gets a 404, and none is
 * on the paired devices' allow-list. A demo searches nothing: the GIF store it is handed is
 * already the demo's, and search answers `unconfigured` before any network call.
 */
export async function gifRoutes(
  app: FastifyInstance,
  opts: {
    store: ConfigStore
    gifs: GifStore
    secretsFor: (c: Connection) => Promise<Record<string, string>>
    fetchImpl?: typeof fetch
    demo?: boolean
  },
): Promise<void> {
  app.get<{ Querystring: { q?: string; offset?: string } }>('/api/gifs/search', async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(404).send()
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (q.length < MIN_QUERY) return reply.code(400).send()
    const rawOffset = req.query.offset ?? '0'
    if (!/^\d{1,4}$/.test(rawOffset) || Number(rawOffset) > MAX_OFFSET) return reply.code(400).send()
    if (opts.demo) return { ok: false, error: 'unconfigured' }
    const connection = opts.store.get().connections.find((c) => c.type === 'giphy')
    if (!connection) return { ok: false, error: 'unconfigured' }
    let apiKey: string | undefined
    try {
      apiKey = (await opts.secretsFor(connection)).apiKey
    } catch {
      // A keychain error message is never sent on: it could name the item.
      return { ok: false, error: 'unreachable' }
    }
    if (!apiKey) return { ok: false, error: 'unconfigured' }
    return searchGiphy(apiKey, q, Number(rawOffset), opts.fetchImpl ?? fetch)
  })

  app.post('/api/gifs/check', { bodyLimit: 4096 }, async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(404).send()
    const parsed = CheckBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send()
    const { url } = parsed.data
    // A pasted Giphy link becomes a giphy item in the editor; its content is never cached. The
    // store refuses Giphy again on every redirect hop.
    if (isGiphyHost(new URL(url).hostname)) return reply.code(400).send()
    try {
      await opts.gifs.ensureCached(url)
      return { ok: true }
    } catch (err) {
      const code = err instanceof GifFetchError ? err.code : 'unreachable'
      return { ok: false, error: tr(opts.store.get().locale, `gifs.${code}`) }
    }
  })

  app.get<{ Querystring: { url?: string } }>('/api/gifs/cached', async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(404).send()
    if (isCrossSiteFetch(req.headers)) return reply.code(404).send()
    const url = req.query.url
    if (typeof url !== 'string' || url === '') return reply.code(404).send()
    // Opened before answering, so a file pruned in the meantime is a 404, not a failed stream.
    let file
    try {
      file = await open(opts.gifs.cachedPath(url), 'r')
    } catch {
      return reply.code(404).send()
    }
    return reply
      .type('image/gif')
      .header('cache-control', 'private, max-age=86400')
      .send(file.createReadStream())
  })
}
