import type { FastifyInstance } from 'fastify'
import type { WidgetCatalog } from '../widgets/catalog.js'
import type { ConfigStore } from '../config/store.js'
import { grantedFor } from '../marketplace/consent.js'
import { resolvesToPrivate } from '../net/private.js'
import { isCrossSiteFetch } from '../http/guard.js'
import { tr } from '../i18n.js'

const TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 5
/**
 * Largest answer relayed to a widget. Well above any forecast or API page, and small enough that
 * a widget cannot make the server hold a video in memory by asking for one.
 */
export const MAX_BODY_BYTES = 1024 * 1024

/**
 * What the proxy declares its answer to be.
 *
 * Never the upstream's own content-type: a remote server that answers `text/html` would have its
 * page rendered as a document on this server's origin. Widgets read JSON or text and nothing
 * else, so the answer is one of those two, whatever the upstream called it. The `nosniff` and
 * sandbox headers come from the global hook in app.ts.
 */
const JSON_TYPE = 'application/json; charset=utf-8'
const TEXT_TYPE = 'text/plain; charset=utf-8'

export interface ProxyOptions {
  catalog: WidgetCatalog
  /** Read for the consent records: what an installed widget may reach is a config fact. */
  store: ConfigStore
  /**
   * Whether a host is private or local. Production uses `resolvesToPrivate`; the proxy's own
   * tests put their upstream on loopback and stand in for a public host here.
   */
  isPrivate?: (host: string) => Promise<boolean>
}

export async function proxyRoutes(app: FastifyInstance, opts: ProxyOptions): Promise<void> {
  const isPrivate = opts.isPrivate ?? resolvesToPrivate
  const checkUrl = (url: URL, allowedHosts: string[]): { ok: true } | { error: string; code: number } => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: tr(undefined, 'proxy.badScheme'), code: 400 }
    if (!allowedHosts.includes(url.hostname)) return { error: tr(undefined, 'proxy.hostNotAllowed', { host: url.hostname }), code: 403 }
    return { ok: true }
  }

  /**
   * Reads at most `MAX_BODY_BYTES`, giving up rather than truncating: half a JSON document is not
   * a document, and a widget silently parsing one would be worse than an error.
   */
  const readCapped = async (res: Response): Promise<Buffer | null> => {
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) { void res.body?.cancel().catch(() => {}); return null }
    const reader = res.body?.getReader()
    if (!reader) {
      const buffer = Buffer.from(await res.arrayBuffer())
      return buffer.byteLength > MAX_BODY_BYTES ? null : buffer
    }
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BODY_BYTES) { void reader.cancel().catch(() => {}); return null }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  }

  app.get<{ Params: { widgetId: string }; Querystring: { url?: string } }>('/api/proxy/:widgetId', async (req, reply) => {
    // A GET, so the Origin gate never sees it — and this one makes the server go out onto the
    // network on the caller's behalf. Same refusal as /api/favicon.
    if (isCrossSiteFetch(req.headers)) return reply.code(403).send({ error: tr(undefined, 'http.originNotAllowed') })
    // Granted, not declared: an installed widget reaches the hosts the user accepted, not the
    // ones its manifest happens to name after an update.
    const manifest = grantedFor(opts.catalog, opts.store.get(), req.params.widgetId)
    if (!manifest) return reply.code(404).send({ error: tr(undefined, 'widgets.unknown') })
    const raw = req.query.url
    if (!raw) return reply.code(400).send({ error: tr(undefined, 'proxy.missingUrl') })
    let target: URL
    try { target = new URL(raw) } catch { return reply.code(400).send({ error: tr(undefined, 'proxy.badUrl') }) }
    const check = checkUrl(target, manifest.permissions.network)
    if ('error' in check) return reply.code(check.code).send({ error: check.error })
    // The manifest is checked for private hosts when it is read; this catches the name that
    // resolves to one. See net/private.ts.
    if (await isPrivate(target.hostname)) {
      return reply.code(403).send({ error: tr(undefined, 'proxy.privateHost', { host: target.hostname }) })
    }

    let upstream: Response
    let current = target
    let hops = 0
    try {
      for (;;) {
        upstream = await fetch(current, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' })
        if (![301, 302, 303, 307, 308].includes(upstream.status)) break
        const location = upstream.headers.get('location')
        void upstream.body?.cancel().catch(() => {})
        if (!location) break
        hops++
        if (hops > MAX_REDIRECTS) return reply.code(502).send({ error: tr(undefined, 'proxy.tooManyRedirects') })
        try { current = new URL(location, current) } catch { return reply.code(400).send({ error: tr(undefined, 'proxy.badUrl') }) }
        const redirectCheck = checkUrl(current, manifest.permissions.network)
        if ('error' in redirectCheck) return reply.code(redirectCheck.code).send({ error: tr(undefined, 'proxy.redirectNotAllowed', { host: current.hostname }) })
        if (await isPrivate(current.hostname)) {
          return reply.code(403).send({ error: tr(undefined, 'proxy.privateHost', { host: current.hostname }) })
        }
      }
    } catch (err) {
      // Never the raw message: it quotes the URL, which may carry a key a widget's setting holds.
      req.log.warn({ widgetId: req.params.widgetId, name: (err as Error).name }, 'proxy request failed')
      return reply.code(502).send({ error: tr(undefined, 'proxy.upstreamFailed') })
    }

    let body: Buffer | null
    try { body = await readCapped(upstream) } catch { body = null }
    if (body === null) return reply.code(502).send({ error: tr(undefined, 'proxy.tooLarge') })

    // The upstream's own type is discarded; only the shape of the bytes decides which of the two
    // types we are willing to declare.
    const looksJson = /^[\s﻿]*[[{]/.test(body.subarray(0, 64).toString('utf8'))
    return reply.code(upstream.status).header('content-type', looksJson ? JSON_TYPE : TEXT_TYPE).send(body)
  })
}
