import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { resolveNative } from './native-tool.js'
import type { CommandContext, Provider } from './types.js'
import { noInstances, type InstanceLookup } from '../config/instances.js'
import { tr } from '../i18n.js'

export const PASTE_PAD_WIDGET = 'paste-pad'
export const MAX_BUTTONS = 24
export const MAX_TEXT = 2000
export const ENTER_MS = 150
export const SWIFT = '/usr/bin/swift'
export const HELPER = fileURLToPath(new URL('./paste-pad-native.swift', import.meta.url))

const NativeResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), error: z.enum(['permission-required', 'unavailable']) }).strict(),
])

export const ButtonSchema = z.object({
  label: z.string().trim().max(120).optional(),
  value: z.string().min(1).max(MAX_TEXT),
  enter: z.boolean().optional(),
})
export type PasteButton = z.infer<typeof ButtonSchema>

export const PasteRequestSchema = z.object({
  instanceId: z.string().min(1).max(200),
  index: z.number().int().min(0).max(MAX_BUTTONS - 1),
})
export type PasteRequest = z.infer<typeof PasteRequestSchema>

export function resolveButton(
  lookup: InstanceLookup,
  request: PasteRequest,
): { ok: true; button: PasteButton } | { ok: false; error: string } {
  const instance = lookup(request.instanceId)
  if (!instance || instance.widgetId !== PASTE_PAD_WIDGET) {
    return { ok: false, error: tr(undefined, 'pastePad.unknownInstance') }
  }
  const buttons = instance.settings.buttons
  if (!Array.isArray(buttons) || request.index >= buttons.length) {
    return { ok: false, error: tr(undefined, 'pastePad.unknownButton') }
  }
  const parsed = ButtonSchema.safeParse(buttons[request.index])
  if (!parsed.success) return { ok: false, error: tr(undefined, 'pastePad.unknownButton') }
  if (parsed.data.value.trim() === '') return { ok: false, error: tr(undefined, 'pastePad.emptyValue') }
  return { ok: true, button: parsed.data }
}

export type Run = (file: string, args: string[]) => Promise<string>

export const runProgram: Run = async (file, args) => {
  const resolved = await resolveNative(file, args)
  return new Promise((resolve, reject) => {
    execFile(resolved.file, resolved.args, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message))
      else resolve(stdout)
    })
  })
}

export interface PasteResult { ok: boolean; error?: string }

/**
 * One swift invocation writes the pasteboard and posts the keystroke through the HID tap —
 * Accessibility is the only grant it needs, which the helper already holds. The osascript +
 * System Events path it replaces also wanted the separate Automation consent, which nobody had
 * been asked for, so every paste came back as a red button.
 */
export function createPastePadProvider(
  run: Run = runProgram,
  instances: InstanceLookup = noInstances,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
): Provider {
  const keystroke = async (args: string[]): Promise<PasteResult> => {
    try {
      const parsed = NativeResult.safeParse(JSON.parse(await run(SWIFT, [HELPER, ...args])))
      if (!parsed.success) return { ok: false, error: tr(undefined, 'pastePad.failed') }
      if (!parsed.data.ok && parsed.data.error === 'permission-required') {
        return { ok: false, error: tr(undefined, 'provider.localOnly') }
      }
      return parsed.data.ok ? { ok: true } : { ok: false, error: tr(undefined, 'pastePad.failed') }
    } catch {
      return { ok: false, error: tr(undefined, 'pastePad.failed') }
    }
  }

  return {
    channel: PASTE_PAD_WIDGET,
    commands: {
      paste: async (payload, ctx?: CommandContext): Promise<PasteResult> => {
        if (!ctx?.loopback) return { ok: false, error: tr(undefined, 'provider.localOnly') }
        const request = PasteRequestSchema.safeParse(payload)
        if (!request.success) return { ok: false, error: tr(undefined, 'provider.invalidPayload') }
        const resolved = resolveButton((id) => instances(id, ctx), request.data)
        if (!resolved.ok) return { ok: false, error: resolved.error }

        const pasted = await keystroke(['paste', resolved.button.value])
        if (!pasted.ok) return pasted
        if (resolved.button.enter) {
          await sleep(ENTER_MS)
          return keystroke(['enter'])
        }
        return { ok: true }
      },
    },
  }
}
