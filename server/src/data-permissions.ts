/**
 * The data folder is this account's alone: `0700`, and everything in it `0600` (`0700` for
 * folders).
 *
 * It holds the dashboard (`fremkit.json` and its backups, which name LAN hosts and coordinates),
 * the disk map's caches (home-folder names), the Claude caches, the installed widgets. Written
 * with the default umask they came out `0644` in `0755` folders, which in a checkout anyone with
 * an account on the Mac can read. The server now runs with a `077` umask (index.ts), so new files
 * are born private; this takes the ones an earlier version left behind down to the same modes,
 * once at start. Links are not followed and not changed. Group and other bits are removed and
 * nothing else is touched, so an owner's own bits stay what they were.
 *
 * On Windows there are no such bits: the folder gets an ACL instead, the user and SYSTEM only,
 * inheritance from the parent removed and the grant inherited by everything created later.
 */

import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { windowsTool } from './platform/windows-tools.js'

/** How a program is run for the ACL: file and argument list, never a shell. */
export type AclExec = (file: string, args: string[]) => Promise<{ stdout: string }>

/** Why the ACL was not applied: fixed codes for the log, never a SID, a name or an error text. */
export type AclFailure = 'acl-whoami-failed' | 'acl-sid-invalid' | 'acl-icacls-failed' | 'acl-icacls-partial'

export interface AclDeps {
  platform?: NodeJS.Platform
  exec?: AclExec
  /** Called once with the code when the ACL could not be (fully) applied. */
  log?: (code: AclFailure) => void
  /** Reset what the folder already holds to inherit from it (default true). A folder only written to later needs no walk. */
  recurse?: boolean
}

const run = promisify(execFile)
const defaultExec: AclExec = async (file, args) => {
  const { stdout } = await run(file, args, { windowsHide: true, timeout: 30_000 })
  return { stdout: String(stdout) }
}

const USER_SID = /^S-1-5-21(-\d+){4}$/
const SYSTEM_SID = 'S-1-5-18'
let userSid: string | null = null

/** The account's SID from `whoami /user`: the second CSV column, whatever language the first is in. */
async function currentUserSid(exec: AclExec, cache: boolean): Promise<string> {
  if (cache && userSid) return userSid
  let stdout: string
  try {
    stdout = (await exec(windowsTool('whoami'), ['/user', '/fo', 'csv', '/nh'])).stdout
  } catch {
    throw new AclError('acl-whoami-failed')
  }
  const line = stdout.split(/\r?\n/).find((l) => l.trim() !== '')
  const sid = line?.match(/^"[^"]*","([^"]*)"\s*$/)?.[1] ?? null
  if (!sid || !USER_SID.test(sid)) throw new AclError('acl-sid-invalid')
  if (cache) userSid = sid
  return sid
}

class AclError extends Error {
  constructor(readonly code: AclFailure) { super(code) }
}

/**
 * `icacls /C /Q` keeps going past a file it cannot change and says so only in its last line,
 * which is localized ("Successfully processed 1 files; Failed processing 0 files"). The line
 * has exactly two numbers in every language, processed then failed, so the second is read.
 * Anything else (no such line) is not treated as partial.
 */
function failedCount(stdout: string): number {
  const last = stdout.split(/\r?\n/).filter((l) => l.trim() !== '').pop() ?? ''
  const numbers = last.match(/\d+/g)
  return numbers && numbers.length === 2 ? Number(numbers[1]) : 0
}

/** One icacls call: a failure to run is `acl-icacls-failed`, a non-zero failed count `acl-icacls-partial`. */
async function icacls(exec: AclExec, args: string[]): Promise<void> {
  let stdout: string
  try {
    stdout = (await exec(windowsTool('icacls'), args)).stdout
  } catch {
    throw new AclError('acl-icacls-failed')
  }
  if (failedCount(stdout) > 0) throw new AclError('acl-icacls-partial')
}

/**
 * Whether the folder still inherits from its parent, i.e. has not been restricted yet (or someone
 * turned inheritance back on). One read-only icacls call: an inherited entry is marked `(I)`, in
 * every language. An answer with no entry at all, or a failure, counts as "yes": the walk runs.
 */
async function inheritsFromParent(exec: AclExec, dir: string): Promise<boolean> {
  let stdout: string
  try {
    stdout = (await exec(windowsTool('icacls'), [dir])).stdout
  } catch {
    return true
  }
  const entries = stdout.split(dir).join('').split(/\r?\n/).filter((line) => line.includes(':('))
  return entries.length === 0 || entries.some((line) => line.includes('(I)'))
}

/**
 * Restricts a Windows folder to this user and SYSTEM, inherited by what it holds. True when
 * applied; false when not (off Windows, or a failure, reported once through `deps.log`).
 */
export async function restrictToUser(dir: string, deps: AclDeps = {}): Promise<boolean> {
  if ((deps.platform ?? process.platform) !== 'win32') return false
  const exec = deps.exec ?? defaultExec
  try {
    const sid = await currentUserSid(exec, deps.exec === undefined)
    // The walk below can take long on a big data folder, so it runs only while the folder is not
    // restricted yet: once it is, what is created in it inherits the grant by itself.
    const walk = deps.recurse !== false && (await readdir(dir).catch(() => [])).length > 0
      && await inheritsFromParent(exec, dir)
    // The folder itself first: protected, user and SYSTEM only. No /T here: `/inheritance:r` on a
    // file strips what it inherited and the (OI)(CI) grant does not apply to a file, leaving an empty ACL.
    await icacls(exec, [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, `*${SYSTEM_SID}:(OI)(CI)F`, '/C', '/Q'])
    // Then everything already in it goes back to inheriting from it (`/reset` also clears any
    // explicit entry). icacls expands the `*` itself; it fails on an empty folder, so only run it
    // when there is something to reset. `/L` acts on a symbolic link or junction itself, never on
    // its target: a `widgets-dev` linked to a source tree keeps its own ACL.
    if (walk) {
      await icacls(exec, [`${dir.replace(/[\\/]+$/, '')}\\*`, '/reset', '/T', '/C', '/L', '/Q'])
    }
    return true
  } catch (error) {
    deps.log?.(error instanceof AclError ? error.code : 'acl-icacls-failed')
    return false
  }
}

/** More entries than a data folder holds; a folder past this is left as it is beyond it. */
const MAX_ENTRIES = 50_000

/**
 * Tightens `dir` and what it holds; returns how many modes changed (on Windows 1 when the ACL
 * was applied, else 0). Never throws.
 */
export async function tightenDataDir(dir: string, deps: AclDeps = {}): Promise<number> {
  let changed = 0
  let seen = 0
  await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {})
  if ((deps.platform ?? process.platform) === 'win32') return (await restrictToUser(dir, deps)) ? 1 : 0
  const visit = async (path: string): Promise<void> => {
    if (++seen > MAX_ENTRIES) return
    let info
    try { info = await lstat(path) } catch { return }
    if (info.isSymbolicLink()) return
    const mode = info.mode & 0o777
    const wanted = info.isDirectory() ? (mode & 0o700) | 0o700 : mode & 0o700
    if (mode !== wanted) {
      try { await chmod(path, wanted); changed++ } catch { /* not ours to change */ }
    }
    if (!info.isDirectory()) return
    let names: string[]
    try { names = await readdir(path) } catch { return }
    for (const name of names) await visit(join(path, name))
  }
  await visit(dir)
  return changed
}
