import type { FastifyInstance } from 'fastify'
import { CONNECTION_ID_RE } from '../config/schema.js'
import type { BambuCameras } from './cameras.js'
import { tr } from '../i18n.js'

/**
 * The chamber-camera preview, as a plain image the widget can put in an `<img>`.
 *
 * One still per request rather than an MJPEG stream: the widget is sandboxed and refreshes on its
 * own timer, and a still lets the server drop the printer socket as soon as nobody is looking.
 */
export async function bambuRoutes(app: FastifyInstance, opts: { cameras: BambuCameras }): Promise<void> {
  app.get<{ Params: { connectionId: string } }>('/api/bambu/:connectionId/snapshot.jpg', async (req, reply) => {
    const { connectionId } = req.params
    if (!CONNECTION_ID_RE.test(connectionId) || !opts.cameras.has(connectionId)) {
      return reply.code(404).send({ error: tr(undefined, 'bambu.unknownConnection') })
    }
    const frame = opts.cameras.snapshot(connectionId)
    // The first request only opens the socket; the widget shows its placeholder and tries again.
    if (!frame) {
      const error = opts.cameras.errorCode(connectionId)
      return reply.code(503).header('cache-control', 'no-store')
        .send(error ? { state: opts.cameras.state(connectionId), error } : { state: opts.cameras.state(connectionId) })
    }
    return reply.type('image/jpeg').header('cache-control', 'no-store').send(frame.jpeg)
  })
}
