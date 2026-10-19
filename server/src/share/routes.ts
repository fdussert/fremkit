import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { isLocalRequest } from '../net/remote.js'
import { tr } from '../i18n.js'
import { buildLayout, ShareRequestError, type ShareDeps } from './export.js'
import { readLayout, LayoutError } from './import.js'
import { LayoutScopeSchema, MAX_LAYOUT_BODY_BYTES } from './format.js'

/**
 * Sharing a layout: a page, a screen or every screen as a `.fremkit-layout.json`.
 *
 * - `POST /api/share/export` builds the file and answers it with the report the preview shows —
 *   images by size, not by bytes, so the preview stays light.
 * - `GET /api/share/export?scope=…` answers the same file as an attachment: what the browser and
 *   the helper's admin window (a WKWebView, see `AdminWindow.swift`) both save as a download,
 *   exactly as the backup is.
 * - `POST /api/share/import` reads a file somebody else wrote and answers what may be applied, and
 *   what the admin has to ask about. Nothing is written: the admin applies it as one edit, through
 *   its store, so it is one undo step and saved like any other.
 *
 * Local only, twice over, like the diagnostics: the remote listener's allow-list names none of
 * these, and each handler checks `isLocalRequest` itself.
 */

const ExportQuerySchema = z.object({
  scope: LayoutScopeSchema,
  screen: z.string().max(64).optional(),
  page: z.string().max(200).optional(),
  /** Ticked free-text settings, `<instanceId>:<key>`, as an array (POST) or comma-separated (GET). */
  include: z.union([z.array(z.string().max(200)).max(500), z.string().max(20000)]).optional(),
})

export async function shareRoutes(app: FastifyInstance, opts: { deps: ShareDeps }): Promise<void> {
  const { deps } = opts
  const locale = () => deps.config().locale

  const build = async (raw: unknown, reply: FastifyReply) => {
    const parsed = ExportQuerySchema.safeParse(raw)
    if (!parsed.success) { void reply.code(400).send({ error: tr(locale(), 'share.badRequest') }); return null }
    const { scope, screen, page, include } = parsed.data
    const list = typeof include === 'string' ? include.split(',').filter(Boolean) : include
    try {
      return await buildLayout(deps, { scope, screenId: screen, pageId: page, include: list })
    } catch (err) {
      if (err instanceof ShareRequestError) { void reply.code(404).send({ error: err.message }); return null }
      throw err
    }
  }

  app.post('/api/share/export', async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(404).send()
    const built = await build(req.body ?? {}, reply)
    if (!built) return reply
    const images = Object.fromEntries(Object.entries(built.file.images)
      .map(([k, v]) => [k, 'data' in v ? { bytes: Math.floor(v.data.length * 3 / 4) } : v]))
    return reply.header('cache-control', 'no-store').send({
      file: { ...built.file, images }, filename: built.filename, report: built.report,
    })
  })

  app.get('/api/share/export', async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(404).send()
    const built = await build(req.query ?? {}, reply)
    if (!built) return reply
    return reply
      .header('cache-control', 'no-store')
      .header('content-disposition', `attachment; filename="${built.filename}"`)
      .type('application/json; charset=utf-8')
      .send(JSON.stringify(built.file, null, 2))
  })

  app.post('/api/share/import', { bodyLimit: MAX_LAYOUT_BODY_BYTES }, async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(404).send()
    try {
      return reply.header('cache-control', 'no-store').send(readLayout(req.body, deps))
    } catch (err) {
      if (err instanceof LayoutError) return reply.code(400).send({ error: err.message })
      throw err
    }
  })
}
