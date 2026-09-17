import type { FastifyInstance } from 'fastify'
import type { ClaudeTracker, HookEvent } from './tracker.js'
import type { ClaudeUsage } from './usage.js'

const BODY_LIMIT = 1_000_000

/** Receives Claude Code hook and statusline payloads. Always answers 204 so it never disturbs the session. */
export async function claudeRoutes(app: FastifyInstance, opts: { tracker: ClaudeTracker; usage: ClaudeUsage }): Promise<void> {
  // Dedicated content-type parser for this plugin only: invalid JSON must not
  // become a 400 (Claude Code hooks ignore the response body but a non-2xx
  // status can make the hook runner treat the call as failed). Parsing to
  // `null` here lets the handler below treat it like any other non-object body.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string))
    } catch {
      done(null, null)
    }
  })

  app.post('/api/hooks/claude', { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    const body = req.body
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const event = body as HookEvent
      try {
        opts.tracker.handle(event)
        if (event.hook_event_name === 'StatusLine') await opts.usage.applyStatusLine(event)
      } catch (err) {
        req.log.warn({ err }, 'claude hook handling failed')
      }
    }
    return reply.code(204).send()
  })
}
