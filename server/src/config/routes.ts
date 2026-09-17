import type { FastifyInstance } from 'fastify'
import { ConfigSchema, validateConnections, validateLayout, validateNavWidgets } from './schema.js'
import type { ConfigStore } from './store.js'
import type { WidgetCatalog } from '../widgets/catalog.js'
import { tr, type Locale } from '../i18n.js'

/** Shown to the user, and the reason every save is refused, while the store runs degraded. */
export const degradedMessage = (locale?: Locale): string => tr(locale, 'config.degraded')

export async function configRoutes(app: FastifyInstance, opts: { store: ConfigStore; catalog: WidgetCatalog }): Promise<void> {
  app.get('/api/config', async (_req, reply) => {
    // Header for anything reading the config itself; /api/config/status is what the admin polls.
    if (opts.store.degraded) reply.header('X-Fremkit-Degraded', '1')
    return opts.store.get()
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
    // Connections and the secrets backend do not change through here. /api/config carries them
    // so the admin can read and write one config object, but a save only ever replays what the
    // connections API already stored. Otherwise a single PUT could point an existing connection
    // at another host — the manager would rebuild its provider with the *stored* secret and the
    // *new* fields, handing the token to that host — or move the secrets backend, with none of
    // the per-type validation and secret-binding checks connections/routes.ts runs.
    const current = opts.store.get()
    parsed.data.connections = current.connections
    parsed.data.secrets = current.secrets

    const errors = [
      ...validateLayout(parsed.data, opts.catalog.manifests),
      ...validateNavWidgets(parsed.data, opts.catalog.manifests),
      ...validateConnections(parsed.data),
    ]
    if (errors.length) return reply.code(400).send({ errors })
    return opts.store.save(parsed.data)
  })
}
