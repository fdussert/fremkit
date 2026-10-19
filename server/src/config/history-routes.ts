import type { FastifyInstance } from 'fastify'
import type { ConfigStore } from './store.js'
import type { ConnectionTypeRegistry } from '../connections/registry.js'
import type { SecretStore } from '../secrets/index.js'
import type { Config } from './schema.js'
import { applyConfig } from '../backup/apply.js'
import { isCrossSiteFetch } from '../http/guard.js'
import { HISTORY_ID_RE } from './history.js'
import { tr } from '../i18n.js'

/**
 * The dashboard's history (`history.ts`): list the versions, read one, put one back.
 *
 * Local only, like every route not named in `devices/allowlist.ts`: a paired device has no
 * business reading every version of the dashboard. Reads are refused cross-site for the same
 * reason `/api/backup` is — they hand back a whole config.
 */
export async function historyRoutes(
  app: FastifyInstance,
  opts: {
    store: ConfigStore
    types: ConnectionTypeRegistry
    secrets: SecretStore
    onRestored?: (config: Config) => Promise<void> | void
  },
): Promise<void> {
  const { store } = opts
  const notFound = () => ({ errors: [tr(store.get().locale, 'history.notFound')] })

  app.get('/api/history', async (req, reply) => {
    if (isCrossSiteFetch(req.headers)) return reply.code(403).send({ error: tr(store.get().locale, 'http.originNotAllowed') })
    const history = store.history
    return { entries: history ? await history.list() : [] }
  })

  app.get<{ Params: { id: string } }>('/api/history/:id', async (req, reply) => {
    if (isCrossSiteFetch(req.headers)) return reply.code(403).send({ error: tr(store.get().locale, 'http.originNotAllowed') })
    if (!HISTORY_ID_RE.test(req.params.id)) return reply.code(404).send(notFound())
    const found = await store.history?.read(req.params.id).catch(() => null)
    if (!found) return reply.code(404).send(notFound())
    return found
  })

  /**
   * Puts a version back. A save like any other, through the same code as a backup restore: this
   * Mac's security settings stay, secrets follow only connections that come back unchanged, and
   * the version being replaced stays in the history, so a restore is itself undone from here.
   */
  app.post<{ Params: { id: string } }>('/api/history/:id/restore', async (req, reply) => {
    const locale = store.get().locale
    if (store.degraded) return reply.code(409).send({ errors: [tr(locale, 'config.degraded')] })
    if (!HISTORY_ID_RE.test(req.params.id)) return reply.code(404).send(notFound())
    let found: Awaited<ReturnType<NonNullable<ConfigStore['history']>['read']>> | undefined
    try {
      found = await store.history?.read(req.params.id)
    } catch (err) {
      req.log.warn({ err }, 'history: could not read a version')
      return reply.code(400).send({ errors: [tr(locale, 'history.unreadable')] })
    }
    if (!found) return reply.code(404).send(notFound())

    const applied = await applyConfig(opts, found.config, { reason: 'revert', revertedTo: found.entry.savedAt }, req.log)
    if (!applied.ok) {
      if (applied.failure === 'degraded') return reply.code(409).send({ errors: [tr(locale, 'config.degraded')] })
      if (applied.failure === 'secrets') return reply.code(500).send({ errors: [tr(locale, 'history.secretsFailed')] })
      return reply.code(400).send({ errors: [tr(locale, 'history.unreadable')] })
    }
    return reply.send({
      ok: true,
      pages: applied.saved.screens.reduce((n, screen) => n + screen.pages.length, 0),
      screens: applied.saved.screens.length,
      reenterSecrets: applied.reenterSecrets,
    })
  })
}
