import type { FastifyInstance } from 'fastify'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isSafeTileIconName } from '../config/schema.js'
import { detectImageType, safeBackgroundName, type ImageType } from '../backgrounds/routes.js'
import { tr } from '../i18n.js'

/**
 * The icons a user imports for their tiles' titles: their own marks, in their own installation.
 * Fremkit ships none. Kept apart from `<dataDir>/icons`, which the Dock and the app icons own.
 */
export const TILE_ICONS_DIR = 'tile-icons'

/** Largest decoded icon accepted, in bytes. An icon, not a photo. */
export const MAX_TILE_ICON_BYTES = 256 * 1024
/** Base64 inside JSON inflates by 4/3, so the body limit sits above the decoded one. */
export const MAX_TILE_ICON_BODY_BYTES = Math.ceil(MAX_TILE_ICON_BYTES * 4 / 3) + 4096

const SVG: ImageType = { ext: 'svg', contentType: 'image/svg+xml' }

/** A text whose root element, past a BOM, an XML prolog and comments, is `<svg`. */
function looksLikeSvg(text: string): boolean {
  const rest = text.replace(/^\uFEFF/, '').replace(/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*/, '')
  return /^<svg[\s>/]/i.test(rest)
}

/**
 * What would make an SVG do anything but draw: script, event handlers, embedded documents,
 * entities, and any reference that leaves the file. Internal `#id` references are what
 * gradients and clip paths are made of, so those stay.
 *
 * A refusal list, not a sanitiser: nothing is rewritten. The real defence is elsewhere — the host
 * only ever renders an icon as an `<img>` or a CSS mask, which run nothing, and the bytes are
 * served under a sandbox CSP — so this only keeps obviously hostile files out of the library.
 */
const ACTIVE_SVG = [
  /<\s*script\b/i,
  /[\s"'/]on[a-z]+\s*=/i,
  /<\s*foreignObject\b/i,
  /<\s*(?:iframe|embed|object)\b/i,
  /<!\s*(?:ENTITY|DOCTYPE)\b/i,
  /\bhref\s*=\s*(?![\s"']*#)/i,
  /url\(\s*(?![\s"']*#)/i,
  /@import\b/i,
]
export function svgHasActiveContent(text: string): boolean {
  return ACTIVE_SVG.some((re) => re.test(text))
}

/**
 * The type of an icon from its bytes, never from the name the client sent. JPEG is refused: it
 * has no alpha channel, so painted as a mask it would be a solid square.
 */
export function checkTileIcon(buf: Buffer): { ok: true; type: ImageType } | { ok: false; reason: 'unsupportedFormat' | 'activeSvg' } {
  const raster = detectImageType(buf)
  if (raster) return raster.ext === 'jpg' ? { ok: false, reason: 'unsupportedFormat' } : { ok: true, type: raster }
  const text = buf.toString('utf8')
  if (!looksLikeSvg(text)) return { ok: false, reason: 'unsupportedFormat' }
  if (svgHasActiveContent(text)) return { ok: false, reason: 'activeSvg' }
  return { ok: true, type: SVG }
}

/** Content type for a stored name, from its extension (which we chose). */
export function tileIconContentType(name: string): string {
  if (name.endsWith('.svg')) return SVG.contentType
  if (name.endsWith('.png')) return 'image/png'
  if (name.endsWith('.webp')) return 'image/webp'
  return 'application/octet-stream'
}

export async function tileIconRoutes(app: FastifyInstance, opts: { dataDir: string }): Promise<void> {
  const dir = join(opts.dataDir, TILE_ICONS_DIR)
  const pathOf = (name: string): string => join(dir, name)

  app.post<{ Body: { name?: unknown; data?: unknown } }>(
    '/api/tile-icons',
    { bodyLimit: MAX_TILE_ICON_BODY_BYTES },
    async (req, reply) => {
      const body = req.body ?? {}
      if (typeof body.data !== 'string') return reply.code(400).send({ error: tr(undefined, 'tileIcons.missingData') })
      const buf = Buffer.from(body.data, 'base64')
      if (!buf.length) return reply.code(400).send({ error: tr(undefined, 'tileIcons.empty') })
      if (buf.length > MAX_TILE_ICON_BYTES) return reply.code(413).send({ error: tr(undefined, 'tileIcons.tooLarge') })
      const checked = checkTileIcon(buf)
      if (!checked.ok) return reply.code(400).send({ error: tr(undefined, checked.reason === 'activeSvg' ? 'tileIcons.activeSvg' : 'tileIcons.unsupportedFormat') })

      const name = safeBackgroundName(body.name, checked.type)
      await mkdir(dir, { recursive: true })
      await writeFile(pathOf(name), buf)
      return reply.code(201).send({ name })
    },
  )

  app.get('/api/tile-icons', async () => {
    let names: string[] = []
    try { names = await readdir(dir) } catch { /* nothing imported yet */ }
    return { names: names.filter(isSafeTileIconName).sort() }
  })

  app.get<{ Params: { name: string } }>('/api/tile-icons/:name', async (req, reply) => {
    const { name } = req.params
    if (!isSafeTileIconName(name)) return reply.code(404).send({ error: tr(undefined, 'tileIcons.unknown') })
    let buf: Buffer
    try {
      buf = await readFile(pathOf(name))
    } catch {
      return reply.code(404).send({ error: tr(undefined, 'tileIcons.unknown') })
    }
    // The sandbox CSP and nosniff come from the byte-route hook in app.ts.
    return reply.type(tileIconContentType(name)).header('cache-control', 'public, max-age=31536000, immutable').send(buf)
  })

  app.delete<{ Params: { name: string } }>('/api/tile-icons/:name', async (req, reply) => {
    const { name } = req.params
    if (!isSafeTileIconName(name)) return reply.code(404).send({ error: tr(undefined, 'tileIcons.unknown') })
    try {
      await unlink(pathOf(name))
    } catch {
      return reply.code(404).send({ error: tr(undefined, 'tileIcons.unknown') })
    }
    return { ok: true }
  })
}
