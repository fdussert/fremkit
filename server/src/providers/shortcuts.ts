import { execFile } from 'node:child_process'
import { z } from 'zod'
import type { CommandContext, Provider } from './types.js'
import { noInstances, type InstanceLookup } from '../config/instances.js'
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
  }, { error: () => tr(undefined, 'provider.refusedUrl') })

/**
 * A button as the user saved it in the admin.
 *
 * This is the *only* shape that ever reaches `open`. It is validated here rather than trusted
 * because a saved button can still be half-typed, or written by a config edited by hand.
 */
export const OpenPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('app'), target: NameSchema }),
  z.object({ kind: z.literal('shortcut'), target: NameSchema }),
  z.object({ kind: z.literal('url'), target: UrlSchema }),
])
export type OpenPayload = z.infer<typeof OpenPayloadSchema>

/** The `buttons` list the widget's manifest caps at 24. */
const MAX_BUTTONS = 24

/**
 * What a widget may ask for: which of *its own* buttons to press.
 *
 * It names its instance and an index, never a target. The manifest says which channel a widget
 * may command; it has never said which application, URL or Shortcut — so before this, any widget
 * declaring `shortcuts` could run anything on the Mac. Now the host resolves the target from
 * that instance's saved settings, and a button the user never created cannot be pressed.
 */
export const OpenRequestSchema = z.object({
  instanceId: z.string().min(1).max(200),
  index: z.number().int().min(0).max(MAX_BUTTONS - 1),
})

/** The widget whose saved buttons this channel acts on. */
const SHORTCUTS_WIDGET = 'shortcuts'

/** The saved button at `index` of one instance, or a reason it cannot be used. */
export function resolveButton(
  lookup: InstanceLookup,
  request: z.infer<typeof OpenRequestSchema>,
): { ok: true; payload: OpenPayload } | { ok: false; error: string } {
  const instance = lookup(request.instanceId)
  // An unknown instance, or one that is not a shortcuts widget, is a caller reaching for
  // somebody else's settings.
  if (!instance || instance.widgetId !== SHORTCUTS_WIDGET) {
    return { ok: false, error: tr(undefined, 'shortcuts.unknownInstance') }
  }
  const buttons = instance.settings.buttons
  if (!Array.isArray(buttons) || request.index >= buttons.length) {
    return { ok: false, error: tr(undefined, 'shortcuts.unknownButton') }
  }
  const parsed = OpenPayloadSchema.safeParse(buttons[request.index])
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? tr(undefined, 'shortcuts.unknownButton') }
  }
  return { ok: true, payload: parsed.data }
}

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
export function createShortcutsProvider(
  run: Runner = runProgram,
  instances: InstanceLookup = noInstances,
): Provider {
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
        const request = OpenRequestSchema.safeParse(payload)
        if (!request.success) {
          return { ok: false, error: request.error.issues[0]?.message ?? tr(undefined, 'provider.invalidPayload') }
        }
        // The target comes from the user's saved settings, never from the message.
        const resolved = resolveButton(instances, request.data)
        if (!resolved.ok) return { ok: false, error: resolved.error }
        const [file, args] = argvFor(resolved.payload)
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
