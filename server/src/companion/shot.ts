/**
 * Fremdev's shot: ⌃⇧S in the browser captures the dev tab, and the extension posts the JPEG here
 * for this Mac's clipboard.
 *
 * `POST /companion/dev/shot` answers without the access secret (`COMPANION_ROUTES`), so it checks
 * its caller itself, in this order, and each refusal comes before anything is read into memory past
 * the body limit or written anywhere:
 *
 * 1. a request from this Mac (`isLocalRequest`); the remote listener's allow-list leaves it out too,
 *    so a paired device gets 404 twice over;
 * 2. an extension origin that is let in (403 otherwise);
 * 3. a bearer that is that extension's own pairing token, for a record of that origin (401);
 * 4. an install that can shoot right now: Fremdev enabled, its socket open, Fremdev on and
 *    `fremdev.shot` listed (409) — the socket's handshake is what proved this listener is Fremkit
 *    before the extension sent its token at all;
 * 5. a body of at most `SHOT_MAX_BYTES` (413) that starts as a JPEG does (415);
 * 6. one shot at a time per device (429).
 *
 * The image goes to the clipboard through `/usr/bin/osascript` with a constant script and the file's
 * path as `argv`, from a 0600 file in the data folder that is removed whatever happens.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { DeviceStore } from '../devices/store.js'
import { readBearer, isWellFormedToken } from '../http/access.js'
import { isLocalRequest } from '../net/remote.js'
import type { CompanionDev } from './dev.js'
import { EXTENSION_ORIGIN_RE, SHOT_MAX_BYTES } from './protocol.js'

/** Where a shot ends up: this Mac's clipboard, unless a test says. */
export interface ImageClipboard {
  writeJpeg(bytes: Buffer): Promise<void>
}

/** `child_process.execFile`'s shape, as far as the clipboard uses it. */
export type ExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
  callback: (error: Error | null, stdout?: string | Buffer, stderr?: string | Buffer) => void,
) => unknown

export const OSASCRIPT = '/usr/bin/osascript'
/** A constant script: the file is `item 1 of argv`, never part of the script's text. */
export const SHOT_SCRIPT = ['-e', 'on run argv', '-e', 'set the clipboard to (read (POSIX file (item 1 of argv)) as JPEG picture)', '-e', 'end run'] as const
export const SHOT_TIMEOUT_MS = 10_000

/** The JPEG's start of image and the first marker's lead byte. */
const JPEG_MAGIC = [0xff, 0xd8, 0xff]

/**
 * The clipboard through `osascript`, which reads the image from a file: `dir/shot-<uuid>.jpg`,
 * written 0600 and exclusively (never through a file or link already there), removed in `finally`.
 */
export function osascriptImageClipboard(dir: string, exec: ExecFile = execFile as unknown as ExecFile): ImageClipboard {
  return {
    async writeJpeg(bytes) {
      const file = join(dir, `shot-${randomUUID()}.jpg`)
      try {
        await writeFile(file, bytes, { mode: 0o600, flag: 'wx' })
        await new Promise<void>((resolve, reject) => {
          exec(OSASCRIPT, [...SHOT_SCRIPT, file], { timeout: SHOT_TIMEOUT_MS }, (err) => (err ? reject(err) : resolve()))
        })
      } finally {
        await rm(file, { force: true })
      }
    },
  }
}

export interface CompanionShotOptions {
  store: Pick<DeviceStore, 'findByToken'>
  dev: Pick<CompanionDev, 'canShot'>
  /** The extension origins let in (`companionOrigins`). */
  origins: ReadonlySet<string>
  clipboard: ImageClipboard
}

const isJpeg = (body: unknown): body is Buffer =>
  Buffer.isBuffer(body) && body.length >= JPEG_MAGIC.length && JPEG_MAGIC.every((b, i) => body[i] === b)

export async function companionShotRoute(app: FastifyInstance, opts: CompanionShotOptions): Promise<void> {
  const { store, dev, origins, clipboard } = opts
  /** The device each request was let in as, by the hook below. */
  const deviceOf = new WeakMap<FastifyRequest, string>()
  /** The devices whose shot is being written. */
  const busy = new Set<string>()

  // This plugin's own: the rest of the server has no use for a JPEG body.
  app.addContentTypeParser('image/jpeg', { parseAs: 'buffer', bodyLimit: SHOT_MAX_BYTES }, (_req, body, done) => done(null, body))

  const refuse = (reply: FastifyReply, status: number) => reply.code(status).header('cache-control', 'no-store').send({ ok: false })

  /** Who is asking, before the body is read. */
  const admit = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!isLocalRequest(req)) return reply.callNotFound()
    const origin = req.headers.origin
    if (typeof origin !== 'string' || !EXTENSION_ORIGIN_RE.test(origin) || !origins.has(origin)) return refuse(reply, 403)
    const token = readBearer(req.headers.authorization)
    const record = token !== undefined && isWellFormedToken(token) ? store.findByToken(token, 'extension') : null
    if (record === null || record.kind !== 'extension' || record.origin !== origin) {
      req.log.warn('companion shot refused: not a paired extension')
      return refuse(reply, 401)
    }
    if (!dev.canShot(record.id)) {
      req.log.info({ deviceId: record.id }, 'companion shot refused: Fremdev off or no shot module')
      return refuse(reply, 409)
    }
    deviceOf.set(req, record.id)
  }

  app.post('/companion/dev/shot', { onRequest: admit, bodyLimit: SHOT_MAX_BYTES }, async (req, reply) => {
    const deviceId = deviceOf.get(req)
    if (deviceId === undefined) return refuse(reply, 401)
    if (!isJpeg(req.body)) return refuse(reply, 415)
    if (busy.has(deviceId)) return refuse(reply, 429)
    busy.add(deviceId)
    try {
      await clipboard.writeJpeg(req.body)
    } catch {
      // Not the error's text: osascript's quotes the file's path, under the user's home folder.
      req.log.warn({ deviceId }, 'companion shot: clipboard write failed')
      return reply.code(500).header('cache-control', 'no-store').send({ ok: false })
    } finally {
      busy.delete(deviceId)
    }
    req.log.info({ deviceId, bytes: req.body.length }, 'companion shot copied')
    return reply.header('cache-control', 'no-store').send({ ok: true })
  })
}
