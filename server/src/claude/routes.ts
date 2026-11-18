import type { FastifyInstance } from 'fastify'
import type { ClaudeTracker } from './tracker.js'
import { parseHookEvent } from './hook-schema.js'
import type { ClaudeUsage } from './usage.js'
import { defaultConfigDir, type ClaudeConfigDirs } from './configDirs.js'
import { describeConfigDir, type ConfigDirAccount } from './identity.js'
import { claudeTokenExpiry } from './account.js'

const BODY_LIMIT = 1_000_000

/** Receives Claude Code hook and statusline payloads. Always answers 204 so it never disturbs the session. */
export async function claudeRoutes(app: FastifyInstance, opts: {
  tracker: ClaudeTracker
  usage: ClaudeUsage
  configDirs?: ClaudeConfigDirs
  /** Test seam for `describeConfigDir`. */
  describe?: (dir: string) => Promise<ConfigDirAccount>
  /** Test seam for `claudeTokenExpiry`. */
  expiry?: (dir: string) => Promise<number | null>
  now?: () => number
}): Promise<void> {
  const describe = opts.describe ?? ((dir: string) => describeConfigDir(dir))
  const expiry = opts.expiry ?? ((dir: string) => claudeTokenExpiry(dir))
  const now = opts.now ?? Date.now
  /**
   * The Claude Code configuration folders the privacy pane offers for the account usage, each with
   * its plan and organisation so the user can tell the accounts apart. Admin only (not on the
   * devices' allow-list); never an e-mail address, never a token. `expired`: the folder's sign-in
   * has lapsed (no Claude Code session ran from it lately), so its usage cannot be read.
   */
  app.get('/api/claude/accounts', async () => {
    const dirs = [...new Set([...(opts.configDirs?.list() ?? []), defaultConfigDir()])]
    const t = now()
    return {
      accounts: await Promise.all(dirs.map(async (dir) => {
        const [account, expiresAt] = await Promise.all([describe(dir), expiry(dir)])
        return { ...account, expired: expiresAt !== null && expiresAt <= t }
      })),
    }
  })

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
    // Bounded and narrowed rather than cast: see hook-schema.ts. Still always a 204.
    const event = parseHookEvent(req.body)
    if (event) {
      try {
        opts.tracker.handle(event)
        opts.configDirs?.note(event.transcript_path)
        if (event.hook_event_name === 'StatusLine') await opts.usage.applyStatusLine(event)
      } catch (err) {
        req.log.warn({ err }, 'claude hook handling failed')
      }
    }
    return reply.code(204).send()
  })
}
