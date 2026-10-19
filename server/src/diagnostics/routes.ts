import type { FastifyInstance } from 'fastify'
import { isLocalRequest } from '../net/remote.js'
import { buildDiagnostics, type DiagnosticsDeps } from './report.js'

/**
 * `GET /api/diagnostics`: a redacted report for a bug issue, as Markdown in plain text.
 *
 * Local only, twice over: the remote listener's allow-list does not name it (so a paired device
 * gets 404 there), and the handler checks `isLocalRequest` itself in case that list ever grows a
 * pattern broad enough to reach it. `no-store`, because the report holds the recent log.
 */
export async function diagnosticsRoutes(app: FastifyInstance, opts: { deps: DiagnosticsDeps }): Promise<void> {
  app.get('/api/diagnostics', async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(404).send()
    const text = await buildDiagnostics(opts.deps)
    return reply
      .header('cache-control', 'no-store')
      .type('text/markdown; charset=utf-8')
      .send(text)
  })
}
