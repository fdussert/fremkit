/**
 * The device routes. Two audiences, never mixed:
 *
 * - the admin, on this Mac: everything under `/api/devices` but `/me`. These are absent from the
 *   remote allow-list, so the devices gate already answers 404 on the remote listener; each one
 *   also refuses a remote request itself, in case the allow-list ever grows by mistake.
 * - a device, on the remote listener: `POST /api/pair` (public, it is how a token is obtained, and
 *   there only while a code is live),
 *   `GET /api/devices/me` and `POST /api/devices/me/brightness` (token). Pairing answers 404 locally: a code typed on the Mac itself
 *   would pair nothing that could use it.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ConfigStore } from '../config/store.js'
import { tr, type MessageKey } from '../i18n.js'
import { isRemoteRequest, pairedDeviceOf } from '../net/remote.js'
import { DeviceReportSchema, type DeviceReport } from '../brightness/service.js'
import { SECRET_PATTERN } from './codes.js'
import type { DeviceService } from './service.js'
import { ViewportSchema } from './store.js'

export interface DeviceRoutesOptions {
  service: DeviceService
  config: ConfigStore
  /** Hands a device's brightness report to whoever decides brightness (injected, not imported). */
  reportBrightness: (screenId: string, report: DeviceReport) => void
}

const NameSchema = z.string().trim().min(1).max(60)

/**
 * Either the code, typed by hand, or the secret the QR code carries (`codes.ts`), never both. The
 * secret's schema is its exact shape, so nothing longer ever reaches the comparison.
 */
/** A typed code arrives as its proof (`codeProof`), never as itself: 32 bytes, base64url, like a secret. */
const PairSchema = z.object({
  proof: z.string().regex(SECRET_PATTERN).optional(),
  secret: z.string().regex(SECRET_PATTERN).optional(),
  name: NameSchema,
  viewport: ViewportSchema,
}).refine((b) => (b.proof === undefined) !== (b.secret === undefined), { message: 'proof or secret, one of them' })

const SettingsSchema = z.object({ enabled: z.boolean() })

const PatchSchema = z.object({
  name: NameSchema.optional(),
  screenId: z.string().min(1).max(64).nullable().optional(),
})

function badBody(reply: FastifyReply, error: z.ZodError): FastifyReply {
  return reply.code(400).send({ errors: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
}

const PAIR_ERRORS: Record<'wrong' | 'expired' | 'limited', { status: 403 | 429; key: MessageKey }> = {
  wrong: { status: 403, key: 'device.codeWrong' },
  expired: { status: 403, key: 'device.codeExpired' },
  limited: { status: 429, key: 'device.codeLimited' },
}

export async function deviceRoutes(app: FastifyInstance, opts: DeviceRoutesOptions): Promise<void> {
  const { service } = opts
  const locale = () => opts.config.get().locale

  /** The admin routes are this Mac's only. */
  const localOnly = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (isRemoteRequest(req)) return reply.callNotFound()
  }

  // --- the device -------------------------------------------------------------------------------

  app.post('/api/pair', async (req, reply) => {
    if (!isRemoteRequest(req)) return reply.callNotFound()
    // Only while the Mac shows a code: the rest of the time the route does not exist, so nobody can
    // probe it or spend the guess allowance before the user even asks for a code.
    if (!service.pairingOpen) return reply.callNotFound()
    reply.header('cache-control', 'no-store')
    const parsed = PairSchema.safeParse(req.body)
    if (!parsed.success) return badBody(reply, parsed.error)
    const { proof, secret, name, viewport } = parsed.data
    // Counted per peer address (`codes.ts`): the socket's, which no header can change. A secret is
    // taken before that count, and a wrong one fails exactly as a wrong code does.
    const credential = secret !== undefined ? { secret } : { proof: proof ?? '' }
    const result = await service.pair(credential, name, viewport, req.ip)
    if ('error' in result) {
      const { status, key } = PAIR_ERRORS[result.error]
      return reply.code(status).send({ error: tr(locale(), key) })
    }
    return { token: result.token, deviceId: result.device.id }
  })

  app.get('/api/devices/me', async (req, reply) => {
    // Who is asking comes from the token the gate checked, and from nothing the request says.
    const deviceId = pairedDeviceOf(req)
    if (!isRemoteRequest(req) || deviceId === null) return reply.callNotFound()
    // The device app asks for the Mac's other addresses; the dashboard page's own request does not.
    const wantsAddresses = (req.query as { addresses?: unknown } | undefined)?.addresses === '1'
    const me = wantsAddresses ? await service.meForApp(deviceId) : service.me(deviceId)
    if (!me) return reply.code(401).send({ error: tr(locale(), 'devices.unauthorized') })
    reply.header('cache-control', 'no-store')
    return me
  })

  app.post('/api/devices/me/brightness', { bodyLimit: 1024 }, async (req, reply) => {
    const deviceId = pairedDeviceOf(req)
    if (!isRemoteRequest(req) || deviceId === null) return reply.callNotFound()
    reply.header('cache-control', 'no-store')
    const parsed = DeviceReportSchema.safeParse(req.body)
    if (!parsed.success) return badBody(reply, parsed.error)
    // The screen is the device's now, never one the body names.
    const screenId = service.deviceScreenOf(deviceId)
    if (screenId === null) return reply.code(409).send({ error: tr(locale(), 'device.noScreen') })
    opts.reportBrightness(screenId, parsed.data)
    return reply.code(204).send()
  })

  // --- the admin --------------------------------------------------------------------------------

  app.get('/api/devices', { onRequest: localOnly }, async (_req, reply) => {
    await service.loadKeyHash()
    reply.header('cache-control', 'no-store')
    return service.status()
  })

  app.put('/api/devices/settings', { onRequest: localOnly }, async (req, reply) => {
    const parsed = SettingsSchema.safeParse(req.body)
    if (!parsed.success) return badBody(reply, parsed.error)
    const result = await service.setEnabled(parsed.data.enabled)
    return {
      ...service.status(),
      ...(result.error === 'portInUse' ? { message: tr(locale(), 'device.portInUse') } : {}),
    }
  })

  app.post('/api/devices/code', { onRequest: localOnly }, async (_req, reply) => {
    reply.header('cache-control', 'no-store')
    // Listening is checked inside, on the same chain as the switch (`DeviceService.pairingCode`).
    const offer = await service.pairingCode()
    if (offer === 'notListening') return reply.code(409).send({ error: tr(locale(), 'device.notEnabled') })
    return offer
  })

  app.patch<{ Params: { id: string } }>('/api/devices/:id', { onRequest: localOnly }, async (req, reply) => {
    const parsed = PatchSchema.safeParse(req.body ?? {})
    if (!parsed.success) return badBody(reply, parsed.error)
    const { id } = req.params
    const known = service.status().devices.find((d) => d.id === id)
    if (!known) return reply.code(404).send({ errors: [tr(locale(), 'device.notFound')] })
    // A screen is an iPad's: an extension has none to be put on.
    if (parsed.data.screenId !== undefined && known.kind === 'extension') {
      return reply.code(400).send({ errors: [tr(locale(), 'device.screenNotDevice')] })
    }
    if (parsed.data.screenId !== undefined) {
      const attached = await service.attach(id, parsed.data.screenId)
      if (attached === 'screenNotDevice') {
        return reply.code(400).send({ errors: [tr(locale(), 'device.screenNotDevice')] })
      }
    }
    if (parsed.data.name !== undefined) await service.rename(id, parsed.data.name)
    const device = service.status().devices.find((d) => d.id === id)
    if (!device) return reply.code(404).send({ errors: [tr(locale(), 'device.notFound')] })
    return device
  })

  app.delete<{ Params: { id: string } }>('/api/devices/:id', { onRequest: localOnly }, async (req, reply) => {
    if (!(await service.revoke(req.params.id))) {
      return reply.code(404).send({ errors: [tr(locale(), 'device.notFound')] })
    }
    return reply.code(204).send()
  })

  app.delete('/api/devices', { onRequest: localOnly }, async (_req, reply) => {
    await service.revokeAll()
    return reply.code(204).send()
  })

  app.post('/api/devices/reset-certificate', { onRequest: localOnly }, async () => {
    await service.resetCertificate()
    return service.status()
  })
}
