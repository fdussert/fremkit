import { execFile } from 'node:child_process'
import { z } from 'zod'
import type { CommandContext, Provider } from './types.js'
import { tr } from '../i18n.js'

/**
 * CleanShot X exposes a `cleanshot://` URL scheme (https://cleanshot.com/docs/api). This provider
 * is a *closed* allow-list over it: the widget names an action, the server builds the URL itself.
 * Nothing the client sends ever reaches a shell, a file path or a free-text parameter — the only
 * values that cross are the ones enumerated below.
 */

/** How long `open` may take before the command is given up on. */
export const OPEN_TIMEOUT_MS = 10_000

/** What CleanShot does with the capture once it is taken. */
const CaptureActionSchema = z.enum(['copy', 'save', 'annotate', 'upload', 'pin'])

/** An action that takes no parameter at all: `params` may be absent or an empty object. */
const NoParams = z.object({}).strict()

/**
 * The allow-list. The key is both the command name the widget sends and the URL's host part, and
 * the value is the schema its `params` must satisfy.
 *
 * Only parameters the documentation defines as an enum or a boolean are accepted. The geometry
 * parameters (`x`, `y`, `width`, `height`, `display`) and every `filepath` are deliberately left
 * out: a dashboard button has no business naming a file on disk, and a free-text parameter is the
 * one thing an allow-list is meant to prevent.
 */
export const ACTION_SCHEMAS = {
  'all-in-one': NoParams,
  'capture-area': z.object({ action: CaptureActionSchema.optional() }).strict(),
  'capture-window': z.object({ action: CaptureActionSchema.optional() }).strict(),
  'capture-fullscreen': z.object({ action: CaptureActionSchema.optional() }).strict(),
  'capture-previous-area': z.object({ action: CaptureActionSchema.optional() }).strict(),
  'self-timer': z.object({ action: CaptureActionSchema.optional() }).strict(),
  'scrolling-capture': z.object({ start: z.boolean().optional(), autoscroll: z.boolean().optional() }).strict(),
  'capture-text': z.object({ linebreaks: z.boolean().optional() }).strict(),
  'record-screen': NoParams,
  pin: NoParams,
  'open-from-clipboard': NoParams,
  'open-history': NoParams,
  'toggle-desktop-icons': NoParams,
  'restore-recently-closed': NoParams,
} as const

export type ActionName = keyof typeof ACTION_SCHEMAS
export const ACTION_NAMES = Object.keys(ACTION_SCHEMAS) as ActionName[]

const variants = ACTION_NAMES.map((name) =>
  z.object({ action: z.literal(name), params: ACTION_SCHEMAS[name].optional() }),
)

export const RunPayloadSchema = z.discriminatedUnion(
  'action',
  variants as unknown as [(typeof variants)[number], ...typeof variants],
)
export type RunPayload = z.infer<typeof RunPayloadSchema>

/**
 * The exact URL an action opens. Parameters are sorted by name so the same request always yields
 * the same string — easier to read in a log, and testable.
 */
export function urlFor(payload: RunPayload): string {
  const params = (payload.params ?? {}) as Record<string, string | boolean>
  const pairs = Object.keys(params)
    .sort()
    .filter((k) => params[k] !== undefined)
    .map((k) => `${k}=${encodeURIComponent(String(params[k]))}`)
  return `cleanshot://${payload.action}${pairs.length ? `?${pairs.join('&')}` : ''}`
}

/** The one way this provider reaches the Mac: a program and its argv, never a command line. */
export type Runner = (file: string, args: string[]) => Promise<string>

export const runProgram: Runner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: OPEN_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message))
      else resolve(stdout)
    })
  })

export const CLEANSHOT_BUNDLE_ID = 'pl.maketheweb.cleanshotx'

/**
 * The copy of CleanShot X that is running right now, if any. A Mac often keeps an older copy
 * around (a mounted disk, a downloads folder) that also claims the `cleanshot://` scheme, and a
 * bare `open <url>` may hand the URL to that one — which launches, does nothing and quits. The
 * running instance is the one the user means, so the URL goes to it by path; with none running,
 * the bundle id at least keeps LaunchServices away from a copy that is not CleanShot at all.
 */
export async function runningCleanshotPath(run: Runner): Promise<string | undefined> {
  try {
    const out = await run('lsappinfo', ['info', '-only', 'bundlepath', CLEANSHOT_BUNDLE_ID])
    const path = /"LSBundlePath"="([^"]+)"/.exec(out)?.[1]
    return path && path.startsWith('/') ? path : undefined
  } catch {
    return undefined
  }
}

/** `open` argv for a CleanShot URL: the running copy by path, else the bundle id. */
export async function openArgs(url: string, run: Runner): Promise<string[]> {
  const path = await runningCleanshotPath(run)
  return path ? ['-a', path, url] : ['-b', CLEANSHOT_BUNDLE_ID, url]
}

export interface RunResult { ok: boolean; error?: string }

/**
 * The `cleanshot` channel: one command, `run`, behind a grid of big touch buttons.
 *
 * There is nothing to publish — CleanShot X reports no state over its URL scheme — so the
 * provider declares no `poll` at all and the registry never puts it on a clock.
 */
export function createCleanshotProvider(run: Runner = runProgram): Provider {
  return {
    channel: 'cleanshot',
    commands: {
      run: async (payload, ctx?: CommandContext): Promise<RunResult> => {
        // `open` acts on the user's Mac, so only a client on that Mac may ask for it. Fail
        // closed: a caller that provides no context is treated as remote.
        if (!ctx?.loopback) return { ok: false, error: tr(undefined, 'provider.localOnly') }
        const parsed = RunPayloadSchema.safeParse(payload)
        if (!parsed.success) {
          return { ok: false, error: parsed.error.issues[0]?.message ?? 'charge utile invalide' }
        }
        try {
          await run('open', await openArgs(urlFor(parsed.data), run))
          return { ok: true }
        } catch (err) {
          return { ok: false, error: (err as Error).message || String(err) }
        }
      },
    },
  }
}
