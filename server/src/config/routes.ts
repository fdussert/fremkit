import type { FastifyInstance } from 'fastify'
import { ConfigSchema, validateConnections, validateLayout, validateNavWidgets } from './schema.js'
import type { ConfigStore } from './store.js'
import type { WidgetCatalog } from '../widgets/catalog.js'
import { tr, type Locale } from '../i18n.js'
import { configForScope, requestScope, type ScreenOfDevice } from '../devices/scope.js'

/** Shown to the user, and the reason every save is refused, while the store runs degraded. */
export const degradedMessage = (locale?: Locale): string => tr(locale, 'config.degraded')

export async function configRoutes(
  app: FastifyInstance,
  opts: { store: ConfigStore; catalog: WidgetCatalog; screenOfDevice?: ScreenOfDevice },
): Promise<void> {
  const screenOfDevice: ScreenOfDevice = opts.screenOfDevice ?? (() => null)
  app.get('/api/config', async (req, reply) => {
    // Header for anything reading the config itself; /api/config/status is what the admin polls.
    if (opts.store.degraded) reply.header('X-Fremkit-Degraded', '1')
    // A paired device reads its own screen and what drawing it takes, nothing else of the Mac's
    // config: see `deviceConfigView`.
    return configForScope(opts.store.get(), requestScope(req, screenOfDevice))
  })

  app.get('/api/config/status', async () => ({ degraded: opts.store.degraded }))

  app.put('/api/config', async (req, reply) => {
    // The in-memory config is the default one, not the user's: saving it would overwrite
    // a layout we simply failed to read. Refuse until a successful load clears the flag.
    // A degraded store serves the default config, so its locale is the machine's, not the user's;
    // that is the best guess available while their own file cannot be read.
    if (opts.store.degraded) return reply.code(409).send({ errors: [degradedMessage(opts.store.get().locale)] })
    const parsed = ConfigSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
    }
    // Connections, the secrets backend and the marketplace's consent records do not change
    // through here. /api/config carries them
    // so the admin can read and write one config object, but a save only ever replays what the
    // connections API already stored. Otherwise a single PUT could point an existing connection
    // at another host — the manager would rebuild its provider with the *stored* secret and the
    // *new* fields, handing the token to that host — or move the secrets backend, with none of
    // the per-type validation and secret-binding checks connections/routes.ts runs.
    const current = opts.store.get()
    parsed.data.connections = current.connections
    parsed.data.secrets = current.secrets
    // Consent records and shares change only through the marketplace routes, which show the user
    // what is granted. A stale admin tab saving an old copy must not bring back a revoked share
    // or a consent the user withdrew, and a PUT must not forge one.
    parsed.data.marketplace = { ...parsed.data.marketplace, installed: current.marketplace.installed }
    // A body without `labs` keeps the switch as it is: the schema's default would turn the
    // experimental features off behind the user's back for any client that does not send it.
    const body = req.body as { labs?: { devices?: unknown; companion?: unknown } } | null
    if (typeof body?.labs?.devices !== 'boolean') parsed.data.labs = { ...parsed.data.labs, devices: current.labs.devices }
    if (typeof body?.labs?.companion !== 'boolean') parsed.data.labs = { ...parsed.data.labs, companion: current.labs.companion }

    const errors = [
      ...validateLayout(parsed.data, opts.catalog.manifests),
      // `current` lets a bar already over the limit through an unrelated save.
      ...validateNavWidgets(parsed.data, opts.catalog.manifests, current),
      ...validateConnections(parsed.data),
    ]
    if (errors.length) return reply.code(400).send({ errors })
    return opts.store.save(parsed.data)
  })
}
