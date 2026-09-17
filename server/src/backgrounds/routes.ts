import type { FastifyInstance } from 'fastify'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isSafeBackgroundName } from '../config/schema.js'
import { tr } from '../i18n.js'

/** Largest decoded image accepted, in bytes. */
export const MAX_BACKGROUND_BYTES = 10 * 1024 * 1024
/**
 * Body limit for the upload route. Uploads arrive as base64 inside a JSON body (no multipart
 * dependency), which inflates them by 4/3, so the raw limit has to sit above the decoded one.
 */
export const MAX_BACKGROUND_BODY_BYTES = Math.ceil(MAX_BACKGROUND_BYTES * 4 / 3) + 4096

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG = [0xff, 0xd8, 0xff]

export interface ImageType { ext: string; contentType: string }

const TYPES: Record<string, ImageType> = {
  png: { ext: 'png', contentType: 'image/png' },
  jpeg: { ext: 'jpg', contentType: 'image/jpeg' },
  webp: { ext: 'webp', contentType: 'image/webp' },
}

const startsWith = (buf: Buffer, bytes: number[]): boolean =>
  buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b)

/**
 * Identifies the image from its magic bytes, never from the name the client sent: the
 * extension we store — and the content type we later serve — has to describe the real bytes.
 */
export function detectImageType(buf: Buffer): ImageType | null {
  if (startsWith(buf, PNG)) return TYPES.png
  if (startsWith(buf, JPEG)) return TYPES.jpeg
  // RIFF <4-byte size> WEBP
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return TYPES.webp
  return null
}

/** Content type for a stored name, derived from its extension (which we control). */
export function contentTypeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return Object.values(TYPES).find((t) => t.ext === ext)?.contentType ?? 'application/octet-stream'
}

/**
 * Turns whatever the browser reported into a name that is safe to join onto a directory:
 * the stem keeps only `[A-Za-z0-9._-]`, the extension comes from the detected type, and a
 * timestamp prefix keeps two uploads of "photo.jpg" apart.
 */
export function safeBackgroundName(raw: unknown, type: ImageType, now: number = Date.now()): string {
  const base = typeof raw === 'string' ? raw.split(/[\\/]/).pop() ?? '' : ''
  const stem = base
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/\.+/g, '.')
    .replace(/^[.-]+/, '')
    .slice(0, 60)
  return `${now}-${stem || 'image'}.${type.ext}`
}

export async function backgroundRoutes(app: FastifyInstance, opts: { dataDir: string }): Promise<void> {
  const dir = join(opts.dataDir, 'backgrounds')
  const pathOf = (name: string): string => join(dir, name)

  app.post<{ Body: { name?: unknown; data?: unknown } }>(
    '/api/backgrounds',
    { bodyLimit: MAX_BACKGROUND_BODY_BYTES },
    async (req, reply) => {
      const body = req.body ?? {}
      if (typeof body.data !== 'string') return reply.code(400).send({ error: tr(undefined, 'backgrounds.missingData') })
      // Buffer.from skips whatever is not base64, so a garbage payload simply decodes to
      // bytes that fail the magic-byte check below rather than being rejected here.
      const buf = Buffer.from(body.data, 'base64')
      if (!buf.length) return reply.code(400).send({ error: tr(undefined, 'backgrounds.emptyImage') })
      if (buf.length > MAX_BACKGROUND_BYTES) return reply.code(413).send({ error: 'image trop grande (10 Mo maximum)' })
      const type = detectImageType(buf)
      if (!type) return reply.code(400).send({ error: tr(undefined, 'backgrounds.unsupportedFormat') })

      const name = safeBackgroundName(body.name, type)
      await mkdir(dir, { recursive: true })
      await writeFile(pathOf(name), buf)
      return reply.code(201).send({ name })
    },
  )

  app.get<{ Params: { name: string } }>('/api/backgrounds/:name', async (req, reply) => {
    const { name } = req.params
    if (!isSafeBackgroundName(name)) return reply.code(404).send({ error: tr(undefined, 'backgrounds.unknownImage') })
    let buf: Buffer
    try {
      buf = await readFile(pathOf(name))
    } catch {
      return reply.code(404).send({ error: tr(undefined, 'backgrounds.unknownImage') })
    }
    return reply.type(contentTypeFor(name)).header('cache-control', 'public, max-age=31536000, immutable').send(buf)
  })

  app.delete<{ Params: { name: string } }>('/api/backgrounds/:name', async (req, reply) => {
    const { name } = req.params
    if (!isSafeBackgroundName(name)) return reply.code(404).send({ error: tr(undefined, 'backgrounds.unknownImage') })
    try {
      await unlink(pathOf(name))
    } catch {
      return reply.code(404).send({ error: tr(undefined, 'backgrounds.unknownImage') })
    }
    return { ok: true }
  })
}
