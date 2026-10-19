import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Config } from '../config/schema.js'
import { isLocalRequest } from '../net/remote.js'
import type { ThemeCatalog } from './catalog.js'
import { deviceThemeView, themeInForce } from './schedule.js'

/**
 * The catalog as the admin and the dashboard read it: the themes, and why a folder was refused.
 * Each theme carries the custom properties it resolves to — layered on the built-in theme here,
 * once, rather than in every client that has to paint them.
 *
 * `inForce` is the theme the `theme` channel would say now (`schedule.ts`). A page paints only
 * once it has the catalog, so carrying it here means the first paint is already the night theme
 * at night, rather than the day's until the socket catches up. A paired device gets it as the
 * `theme` channel gives it to them (`deviceThemeView`): without the time of the next switch.
 */
const payload = (catalog: ThemeCatalog, config?: () => Config, req?: FastifyRequest) => {
  const inForce = config ? themeInForce(config(), Date.now()) : undefined
  return {
    themes: Object.fromEntries([...catalog.themes].map(([id, theme]) => [id, { ...theme, variables: catalog.variables(id) }])),
    errors: catalog.errors,
    ...(inForce ? { inForce: req && !isLocalRequest(req) ? deviceThemeView(inForce) : inForce } : {}),
  }
}

export async function themeRoutes(app: FastifyInstance, opts: { catalog: ThemeCatalog; config?: () => Config }): Promise<void> {
  app.get('/api/themes', async (req) => payload(opts.catalog, opts.config, req))

  app.post('/api/themes/rescan', async () => {
    await opts.catalog.scan()
    return payload(opts.catalog, opts.config)
  })
}
