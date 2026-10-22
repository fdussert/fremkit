/**
 * The exact command of a running process, for a restart: `fremkit-scan procargs <pid>` (the
 * helper's scanner, `FREMKIT_SCANNER`) reads `KERN_PROCARGS2` and prints one JSON line on stdout,
 * `{"type":"procargs","exe":…,"argv":[…],"env":{…}|null}`, or `{"type":"error","code":…}` with a
 * non-zero exit. `ps` joins the arguments with spaces, which cannot be replayed; this cannot be
 * misread.
 *
 * The line carries the process's environment, which can hold secrets: it is parsed here, handed
 * back to the caller for one spawn and never logged, kept or quoted. Every failure is a code only.
 */

import { execFile } from 'node:child_process'
import { z } from 'zod'
import { localEnv } from '../../providers/local-operations.js'

export type ProcArgs = { exe: string; argv: string[]; env: Record<string, string> }

/** The scanner's own codes, `hidden` for an environment the kernel did not give, `invalid` for anything unreadable. */
export type ProcArgsErrorCode = 'no-such-process' | 'denied' | 'failed' | 'hidden' | 'invalid'

export class ProcArgsError extends Error {
  constructor(readonly code: ProcArgsErrorCode) {
    super(`procargs: ${code}`)
    this.name = 'ProcArgsError'
  }
}

/** Generous for an argv and an environment (macOS's ARG_MAX is 1 MB), and a bound all the same. */
const MAX_BUFFER = 4 * 1024 * 1024
const TIMEOUT_MS = 5_000

const Ok = z.object({
  type: z.literal('procargs'),
  exe: z.string().min(2).startsWith('/'),
  argv: z.array(z.string()).min(1),
  env: z.record(z.string(), z.string()).nullable(),
})
const Failure = z.object({ type: z.literal('error'), code: z.enum(['no-such-process', 'denied', 'failed']) })

/**
 * The one line the scanner printed. A hidden environment is refused rather than replaced by
 * Fremkit's own: the server would come back with someone else's variables.
 */
export function parseProcArgs(out: string): ProcArgs {
  const line = out.split('\n').find((l) => l.trim() !== '') ?? ''
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    throw new ProcArgsError('invalid')
  }
  const failure = Failure.safeParse(raw)
  if (failure.success) throw new ProcArgsError(failure.data.code)
  const ok = Ok.safeParse(raw)
  if (!ok.success) throw new ProcArgsError('invalid')
  if (ok.data.env === null) throw new ProcArgsError('hidden')
  return { exe: ok.data.exe, argv: ok.data.argv, env: ok.data.env }
}

/** Runs the scanner and resolves its stdout, whatever its exit: an error line comes with exit 1. */
export type RunScanner = (scanner: string, args: string[]) => Promise<string>

export const runScanner: RunScanner = (scanner, args) =>
  new Promise((resolve, reject) => {
    execFile(scanner, args, { env: localEnv(process.env), timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, shell: false, encoding: 'utf8' }, (error, stdout) => {
      if (typeof stdout === 'string' && stdout.length > 0) return resolve(stdout)
      // Never the error itself: Node's message for a failed exec quotes nothing secret, but its
      // object carries stdout, which here is the environment.
      reject(new ProcArgsError(error ? 'failed' : 'invalid'))
    })
  })

export async function readProcArgs(scanner: string, pid: number, run: RunScanner = runScanner): Promise<ProcArgs> {
  if (!Number.isInteger(pid) || pid <= 1) throw new ProcArgsError('invalid')
  let out: string
  try {
    out = await run(scanner, ['procargs', String(pid)])
  } catch {
    throw new ProcArgsError('failed')
  }
  return parseProcArgs(out)
}
