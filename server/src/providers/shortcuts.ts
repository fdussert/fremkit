import { execFile } from 'node:child_process'
import { z } from 'zod'
import type { CommandContext, Provider } from './types.js'
import { tr } from '../i18n.js'

/** Longest a target may be: an application name, a URL or a shortcut name, never a document. */
const MAX_TARGET = 200

/** How long `open` or `shortcuts run` may take before the command is given up on. */
export const OPEN_TIMEOUT_MS = 15_000

/** The only protocols a `url` button may carry. No `file:`, no `javascript:`, no custom scheme. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/**
 * Characters refused in an application or shortcut name.
 *
 * Nothing is ever handed to a shell — `execFile` takes an argv — so this is not what keeps the
 * Mac safe; it is what keeps a button honest. A name with a slash is a path, and a name with a
 * shell metacharacter is someone probing for a shell that is not there: both are refused loudly
 * rather than passed on to `open`.
 */
const FORBIDDEN_NAME_RE = /[/\\;&|`$<>"'\n\r\t*?()[\]{}]/

/** A name starting with a dash would be read by `open` as a flag. */
const LOOKS_LIKE_FLAG_RE = /^-/

const NameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TARGET)
  .refine((v) => !FORBIDDEN_NAME_RE.test(v), { message: 'nom invalide' })
  .refine((v) => !LOOKS_LIKE_FLAG_RE.test(v), { message: 'nom invalide' })

const UrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TARGET)
  .refine((v) => {
    let url: URL
    try { url = new URL(v) } catch { return false }
    return ALLOWED_PROTOCOLS.has(url.protocol)
  }, { message: 'URL refusée' })

export const OpenPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('app'), target: NameSchema }),
  z.object({ kind: z.literal('shortcut'), target: NameSchema }),
  z.object({ kind: z.literal('url'), target: UrlSchema }),
])
export type OpenPayload = z.infer<typeof OpenPayloadSchema>

/** The one way this provider reaches the Mac: a program and its argv, never a command line. */
export type Runner = (file: string, args: string[]) => Promise<void>

export const runProgram: Runner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: OPEN_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message))
      else resolve()
    })
  })

/** Which program opens which kind of target, as an argv. */
export function argvFor(payload: OpenPayload): [string, string[]] {
  switch (payload.kind) {
    case 'app': return ['open', ['-a', payload.target]]
    case 'url': return ['open', [payload.target]]
    case 'shortcut': return ['shortcuts', ['run', payload.target]]
  }
}

export interface OpenResult { ok: boolean; error?: string }

/**
 * The `shortcuts` channel: one command, `open`, behind a grid of big touch buttons.
 *
 * There is nothing to publish — the provider holds no state a widget could read — so `poll`
 * answers a constant and the channel is only ever used for commands.
 */
export function createShortcutsProvider(run: Runner = runProgram): Provider {
  return {
    channel: 'shortcuts',
    // Nothing to watch; the registry only polls a channel someone subscribed to, and no widget does.
    intervalMs: 60_000,
    poll: async () => ({ ok: true }),
    commands: {
      open: async (payload, ctx?: CommandContext): Promise<OpenResult> => {
        // `open` acts on the user's Mac, so only a client on that Mac may ask for it. Fail
        // closed: a caller that provides no context is treated as remote.
        if (!ctx?.loopback) return { ok: false, error: tr(undefined, 'provider.localOnly') }
        const parsed = OpenPayloadSchema.safeParse(payload)
        if (!parsed.success) {
          return { ok: false, error: parsed.error.issues[0]?.message ?? 'charge utile invalide' }
        }
        const [file, args] = argvFor(parsed.data)
        try {
          await run(file, args)
          return { ok: true }
        } catch (err) {
          return { ok: false, error: (err as Error).message || String(err) }
        }
      },
    },
  }
}
