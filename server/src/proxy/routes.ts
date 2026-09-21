import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { WidgetCatalog } from '../widgets/catalog.js'
import type { ConnectionDecl } from '../widgets/manifest.js'
import type { ConfigStore } from '../config/store.js'
import type { SecretStore } from '../secrets/types.js'
import { grantedFor } from '../marketplace/consent.js'
import { resolvesToPrivate } from '../net/private.js'
import { isCrossSiteFetch } from '../http/guard.js'
import { findInstance } from '../config/instances.js'
import { authFor, declaredTypeId, isDeclaredType, originOf, parseDeclaredHost, secretField, slugText } from '../connections/declared.js'
import { ConnCache, allowedRequest, checkHeaders, checkPath } from './conn.js'
import { tr } from '../i18n.js'
import { WIDGET_ID_RE, type Config } from '../config/schema.js'

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

/**
 * What a widget asks the proxy to do on its connection's behalf.
 *
 * `instanceId` rather than a connection id: the widget names *itself*, and the server resolves
 * which connection that instance is bound to. A widget that could name a connection could name
 * somebody else's.
 */
const ConnBody = z.object({
  instanceId: z.string().min(1).max(64),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(1).max(2000),
  body: z.string().max(256 * 1024).optional(),
  headers: z.record(z.string().max(64), z.string().max(200)).optional(),
})

/** How long a declared request may take. Longer than the proxy's: a LAN device can be slow. */
const CONN_TIMEOUT_MS = 15_000
/** A declared connection answers with data, not with documents. */
const CONN_MAX_BODY_BYTES = 2 * 1024 * 1024

export interface ProxyOptions {
  catalog: WidgetCatalog
  /** Read for the consent records: what an installed widget may reach is a config fact. */
  store: ConfigStore
  /**
   * Whether a host is private or local. Production uses `resolvesToPrivate`; the proxy's own
   * tests put their upstream on loopback and stand in for a public host here.
   */
  isPrivate?: (host: string) => Promise<boolean>
  /** Where a declared connection's secret is read from. Absent in the tests that never use one. */
  secrets?: SecretStore
  /** Only ever passed by the tests; production uses the global `fetch`. */
  fetch?: typeof fetch
  /** Only ever passed by the tests, to make a cache expiry happen without waiting for it. */
  now?: () => number
  /**
   * The cache of declared-connection reads.
   *
   * Owned by the caller, because the routes that *invalidate* it — a connection saved or
   * deleted, a share revoked — are in other files. A cache only this file could reach would be
   * a cache nothing could clear, which is how a revoked widget goes on being served the answers
   * it was granted before.
   */
  cache?: ConnCache
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
  const readCapped = async (res: Response, max = MAX_BODY_BYTES): Promise<Buffer | null> => {
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > max) { void res.body?.cancel().catch(() => {}); return null }
    const reader = res.body?.getReader()
    if (!reader) {
      const buffer = Buffer.from(await res.arrayBuffer())
      return buffer.byteLength > max ? null : buffer
    }
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > max) { void reader.cancel().catch(() => {}); return null }
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

  const cache = opts.cache ?? new ConnCache(opts.now)

  /**
   * `POST /api/proxy/:widgetId/conn` — one request on a declared connection.
   *
   * The whole of the declared-connection promise is in this handler: the widget names a path, the
   * server decides whether that path is one the user agreed to, adds the secret, and hands back
   * the answer. The widget never holds the credential and can never see it — not in a response,
   * not in an error, not in a log line.
   *
   * Order matters and is deliberate. Everything that can be refused without touching the network
   * is refused first: the origin, the body's shape, the path's shape, the grant, the instance,
   * the connection, then the allow-list. Only then is the secret read, and only then is a request
   * made.
   */
  app.post<{ Params: { widgetId: string } }>('/api/proxy/:widgetId/conn', async (req, reply) => {
    if (isCrossSiteFetch(req.headers)) return reply.code(403).send({ error: tr(undefined, 'http.originNotAllowed') })
    const widgetId = req.params.widgetId
    if (!WIDGET_ID_RE.test(widgetId)) return reply.code(404).send({ error: tr(undefined, 'widgets.unknown') })

    const parsed = ConnBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: tr(undefined, 'proxy.badRequest') })
    const { instanceId, method, body: sent } = parsed.data

    // Refused before it is matched against anything: see `checkPath`.
    const path = checkPath(parsed.data.path)
    if (path === null) return reply.code(400).send({ error: tr(undefined, 'proxy.badPath') })

    const headers = checkHeaders(parsed.data.headers)
    if (headers === null) return reply.code(403).send({ error: tr(undefined, 'proxy.headerNotAllowed') })

    const config = opts.store.get()
    // Granted, not declared. A widget that rewrote its own manifest reaches nothing.
    const manifest = grantedFor(opts.catalog, config, widgetId)
    if (!manifest) return reply.code(404).send({ error: tr(undefined, 'widgets.unknown') })
    const decl = manifest.connection
    if (!decl) return reply.code(403).send({ error: tr(undefined, 'proxy.noDeclaration') })

    // The instance has to be one of this widget's: an instance id is not a capability, and a
    // widget asking on behalf of another one is asking for somebody else's connection.
    const instance = findInstance(config, instanceId)
    if (!instance || instance.widgetId !== widgetId) {
      return reply.code(404).send({ error: tr(undefined, 'proxy.unknownInstance') })
    }

    const connection = connectionFor(config, instance.settings, widgetId, decl,
      config.marketplace.installed[widgetId]?.sharedConnections ?? [])
    if (!connection) return reply.code(409).send({ error: tr(undefined, 'proxy.unconfigured') })

    const allowed = allowedRequest(decl, { method, path })
    if (!allowed) {
      // Names the rule that was broken, never the secret and never the host.
      return reply.code(403).send({ error: tr(undefined, 'proxy.requestNotDeclared', { method, path }) })
    }

    // The one field the user types and the widget writes the label for. Not a host means no
    // request at all: see `parseDeclaredHost`.
    const host = parseDeclaredHost(connection.fields.host ?? '')
    if (!host) return reply.code(409).send({ error: tr(undefined, 'proxy.badHost') })

    const cacheMs = method === 'GET' ? (allowed.cacheMs ?? 0) : 0
    if (cacheMs > 0) {
      const hit = cache.get(connection.id, path, cacheMs)
      if (hit) {
        return reply.code(hit.status)
          .header('content-type', hit.json ? JSON_TYPE : TEXT_TYPE)
          .header('x-fremkit-cache', 'hit')
          .send(hit.body)
      }
    }

    const key = secretField(decl)
    const secret = key && opts.secrets ? ((await opts.secrets.get(`${connection.id}/${key}`)) ?? '') : ''
    const auth = authFor(decl, connection.fields, key ? { [key]: secret } : {})

    let url: URL
    try { url = new URL(originOf(decl, host) + path) }
    catch { return reply.code(409).send({ error: tr(undefined, 'proxy.unconfigured') }) }
    for (const [name, value] of Object.entries(auth.query)) url.searchParams.set(name, value)

    const doFetch = opts.fetch ?? fetch
    let upstream: Response
    try {
      upstream = await doFetch(url, {
        method,
        headers: { ...headers, ...auth.headers },
        ...(sent !== undefined && method !== 'GET' ? { body: sent } : {}),
        // A 3xx is an error, not a hop. The secret is bound to the host the user typed, and
        // following a redirect is exactly how it would reach one they did not.
        redirect: 'manual',
        signal: AbortSignal.timeout(CONN_TIMEOUT_MS),
      })
    } catch (err) {
      // The name of the error and nothing else: the message quotes the URL, and the URL may hold
      // the key when the declaration puts it in the query string.
      req.log.warn({ widgetId, name: (err as Error).name }, 'declared connection request failed')
      return reply.code(502).send({ error: tr(undefined, 'proxy.upstreamFailed') })
    }

    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      void upstream.body?.cancel().catch(() => {})
      return reply.code(502).send({ error: tr(undefined, 'proxy.redirectRefused') })
    }

    let answer: Buffer | null
    try { answer = await readCapped(upstream, CONN_MAX_BODY_BYTES) } catch { answer = null }
    if (answer === null) return reply.code(502).send({ error: tr(undefined, 'proxy.tooLarge') })

    const json = /^[\s﻿]*[[{]/.test(answer.subarray(0, 64).toString('utf8'))
    // A write invalidates what this connection cached: the next read must see what it just did.
    if (method !== 'GET') cache.forget(connection.id)
    else if (cacheMs > 0) cache.put(connection.id, path, { status: upstream.status, body: answer, json })

    return reply.code(upstream.status).header('content-type', json ? JSON_TYPE : TEXT_TYPE).send(answer)
  })
}

/**
 * The connection an instance is bound to, for a widget's declared type.
 *
 * Found through the instance's own settings: the widget declares a `connection` setting whose
 * `connectionType` is its declared type, and the value is the connection's id. A setting naming
 * a connection of a *coded* type is ignored rather than followed — that is how a declared widget
 * would otherwise reach a Synology's password.
 *
 * `shared` is the exception, and it is a grant: another widget's declared connection, listed on
 * this widget's consent record because the user accepted "reuse this one?". It still has to be
 * a declared type — never a coded one — so sharing can only ever widen a widget's reach to
 * something of exactly the kind it could have asked the user to create itself.
 */
function connectionFor(
  config: Config,
  settings: Record<string, unknown>,
  widgetId: string,
  decl: ConnectionDecl,
  shared: string[],
): { id: string; fields: Record<string, string> } | undefined {
  const typeId = declaredTypeId(widgetId, slugText(decl.name))
  const allowedShared = new Set(shared)
  const ids = Object.values(settings).filter((v): v is string => typeof v === 'string')
  for (const id of ids) {
    const found = config.connections.find((c) => c.id === id)
    if (!found) continue
    if (found.type === typeId) return { id: found.id, fields: found.fields }
    if (allowedShared.has(found.id) && isDeclaredType(found.type)) {
      return { id: found.id, fields: found.fields }
    }
  }
  return undefined
}
