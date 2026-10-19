/**
 * Pairing the browser extension. Two audiences, never mixed:
 *
 * - the extension: `POST /api/companion/pair` (ask; the code goes to the Edge, not here),
 *   `POST /api/companion/pair/:requestId` (where the request stands), and `…/confirm`, the
 *   extension's proof of the code the user typed (pairProof.ts), answered with the server's own
 *   proof and the token. They answer without the access secret (see `isCompanionRoute`), so
 *   each one checks the extension origin itself; a web page cannot send a `chrome-extension://`
 *   origin. They are POSTs: Chrome leaves `Origin` off an extension's GET to a host it has a
 *   permission for.
 * - the Edge and the admin, on this Mac: refuse, behind the access secret like everything else.
 *   It carries the code it showed, so a refusal never lands on a request that took the shown one's
 *   place. There is no approve: typing the code into the extension is the approval.
 *
 * None of them is on the remote listener's allow-list, so a paired iPad gets 404; each also
 * refuses a remote request itself, in case the allow-list ever grows by mistake.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ConfigStore } from '../config/store.js'
import { tr, type MessageKey } from '../i18n.js'
import { isLocalRequest } from '../net/remote.js'
import type { CompanionPairing } from './pairing.js'
import { EXTENSION_ORIGIN_RE } from './protocol.js'

export interface CompanionRoutesOptions {
  pairing: CompanionPairing
  config: Pick<ConfigStore, 'get'>
  /** The extension origins let in (`companionOrigins`). */
  origins: ReadonlySet<string>
  /** How many browser extensions are paired. */
  pairedExtensions: () => number
}

/**
 * The names the extension may give itself (`companion/lib/browser.js`). A closed list: the name is
 * shown on the Edge next to the code, and a free one could read "Approve this, it is safe".
 * Microsoft's browser keeps its full name: a bare "Edge" on the Edge's own screen reads as the
 * screen.
 */
export const COMPANION_NAMES = ['Chrome', 'Microsoft Edge', 'Brave', 'Arc', 'Opera', 'Vivaldi', 'Chromium'] as const

const PairSchema = z.strictObject({
  name: z.enum(COMPANION_NAMES),
  installId: z.uuid(),
  /** 32 random bytes from the extension, salting K(code) (pairProof.ts). */
  salt: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
})

/** The code the Edge or the admin showed when the user answered. */
const AnswerSchema = z.object({ code: z.string().max(16) })

/** 32 random bytes, or an HMAC-SHA256, in base64url, unpadded: exactly 43 characters. */
const B64_32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
/** The extension's nonce and its proof of the code (pairProof.ts). */
const ConfirmSchema = z.strictObject({ nonce: B64_32, mac: B64_32 })

const RequestIdSchema = z.uuid()

type Params = { Params: { requestId: string } }

/** The request's extension origin when it is one of `allowed`, or null (none, several, another). */
function extensionOrigin(req: FastifyRequest, allowed: ReadonlySet<string>): string | null {
  const origin = req.headers.origin
  return typeof origin === 'string' && EXTENSION_ORIGIN_RE.test(origin) && allowed.has(origin) ? origin : null
}

export async function companionRoutes(app: FastifyInstance, opts: CompanionRoutesOptions): Promise<void> {
  const { pairing } = opts
  const locale = () => opts.config.get().locale
  const fail = (reply: FastifyReply, status: number, key: MessageKey, reason?: string): FastifyReply =>
    reply.code(status).header('cache-control', 'no-store').send({ error: tr(locale(), key), ...(reason ? { reason } : {}) })

  /** Every route here is this Mac's only. */
  const localOnly = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!isLocalRequest(req)) return reply.callNotFound()
  }

  // --- the extension ----------------------------------------------------------------------------

  app.post('/api/companion/pair', { onRequest: localOnly }, async (req, reply) => {
    const origin = extensionOrigin(req, opts.origins)
    if (origin === null) return fail(reply, 403, 'companion.originNotAllowed')
    // Not a security boundary (the server does not rely on `labs.companion` for that, see
    // docs/companion.md): with the switch off the Edge shows no prompt, so nobody would see a
    // request at all, and a program guessing codes would do it unseen. Off is Fremplay off, so
    // an extension already paired is refused too; it stays listed in Devices, to remove.
    if (opts.config.get().labs?.companion !== true) {
      return fail(reply, 409, 'companion.disabled', 'disabled')
    }
    const parsed = PairSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
    }
    const result = pairing.request({ origin, ...parsed.data })
    // `reason` tells the extension which of its own messages to show; `error` is for a person.
    if (result === 'limited') {
      req.log.warn({ origin }, 'companion pairing request refused: too many')
      return fail(reply, 429, 'companion.limited', 'limited')
    }
    if (result === 'cooldown') {
      req.log.warn({ origin }, 'companion pairing request refused: refused a moment ago')
      return fail(reply, 429, 'companion.pairCooldown', 'cooldown')
    }
    if (result === 'locked') {
      req.log.warn({ origin }, 'companion pairing request refused: locked after too many wrong codes')
      return fail(reply, 423, 'companion.pairLocked', 'locked')
    }
    if (result === 'busy') {
      req.log.warn({ origin }, 'companion pairing request refused: another one is waiting')
      return fail(reply, 409, 'companion.pairBusy', 'busy')
    }
    // Never the code, here or in the log: the user types it from the Edge. The id is no secret on
    // its own: every later step also needs the request's origin.
    req.log.info({ origin }, 'companion pairing requested')
    reply.header('cache-control', 'no-store')
    return { requestId: result.requestId, expiresAt: result.expiresAt }
  })

  app.post<Params>('/api/companion/pair/:requestId', { onRequest: localOnly }, async (req, reply) => {
    const origin = extensionOrigin(req, opts.origins)
    if (origin === null) return fail(reply, 403, 'companion.originNotAllowed')
    reply.header('cache-control', 'no-store')
    const id = RequestIdSchema.safeParse(req.params.requestId)
    if (!id.success) return { state: 'expired' }
    if (!pairing.belongsTo(id.data, origin)) return fail(reply, 403, 'companion.originNotAllowed')
    return pairing.collect(id.data, origin)
  })

  app.post<Params>('/api/companion/pair/:requestId/confirm', { onRequest: localOnly }, async (req, reply) => {
    const origin = extensionOrigin(req, opts.origins)
    if (origin === null) return fail(reply, 403, 'companion.originNotAllowed')
    reply.header('cache-control', 'no-store')
    const id = RequestIdSchema.safeParse(req.params.requestId)
    if (!id.success) return { state: 'expired' }
    if (!pairing.belongsTo(id.data, origin)) return fail(reply, 403, 'companion.originNotAllowed')
    const body = ConfirmSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ errors: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
    const result = await pairing.confirm(id.data, origin, body.data.nonce, body.data.mac)
    if (result.state === 'paired') req.log.info({ origin, deviceId: result.deviceId }, 'companion paired by its code')
    else if (result.state === 'wrong') req.log.warn({ origin }, 'companion pairing: wrong code')
    else if (result.state === 'exhausted') req.log.warn({ origin }, 'companion pairing refused: code tried too often')
    return result
  })

  // --- the Edge and the admin -------------------------------------------------------------------

  /** `{ code }` is the code on show when the user tapped; a missing or other one is a changed request. */
  const answerCode = (body: unknown): string | null => {
    const parsed = AnswerSchema.safeParse(body)
    return parsed.success ? parsed.data.code : null
  }
  const answered = (reply: FastifyReply, result: 'ok' | 'notFound' | 'changed'): FastifyReply | null => {
    if (result === 'notFound') return fail(reply, 404, 'companion.requestNotFound')
    if (result === 'changed') return fail(reply, 409, 'companion.requestChanged')
    return null
  }

  /** Settings → Devices' Unlock pairing: behind the secret like every route of the admin's. */
  app.post('/api/companion/unlock', { onRequest: localOnly }, async (req) => {
    await pairing.unlock()
    req.log.info('companion pairing unlocked')
    return { ok: true }
  })

  app.post<Params>('/api/companion/requests/:requestId/refuse', { onRequest: localOnly }, async (req, reply) => {
    const failed = answered(reply, pairing.refuse(req.params.requestId, answerCode(req.body)))
    if (failed) return failed
    req.log.info('companion pairing refused')
    return { ok: true }
  })
}
