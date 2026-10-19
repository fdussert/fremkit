import type { FastifyInstance } from 'fastify'
import { isLocalRequest, pairedDeviceOf } from '../net/remote.js'
import { tr } from '../i18n.js'
import { summarize, type InstalledApps } from './installed.js'

/**
 * `GET /api/apps/installed` — the applications installed on this machine.
 *
 * For local requests, and a paired device whose screen shows a widget that may read it,
 * and without the filesystem path of each bundle: the admin offers the names as suggestions and the widgets match on them,
 * neither needs to know where the application lives.
 */
export async function appsRoutes(
  app: FastifyInstance,
  opts: { apps: InstalledApps; deviceMayListApps?: (deviceId: string) => boolean },
): Promise<void> {
  app.get('/api/apps/installed', async (req, reply) => {
    const deviceId = pairedDeviceOf(req)
    // A paired device only while its own screen shows a widget the host would hand the list to:
    // the bridge gives it to a widget that subscribes to `dock` (`mayListApps`), which is how the
    // shortcuts widget draws an application's real icon. A device with no such widget, or no
    // screen, has no use for the list of what is installed on this Mac.
    const device = deviceId !== null && (opts.deviceMayListApps?.(deviceId) ?? false)
    if (!isLocalRequest(req) && !device) return reply.code(403).send({ error: tr(undefined, 'dock.notLocal') })
    const list = await opts.apps.list()
    // The scan is already cached for ten minutes; this only keeps the admin from re-asking per keystroke.
    return reply.header('cache-control', 'private, max-age=60').send(list.map(summarize))
  })
}
