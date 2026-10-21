import { randomUUID } from 'node:crypto'
import { execFile as nodeExecFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { CommandContext, Provider } from './types.js'

const execFile = promisify(nodeExecFile)
const ActionSchema = z.enum(['left-half', 'right-half', 'fill', 'next-display'])
export type RectangleAction = z.infer<typeof ActionSchema>
const InspectSchema = z.object({}).strict()
const RunSchema = z.object({ action: ActionSchema, targetToken: z.string().uuid() }).strict()
const NativeTargetSchema = z.object({
  pid: z.number().int().positive(),
  bundleId: z.string().min(1).max(255),
  title: z.string().max(1024),
  application: z.string().min(1).max(255),
  windowID: z.number().int().positive().max(0xffff_ffff),
})

const SWIFT = '/usr/bin/swift'
const HELPER = fileURLToPath(new URL('./rectangle-native.swift', import.meta.url))
const TARGET_LIFETIME_MS = 5 * 60_000
const MAX_TARGETS = 32
const COMMAND_TIMEOUT_MS = 15_000

export type Runner = (file: string, args: string[]) => Promise<string>
type Target = z.infer<typeof NativeTargetSchema>
type NativeResponse = { ok: boolean; error?: string; target?: Target; changed?: boolean }

export function nativeInvocationFor(action: RectangleAction): string[] {
  switch (action) {
    case 'left-half': return ['menu', 'Window', 'Move & Resize', 'Left']
    case 'right-half': return ['menu', 'Window', 'Move & Resize', 'Right']
    case 'fill': return ['menu', 'Window', 'Fill']
    case 'next-display': return ['position', 'next-display']
  }
}

const runProgram: Runner = async (file, args) => {
  const { stdout } = await execFile(file, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 32 * 1024 })
  return stdout
}

/** Kept exported so tests can prove the only executable is Swift and input is argv, not shell. */
export function nativeArgsFor(mode: 'inspect'): string[]
export function nativeArgsFor(action: RectangleAction, target: Target): string[]
export function nativeArgsFor(modeOrAction: 'inspect' | RectangleAction, target?: Target): string[] {
  if (modeOrAction === 'inspect') return [HELPER, 'inspect']
  if (!target) throw new Error('native target required')
  return [HELPER, 'run', String(target.pid), target.bundleId, target.title, String(target.windowID), ...nativeInvocationFor(modeOrAction)]
}

function parseResponse(stdout: string): NativeResponse | null {
  try {
    return z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      target: NativeTargetSchema.optional(),
      changed: z.boolean().optional(),
    }).strict().parse(JSON.parse(stdout))
  } catch {
    return null
  }
}

/**
 * Uses macOS Accessibility APIs and the system display geometry. The widget can act only on a
 * window it explicitly inspected, and the helper verifies its session-unique window ID again.
 */
export function createRectangleProvider(run: Runner = runProgram, now: () => number = Date.now): Provider {
  const targets = new Map<string, { target: Target; expiresAt: number }>()

  return {
    channel: 'rectangle',
    commands: {
      async ['inspect-target'](payload: unknown, context?: CommandContext) {
        if (!context?.loopback) return { ok: false, error: 'local-only' }
        if (!InspectSchema.safeParse(payload).success) return { ok: false, error: 'invalid-request' }
        try {
          const response = parseResponse(await run(SWIFT, nativeArgsFor('inspect')))
          if (!response?.ok || !response.target) return { ok: false, error: 'no-target' }
          const token = randomUUID()
          if (targets.size >= MAX_TARGETS) {
            for (const [key, value] of targets) if (value.expiresAt <= now()) targets.delete(key)
            if (targets.size >= MAX_TARGETS) targets.delete(targets.keys().next().value!)
          }
          targets.set(token, { target: response.target, expiresAt: now() + TARGET_LIFETIME_MS })
          return { ok: true, target: { token, application: response.target.application } }
        } catch {
          return { ok: false, error: 'native-window-access-unavailable' }
        }
      },
      async run(payload: unknown, context?: CommandContext) {
        if (!context?.loopback) return { ok: false, error: 'local-only' }
        const parsed = RunSchema.safeParse(payload)
        if (!parsed.success) return { ok: false, error: 'invalid-request' }
        const stored = targets.get(parsed.data.targetToken)
        targets.delete(parsed.data.targetToken)
        if (!stored || stored.expiresAt <= now()) return { ok: false, error: 'target-expired' }
        try {
          const response = parseResponse(await run(SWIFT, nativeArgsFor(parsed.data.action, stored.target)))
          if (!response?.ok || response.changed !== true) {
            return { ok: false, error: response?.error ?? 'geometry-unverified' }
          }
          return { ok: true, changed: true }
        } catch {
          return { ok: false, error: 'native-window-action-unavailable' }
        }
      },
    },
  }
}
