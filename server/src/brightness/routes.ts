import type { FastifyInstance } from 'fastify'
import { isLocalRequest } from '../net/remote.js'
import { tr } from '../i18n.js'
import { isCrossSiteFetch } from '../http/guard.js'
import { HelperReportSchema, type BrightnessService } from './service.js'
import { PlaceQuerySchema, searchPlaces, type Fetch } from './geocode.js'

/**
 * Where the helper reports the kiosk display's brightness, the way it reports the Dock: a small
 * JSON body, from this machine, carrying the access secret like every request. The other half of
 * the conversation — the target to apply — goes the other way on the `brightness` channel of the
 * WebSocket, which the helper subscribes to.
 */
export async function brightnessRoutes(
  app: FastifyInstance,
  opts: { service: BrightnessService; changed: () => void; fetch?: Fetch },
): Promise<void> {
  app.post('/api/hooks/brightness', { bodyLimit: 4096 }, async (req, reply) => {
    // The socket decides, not the address: a request to the remote listener from this Mac itself
    // has a loopback address too, and the helper never speaks through that listener.
    if (!isLocalRequest(req)) return reply.code(403).send({ error: tr(undefined, 'dock.notLocal') })
    const parsed = HelperReportSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: tr(undefined, 'provider.invalidPayload') })
    opts.service.helperReport(parsed.data)
    opts.changed()
    return reply.code(204).send()
  })

  /**
   * The admin's city search for the day/night schedule (see `geocode.ts`): asked for only when
   * the user presses Search, answered with a short list of places and their coordinates.
   */
  app.get('/api/brightness/places', async (req, reply) => {
    if (isCrossSiteFetch(req.headers)) return reply.code(403).send()
    const parsed = PlaceQuerySchema.safeParse(req.query)
    if (!parsed.success) return reply.code(400).send({ error: tr(undefined, 'provider.invalidPayload') })
    try {
      return { places: await searchPlaces(parsed.data.q, parsed.data.lang, opts.fetch) }
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'place search failed')
      return reply.code(502).send({ error: tr(parsed.data.lang, 'brightness.placesUnavailable') })
    }
  })
}
