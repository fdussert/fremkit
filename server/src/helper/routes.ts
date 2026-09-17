import { execFile } from 'node:child_process'
import type { FastifyInstance } from 'fastify'
import { isLoopbackAddress } from '../net/loopback.js'
import { isOriginAllowed } from '../ws/routes.js'
import { tr } from '../i18n.js'

/** The helper's bundle identifier, as declared in `native/Resources/Info.plist`. */
export const HELPER_BUNDLE_ID = 'dev.fremkit.helper'
/** The URL the helper answers with its admin window (see `HelperURL` in FremkitCore). */
export const HELPER_ADMIN_URL = 'fremkit://admin'
const OPEN_TIMEOUT_MS = 5000

/** The one way this route reaches the Mac: a program and its argv, never a command line. */
export type Runner = (file: string, args: string[]) => Promise<string>

export const runProgram: Runner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: OPEN_TIMEOUT_MS }, (err, stdout) => (err ? reject(new Error(err.message)) : resolve(stdout)))
  })

/**
 * The bundle path of the helper that is running right now, if any.
 *
 * A Mac easily holds several copies of the helper — the installed one in `~/Applications`, the
 * freshly built one in `native/dist` — and `open -b <id>` hands the URL to whichever
 * LaunchServices likes best, launching it. A second helper is not a harmless extra window: it
 * opens its own kiosk, claims the touch panel and supervises the same server. So the URL goes to
 * the copy that is *running*, by path; the bundle id is only the last resort.
 */
export async function runningHelperPath(run: Runner): Promise<string | undefined> {
  try {
    // `lsappinfo info` only answers for an ASN, not for a bundle id, so the lookup takes two
    // steps. `find` lists one ASN per running copy, oldest first; the first one is the helper
    // that has been up longest, which is the one supervising this server.
    const found = await run('lsappinfo', ['find', `bundleid=${HELPER_BUNDLE_ID}`])
    const asn = found.split(/\s+/).find((token) => token.startsWith('ASN:'))
    if (!asn) return undefined
    const out = await run('lsappinfo', ['info', '-only', 'bundlepath', asn])
    const path = /"LSBundlePath"="([^"]+)"/.exec(out)?.[1]
    return path && path.startsWith('/') ? path : undefined
  } catch {
    return undefined
  }
}

/** `open` argv for the admin URL: the running helper by path, else the bundle id. */
export async function openArgs(run: Runner): Promise<string[]> {
  const path = await runningHelperPath(run)
  return path ? ['-a', path, HELPER_ADMIN_URL] : ['-b', HELPER_BUNDLE_ID, HELPER_ADMIN_URL]
}

/**
 * Opening the helper's admin window from the dashboard.
 *
 * The Edge is single-touch, so the dashboard offers a long press on the page dots instead of a
 * gesture; under the helper that press lands here. The request has to come from this machine and
 * from a page the server itself serves — the same rule the mutating admin routes and the
 * WebSocket use — because the answer activates an application on the user's Mac.
 */
export async function helperRoutes(app: FastifyInstance, opts: { run?: Runner } = {}): Promise<void> {
  const run = opts.run ?? runProgram

  app.post('/api/helper/admin', async (req, reply) => {
    if (!isLoopbackAddress(req.ip)) return reply.code(403).send({ ok: false, error: tr(undefined, 'helper.notLocal') })
    if (!isOriginAllowed(req.headers.origin)) {
      return reply.code(403).send({ ok: false, error: tr(undefined, 'connections.originNotAllowed') })
    }

    try {
      await run('open', await openArgs(run))
      return { ok: true }
    } catch (err) {
      // A helper built before the URL scheme existed, or LaunchServices refusing it. Nothing the
      // server can fix, so it says so and the page can fall back to opening /admin itself.
      req.log.warn({ err }, 'helper admin open failed')
      return reply.code(503).send({ ok: false, error: tr(undefined, 'helper.unavailable') })
    }
  })
}
