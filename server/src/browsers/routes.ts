import type { FastifyInstance } from 'fastify'
import { isLocalRequest } from '../net/remote.js'
import { tr } from '../i18n.js'
import type { BrowserProfiles } from './profiles.js'

/**
 * `GET /api/browsers/profiles` — the profiles of the browsers a shortcut may open a link in.
 *
 * Local only: it is the editor's list of suggestions, and nothing on a paired device edits a
 * shortcut. Each profile is its browser and the name the user gave it, never its folder or the
 * account signed into it.
 */
export async function browserRoutes(app: FastifyInstance, opts: { profiles: BrowserProfiles }): Promise<void> {
  app.get('/api/browsers/profiles', async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: tr(undefined, 'dock.notLocal') })
    return reply.header('cache-control', 'private, max-age=60').send(await opts.profiles.list())
  })
}
