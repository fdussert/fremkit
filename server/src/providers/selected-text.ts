import { execFile as nodeExecFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { z } from 'zod'
import { resolveNative } from './native-tool.js'

const execFile = promisify(nodeExecFile)
const SWIFT = '/usr/bin/swift'
const HELPER = fileURLToPath(new URL('./selected-text-native.swift', import.meta.url))
const TIMEOUT_MS = 5000
const NativeResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), text: z.string() }).strict(),
  z.object({ ok: z.literal(false), error: z.enum(['permission-required', 'secure-field', 'no-selection', 'unavailable']) }).strict(),
])

export type SelectedTextResult = z.infer<typeof NativeResult>
export type SelectedTextRunner = (file: string, args: string[]) => Promise<string>

const runProgram: SelectedTextRunner = async (file, args) => {
  const resolved = await resolveNative(file, args)
  const { stdout } = await execFile(resolved.file, resolved.args, { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024, shell: false })
  return stdout
}

/** Reads the current focused selection through Accessibility without activating an app or touching the pasteboard. */
export function createSelectedTextReader(run: SelectedTextRunner = runProgram): () => Promise<SelectedTextResult> {
  return createSelectedTextMode('read', run)
}

/**
 * Reads the selection by posting ⌘C to the focused app and watching the pasteboard change —
 * the path for apps that never publish AXSelectedText. The pasteboard is consumed: callers
 * that do not need it afterwards should restore or replace it.
 */
export function createSelectedTextCopier(run: SelectedTextRunner = runProgram): () => Promise<SelectedTextResult> {
  return createSelectedTextMode('copy', run)
}

function createSelectedTextMode(mode: 'read' | 'copy', run: SelectedTextRunner): () => Promise<SelectedTextResult> {
  return async () => {
    try {
      const response = NativeResult.safeParse(JSON.parse(await run(SWIFT, [HELPER, mode])))
      return response.success ? response.data : { ok: false, error: 'unavailable' }
    } catch {
      return { ok: false, error: 'unavailable' }
    }
  }
}

/** Posts ⌘V to the focused app — the paste half of copy→translate→paste. */
export function createSelectionPaster(run: SelectedTextRunner = runProgram): () => Promise<void> {
  return async () => {
    const response = NativeResult.safeParse(JSON.parse(await run(SWIFT, [HELPER, 'paste'])))
    if (!response.success || !response.data.ok) throw new Error(response.success && !response.data.ok ? response.data.error : 'unavailable')
  }
}

export const readSelectedText = createSelectedTextReader()
export const copySelectedText = createSelectedTextCopier()
export const pasteSelection = createSelectionPaster()
