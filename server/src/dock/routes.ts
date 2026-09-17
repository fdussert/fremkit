import type { FastifyInstance, FastifyRequest } from 'fastify'
import { BUNDLE_ID_RE, isPng, MAX_ICON_BYTES, MAX_ICONS, type DockState } from './state.js'
import { isLoopbackAddress } from '../net/loopback.js'
import { tr } from '../i18n.js'

/**
 * Twice the base64 of the largest accepted PNG, plus the small JSON envelope around it: an icon
 * that is merely too big still reaches the handler, which answers a readable 400 instead of the
 * bare 413 Fastify raises when the body itself is refused.
 */
const BODY_LIMIT = Math.ceil(MAX_ICON_BYTES * 4 / 3) * 2 + 4096

/** The helper runs on this machine; nothing else has any business posting Dock state. */
export function isLocalRequest(req: FastifyRequest): boolean {
  return isLoopbackAddress(req.ip)
}

/** Extracts an icon from an installed bundle; the icon route falls back to it. See `apps/icons.ts`. */
export interface AppIconSource { get(bundleId: string): Promise<Buffer | null> }

export async function dockRoutes(app: FastifyInstance, opts: { state: DockState; appIcons?: AppIconSource }): Promise<void> {
  const local = async (req: FastifyRequest, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): Promise<boolean> => {
    if (isLocalRequest(req)) return true
    reply.code(403).send({ error: tr(undefined, 'dock.notLocal') })
    return false
  }

  app.post('/api/hooks/dock', { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    if (!(await local(req, reply))) return
    const apps = (req.body as { apps?: unknown } | null)?.apps
    if (!Array.isArray(apps)) return reply.code(400).send({ error: 'charge utile invalide' })
    opts.state.update(apps)
    return reply.code(204).send()
  })

  app.post('/api/hooks/dock/icon', { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    if (!(await local(req, reply))) return
    const body = (req.body ?? {}) as { bundleId?: unknown; png?: unknown }
    if (typeof body.bundleId !== 'string' || !BUNDLE_ID_RE.test(body.bundleId)) {
      return reply.code(400).send({ error: 'identifiant de bundle invalide' })
    }
    if (typeof body.png !== 'string') return reply.code(400).send({ error: 'image manquante' })
    const png = Buffer.from(body.png, 'base64')
    if (png.byteLength > MAX_ICON_BYTES) return reply.code(400).send({ error: 'image trop grande' })
    if (!isPng(png)) return reply.code(400).send({ error: 'image invalide' })
    if (!(await opts.state.setIcon(body.bundleId, png))) {
      // Full: the icon is dropped rather than evicting one the dashboard is drawing right now.
      req.log.warn({ bundleId: body.bundleId, max: MAX_ICONS }, 'dock icon ignored: cache full')
      return reply.code(200).send({ ignored: true, reason: tr(undefined, 'dock.iconCacheFull') })
    }
    return reply.code(204).send()
  })

  app.get<{ Params: { bundleId: string } }>('/api/apps/icon/:bundleId', async (req, reply) => {
    const { bundleId } = req.params
    if (!BUNDLE_ID_RE.test(bundleId)) return reply.code(400).send({ error: 'identifiant de bundle invalide' })
    // The helper uploads one icon per Dock slot; an application that is merely installed — the
    // target of a shortcut button, say — gets its icon extracted from the bundle instead.
    const png = (await opts.state.getIcon(bundleId)) ?? (await opts.appIcons?.get(bundleId).catch(() => null) ?? null)
    if (!png) return reply.code(404).send({ error: tr(undefined, 'dock.unknownIcon') })
    // Short enough that a reinstalled app's new icon shows up on its own, long enough to keep
    // the row from re-fetching every frame.
    return reply.type('image/png').header('cache-control', 'public, max-age=60').send(png)
  })
}
