import { execFile } from 'node:child_process'
import type { FastifyInstance } from 'fastify'
import { isLocalRequest } from '../net/remote.js'
import { isOriginAllowed } from '../ws/routes.js'
import { tr } from '../i18n.js'

/** The helper's bundle identifier, as declared in `native/Resources/Info.plist`. */
export const HELPER_BUNDLE_ID = 'dev.fremkit.helper'
/** The URL the helper answers with its admin window (see `HelperURL` in FremkitCore). */
export const HELPER_ADMIN_URL = 'fremkit://admin'
/**
 * The URL that drops the dashboard behind the other windows for a while (`HelperURL.reveal`), so
 * a macOS dialog it covers on the Edge — the privacy prompt a disk map scan waits on — can be seen.
 */
export const HELPER_REVEAL_URL = 'fremkit://reveal'
const OPEN_TIMEOUT_MS = 5000
/**
 * The two programs this route runs, by absolute path.
 *
 * `execFile` resolves a bare name through `PATH`, and the server inherits whatever `PATH` the
 * helper — or a terminal, or a login shell's rc file — happened to hand it. There is one `open`
 * and one `lsappinfo` on macOS, and this is where they live.
 */
export const OPEN_PROGRAM = '/usr/bin/open'
export const LSAPPINFO_PROGRAM = '/usr/bin/lsappinfo'

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
    const found = await run(LSAPPINFO_PROGRAM, ['find', `bundleid=${HELPER_BUNDLE_ID}`])
    const asn = found.split(/\s+/).find((token) => token.startsWith('ASN:'))
    if (!asn) return undefined
    const out = await run(LSAPPINFO_PROGRAM, ['info', '-only', 'bundlepath', asn])
    const path = /"LSBundlePath"="([^"]+)"/.exec(out)?.[1]
    return path && path.startsWith('/') ? path : undefined
  } catch {
    return undefined
  }
}

/** One of the helper's own URLs: the closed list the helper itself knows. */
export type HelperUrl = typeof HELPER_ADMIN_URL | typeof HELPER_REVEAL_URL

/** `open` argv for a helper URL: the running helper by path, else the bundle id. */
export async function openArgs(run: Runner, url: HelperUrl = HELPER_ADMIN_URL): Promise<string[]> {
  const path = await runningHelperPath(run)
  return path ? ['-a', path, url] : ['-b', HELPER_BUNDLE_ID, url]
}

/**
 * Hands a helper URL to the running helper. Rejects when `open` fails (no helper, too old).
 *
 * The reveal goes to a running helper or nowhere: with none there is no dashboard to lower, and
 * `open -b` would launch one (`pnpm dev` in a browser, for one) just to do nothing.
 */
export async function openHelperUrl(url: HelperUrl, run: Runner = runProgram): Promise<void> {
  if (url === HELPER_REVEAL_URL) {
    const path = await runningHelperPath(run)
    if (!path) throw new Error('no running helper')
    await run(OPEN_PROGRAM, ['-a', path, url])
    return
  }
  await run(OPEN_PROGRAM, await openArgs(run, url))
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

  /**
   * Both routes run `open` with a fixed URL; nothing of the request reaches the argument list.
   * `fremkit://reveal` is asked for by the disk map through its provider command too, since a
   * widget's sandboxed frame cannot call these routes itself.
   */
  const route = (path: string, url: HelperUrl) => app.post(path, async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ ok: false, error: tr(undefined, 'helper.notLocal') })
    if (!isOriginAllowed(req.headers.origin)) {
      return reply.code(403).send({ ok: false, error: tr(undefined, 'connections.originNotAllowed') })
    }

    try {
      await openHelperUrl(url, run)
      return { ok: true }
    } catch (err) {
      // A helper built before the URL scheme (or this URL) existed, or LaunchServices refusing
      // it. Nothing the server can fix, so it says so and the page can fall back on its own.
      req.log.warn({ err, url }, 'helper URL open failed')
      return reply.code(503).send({ ok: false, error: tr(undefined, 'helper.unavailable') })
    }
  })

  route('/api/helper/admin', HELPER_ADMIN_URL)
  route('/api/helper/reveal', HELPER_REVEAL_URL)
}
