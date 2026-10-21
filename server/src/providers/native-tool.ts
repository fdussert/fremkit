import { execFile as nodeExecFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(nodeExecFile)
const SWIFTC = '/usr/bin/swiftc'
const COMPILE_TIMEOUT_MS = 60_000
const RETRY_FAILED_AFTER_MS = 60_000
const CACHE_DIR = join(tmpdir(), 'fremkit-native')

const inflight = new Map<string, Promise<string | null>>()
const failedAt = new Map<string, number>()

async function compile(script: string): Promise<string | null> {
  try {
    const hash = createHash('sha256').update(await readFile(script)).digest('hex').slice(0, 16)
    const binary = join(CACHE_DIR, `${basename(script, '.swift')}-${hash}`)
    try { await access(binary); return binary } catch { /* stale or missing: build below */ }
    await mkdir(CACHE_DIR, { recursive: true })
    await execFileAsync(SWIFTC, ['-O', '-o', binary, script], { timeout: COMPILE_TIMEOUT_MS, shell: false })
    return binary
  } catch {
    failedAt.set(script, Date.now())
    return null
  }
}

/**
 * `swift file.swift` re-drives the compiler frontend on every call — several hundred
 * milliseconds before the script's first line. When the script's current content has already
 * been built into `$TMPDIR/fremkit-native`, run that binary instead; any compile or lookup
 * failure falls back to the interpreter so a missing toolchain never breaks a widget.
 */
export async function resolveNative(file: string, args: string[]): Promise<{ file: string; args: string[] }> {
  const script = args[0]
  if (file !== '/usr/bin/swift' || !script?.endsWith('.swift')) return { file, args }
  const failed = failedAt.get(script)
  if (failed !== undefined && Date.now() - failed < RETRY_FAILED_AFTER_MS) return { file, args }
  let job = inflight.get(script)
  if (!job) {
    job = compile(script).finally(() => inflight.delete(script))
    inflight.set(script, job)
  }
  const binary = await job
  return binary ? { file: binary, args: args.slice(1) } : { file, args }
}
