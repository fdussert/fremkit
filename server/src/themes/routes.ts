import type { FastifyInstance } from 'fastify'
import type { ThemeCatalog } from './catalog.js'

/**
 * The catalog as the admin and the dashboard read it: the themes, and why a folder was refused.
 * Each theme carries the custom properties it resolves to — layered on the built-in theme here,
 * once, rather than in every client that has to paint them.
 */
const payload = (catalog: ThemeCatalog) => ({
  themes: Object.fromEntries([...catalog.themes].map(([id, theme]) => [id, { ...theme, variables: catalog.variables(id) }])),
  errors: catalog.errors,
})

export async function themeRoutes(app: FastifyInstance, opts: { catalog: ThemeCatalog }): Promise<void> {
  app.get('/api/themes', async () => payload(opts.catalog))

  app.post('/api/themes/rescan', async () => {
    await opts.catalog.scan()
    return payload(opts.catalog)
  })
}
