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

export interface AclDeps { platform?: NodeJS.Platform; exec?: AclExec }

const run = promisify(execFile)
const defaultExec: AclExec = async (file, args) => {
  const { stdout } = await run(file, args, { windowsHide: true, timeout: 30_000 })
  return { stdout: String(stdout) }
}

const USER_SID = /^S-1-5-21(-\d+){4}$/
const SYSTEM_SID = 'S-1-5-18'
let userSid: string | null = null

/** The account's SID from `whoami /user`: the second CSV column, whatever language the first is in. */
async function currentUserSid(exec: AclExec, cache: boolean): Promise<string | null> {
  if (cache && userSid) return userSid
  const { stdout } = await exec(windowsTool('whoami'), ['/user', '/fo', 'csv', '/nh'])
  const line = stdout.split(/\r?\n/).find((l) => l.trim() !== '')
  const sid = line?.match(/^"[^"]*","([^"]*)"\s*$/)?.[1] ?? null
  if (!sid || !USER_SID.test(sid)) return null
  if (cache) userSid = sid
  return sid
}

/** Restricts a Windows folder to this user and SYSTEM, inherited by what it holds. False when not applied. */
export async function restrictToUser(dir: string, deps: AclDeps = {}): Promise<boolean> {
  if ((deps.platform ?? process.platform) !== 'win32') return false
  const exec = deps.exec ?? defaultExec
  try {
    const sid = await currentUserSid(exec, deps.exec === undefined)
    if (!sid) return false
    await exec(windowsTool('icacls'), [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, `*${SYSTEM_SID}:(OI)(CI)F`, '/T', '/C', '/Q'])
    return true
  } catch {
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
