import type { FastifyInstance } from 'fastify'
import { FaviconStore } from './store.js'
import { isLoopbackAddress } from '../net/loopback.js'

/**
 * `GET /api/favicon?url=…` — the icon of the site a link button points at.
 *
 * Only the origin of the URL is used, so every button on one site shares a single cached icon
 * and the path (which may carry a token or a private page) never leaves this machine beyond the
 * request the widget already made. A failure answers a bodyless 404: no message that could
 * repeat the URL back to a caller, and nothing is ever logged — including by the request log
 * itself, whose serializer drops the query string (see http/logging.ts).
 */
export async function faviconRoutes(app: FastifyInstance, opts: { dir: string; store?: FaviconStore }): Promise<void> {
  const store = opts.store ?? new FaviconStore({ dir: opts.dir })
  // A cache written by an older version may hold SVG icons, which are no longer served.
  await store.purgeUnservable()

  app.get<{ Querystring: { url?: string } }>('/api/favicon', async (req, reply) => {
    if (!isLoopbackAddress(req.ip)) return reply.code(403).send()
    const raw = req.query.url
    if (typeof raw !== 'string' || raw === '') return reply.code(400).send()
    let target: URL
    try { target = new URL(raw) } catch { return reply.code(400).send() }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return reply.code(400).send()

    const icon = await store.get(target.origin)
    if (!icon) return reply.code(404).send()
    // A day: long enough that the grid does not re-ask on every render, short enough that a
    // refreshed cache reaches the dashboard without a restart.
    return reply.type(icon.contentType).header('cache-control', 'public, max-age=86400').send(icon.body)
  })
}
