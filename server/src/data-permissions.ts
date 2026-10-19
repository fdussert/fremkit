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
 */

import { chmod, lstat, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** More entries than a data folder holds; a folder past this is left as it is beyond it. */
const MAX_ENTRIES = 50_000

/** Tightens `dir` and what it holds; returns how many modes changed. Never throws. */
export async function tightenDataDir(dir: string): Promise<number> {
  let changed = 0
  let seen = 0
  await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {})
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
