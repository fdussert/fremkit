import type { FastifyInstance } from 'fastify'
import { isLoopbackAddress } from '../net/loopback.js'
import { tr } from '../i18n.js'
import { summarize, type InstalledApps } from './installed.js'

/**
 * `GET /api/apps/installed` — the applications installed on this machine.
 *
 * Loopback only, like everything the helper and the dashboard share, and without the filesystem
 * path of each bundle: the admin offers the names as suggestions and the widgets match on them,
 * neither needs to know where the application lives.
 */
export async function appsRoutes(app: FastifyInstance, opts: { apps: InstalledApps }): Promise<void> {
  app.get('/api/apps/installed', async (req, reply) => {
    if (!isLoopbackAddress(req.ip)) return reply.code(403).send({ error: tr(undefined, 'dock.notLocal') })
    const list = await opts.apps.list()
    // The scan is already cached for ten minutes; this only keeps the admin from re-asking per keystroke.
    return reply.header('cache-control', 'private, max-age=60').send(list.map(summarize))
  })
}
