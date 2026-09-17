import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { CONNECTION_ID_RE, type Config, type Connection, type Locale } from '../config/schema.js'
import type { ConfigStore } from '../config/store.js'
import type { WidgetCatalog } from '../widgets/catalog.js'
import type { SecretStore } from '../secrets/index.js'
import type { ConnectionManager } from './manager.js'
import type { ConnectionTypeRegistry } from './registry.js'
import { OptionsError } from './types.js'
import { isOriginAllowed } from '../ws/routes.js'
import { tr } from '../i18n.js'

/** Ids the route table already spells: `/api/connections/types` must stay the type list. */
const RESERVED_IDS = new Set(['types'])

const usableId = (id: string): boolean => CONNECTION_ID_RE.test(id) && !RESERVED_IDS.has(id)

const BodySchema = z.object({
  type: z.string().min(1),
  name: z.string().min(1).optional(),
  fields: z.record(z.string(), z.string()).default({}),
  secrets: z.record(z.string(), z.string()).optional(),
})

const TestBodySchema = z.object({
  type: z.string().min(1).optional(),
  fields: z.record(z.string(), z.string()).optional(),
  secrets: z.record(z.string(), z.string()).optional(),
})

export interface ConnectionUse { page: string; instanceId: string; widgetId: string }

/** True when a stored setting value names the connection, whether it holds one id or a list. */
const namesConnection = (value: unknown, id: string): boolean =>
  value === id || (Array.isArray(value) && value.includes(id))

/**
 * Widgets that point at a connection id.
 *
 * A widget whose manifest declares a `connection` or `connections` setting is matched on those
 * settings only; for a widget the catalog does not know (folder removed, rescan pending) every
 * setting value is compared instead, so a stale instance still protects its connection from
 * being deleted.
 */
export function findConnectionUsers(config: Config, catalog: WidgetCatalog, id: string): ConnectionUse[] {
  const uses: ConnectionUse[] = []
  for (const page of config.pages) {
    for (const widget of page.widgets) {
      const manifest = catalog.get(widget.widgetId)
      const keys = manifest
        ? Object.entries(manifest.settingsSchema)
          .filter(([, f]) => f.type === 'connection' || f.type === 'connections')
          .map(([k]) => k)
        : Object.keys(widget.settings)
      if (keys.some((k) => namesConnection(widget.settings[k], id))) {
        uses.push({ page: page.name, instanceId: widget.instanceId, widgetId: widget.widgetId })
      }
    }
  }
  return uses
}

const mask = (connection: Connection, secretKeys: string[], stored: Set<string>): unknown => ({
  ...connection,
  secrets: Object.fromEntries(secretKeys.map((k) => [k, stored.has(k)])),
})

export async function connectionRoutes(
  app: FastifyInstance,
  opts: { store: ConfigStore; catalog: WidgetCatalog; types: ConnectionTypeRegistry; manager: ConnectionManager; secrets: SecretStore },
): Promise<void> {
  const { store, catalog, types, manager, secrets } = opts
  /** Read per request, not captured: the user can change the language while the server runs. */
  const locale = (): Locale => store.get().locale

  /**
   * Same rule as the WebSocket: a page on another origin must not drive the admin API. Reads stay
   * open (they carry no secret), and a client that sends no Origin at all — curl, a same-origin
   * fetch that omits it — is not a browser doing cross-site work, so it passes.
   */
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || isOriginAllowed(req.headers.origin)) return
    return reply.code(403).send({ error: tr(store.get().locale, 'connections.originNotAllowed') })
  })

  /** Which secret field keys currently have a value for this connection. */
  async function storedSecrets(connection: Connection): Promise<Set<string>> {
    const type = types.get(connection.type)
    if (!type) return new Set()
    const out = new Set<string>()
    for (const key of types.secretKeys(type)) {
      if ((await secrets.get(`${connection.id}/${key}`)) !== null) out.add(key)
    }
    return out
  }

  app.get('/api/connections/types', async () => types.describe(store.get().locale))

  app.get('/api/connections', async () => {
    const out: unknown[] = []
    for (const connection of store.get().connections) {
      const type = types.get(connection.type)
      out.push(mask(connection, type ? types.secretKeys(type) : [], await storedSecrets(connection)))
    }
    return out
  })

  app.put<{ Params: { id: string } }>('/api/connections/:id', async (req, reply) => {
    const { id } = req.params
    if (!usableId(id)) return reply.code(400).send({ errors: [tr(locale(), 'connections.invalidId', { id })] })

    const parsed = BodySchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })

    const type = types.get(parsed.data.type)
    if (!type) return reply.code(400).send({ errors: [tr(locale(), 'connections.unknownType', { type: parsed.data.type })] })

    const existing = store.get().connections.find((c) => c.id === id)
    // Retyping an id in place would orphan the old type's secrets under the same id; the user
    // deletes the connection (which forgets them) and recreates it instead.
    if (existing && existing.type !== parsed.data.type) {
      return reply.code(400).send({ errors: [tr(locale(), 'connections.typeImmutable')] })
    }
    const stored = existing ? await storedSecrets(existing) : new Set<string>()
    const submitted = parsed.data.secrets ?? {}
    // An empty string means "forget this secret", so it must not count as stored for validation.
    const willHave = (key: string): boolean => (key in submitted ? submitted[key] !== '' : stored.has(key))

    const errors = [
      ...types.validate(type, parsed.data.fields, submitted, willHave, locale()),
      // A secret stored for the old host must not be handed to a new one on the next poll.
      ...types.bindingErrors(type, parsed.data.fields, submitted, existing, (key) => stored.has(key), locale()),
    ]
    if (errors.length) return reply.code(400).send({ errors })

    const connection: Connection = { id, type: parsed.data.type, name: parsed.data.name ?? existing?.name ?? id, fields: parsed.data.fields }
    // The config goes first: a connection listed without its secret is a form the user finishes
    // filling in, whereas a secret stored under an id no config mentions is an orphan nobody can
    // see or clear. If the secret write then fails the config keeps the connection and we answer
    // 500, so the admin retries the same PUT.
    const next = await store.update((config) => {
      const at = config.connections.findIndex((c) => c.id === id)
      if (at >= 0) config.connections[at] = connection
      else config.connections.push(connection)
      return config
    })

    try {
      for (const [key, value] of Object.entries(submitted)) {
        if (value === '') await secrets.delete(`${id}/${key}`)
        else await secrets.set(`${id}/${key}`, value)
      }
    } catch (err) {
      req.log.warn({ err }, 'secret write failed')
      return reply.code(500).send({ errors: [tr(locale(), 'connections.secretWriteFailed')] })
    }
    await manager.sync(next.connections)

    return mask(connection, types.secretKeys(type), await storedSecrets(connection))
  })

  app.delete<{ Params: { id: string } }>('/api/connections/:id', async (req, reply) => {
    const { id } = req.params
    if (!usableId(id)) return reply.code(400).send({ errors: [tr(locale(), 'connections.invalidId', { id })] })
    const config = store.get()
    const connection = config.connections.find((c) => c.id === id)
    if (!connection) return reply.code(404).send({ error: tr(config.locale, 'connections.unknown') })

    const uses = findConnectionUsers(config, catalog, id)
    if (uses.length) {
      const list = uses.map((u) => tr(config.locale, 'connections.usedByEntry', { widgetId: u.widgetId, page: u.page })).join(', ')
      return reply.code(409).send({ error: tr(config.locale, 'connections.usedBy', { list }) })
    }

    // Config first here too: the connection stops being offered before its secrets go, so a
    // failure halfway leaves unreachable secrets rather than a connection that cannot authenticate.
    const next = await store.update((c) => ({ ...c, connections: c.connections.filter((x) => x.id !== id) }))
    await manager.forget(connection)
    await manager.sync(next.connections)
    return reply.code(204).send()
  })

  /**
   * The choices a widget's `pick` setting offers, read live from the device behind the connection
   * — the devices of a Homey, its flows. A read, so the origin hook lets it through; nothing of
   * the connection's secrets reaches the answer, not even inside an error message.
   */
  app.get<{ Params: { id: string }; Querystring: { source?: string } }>('/api/connections/:id/options', async (req, reply) => {
    const config = store.get()
    const connection = config.connections.find((c) => c.id === req.params.id)
    if (!connection) return reply.code(404).send({ error: tr(config.locale, 'connections.unknown') })

    const type = types.get(connection.type)
    if (!type?.options) return reply.code(400).send({ error: tr(config.locale, 'connections.noOptions', { type: connection.type }) })

    const source = String(req.query.source ?? '')
    if (!source) return reply.code(400).send({ error: tr(config.locale, 'connections.unknownSource', { source }) })

    try {
      return await type.options(source, connection.fields, await manager.secretsFor(connection))
    } catch (err) {
      if (err instanceof OptionsError) return reply.code(err.status).send({ error: err.message })
      // Never the raw error: it can quote a URL, and a type may have put a token in it.
      req.log.warn({ type: type.id }, 'connection options failed')
      return reply.code(502).send({ error: tr(config.locale, 'connections.optionsFailed') })
    }
  })

  app.post<{ Params: { id: string } }>('/api/connections/:id/test', async (req, reply) => {
    const parsed = TestBodySchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })

    const existing = store.get().connections.find((c) => c.id === req.params.id)
    const typeId = parsed.data.type ?? existing?.type
    if (!typeId) return reply.code(404).send({ error: tr(locale(), 'connections.unknown') })
    const type = types.get(typeId)
    if (!type) return reply.code(400).send({ errors: [tr(locale(), 'connections.unknownType', { type: typeId })] })

    // The admin tests a form that is not saved yet, so submitted values win over stored ones.
    const fields = parsed.data.fields ?? existing?.fields ?? {}
    const submitted = parsed.data.secrets ?? {}
    // Stored secrets belong to the stored type. Testing this id *as another type* must not hand
    // that type's `test()` a PAT it was never given, so the merge starts empty.
    const bound = existing && existing.type === type.id ? existing : undefined
    const stored = bound ? await manager.secretsFor(bound) : {}
    const merged = { ...stored, ...submitted }

    // Same checks as the PUT: an unknown or missing field is a form mistake to report, not
    // something to hand to a type that would turn it into a confusing network error. The binding
    // check matters most here — a test is the one call that sends the merged secret straight to
    // whatever host the caller wrote in the body.
    const errors = [
      ...types.validate(type, fields, submitted, (key) => Boolean(merged[key]), locale()),
      ...types.bindingErrors(type, fields, submitted, bound, (key) => key in stored, locale()),
    ]
    if (errors.length) return reply.code(400).send({ errors })

    try {
      return await type.test(fields, merged)
    } catch (err) {
      // Never the raw error: a type may have put a URL with credentials in it.
      req.log.warn({ type: type.id }, 'connection test failed')
      return { ok: false, error: tr(locale(), 'connections.testFailed', { name: (err as Error).name }) }
    }
  })
}
