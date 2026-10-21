import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'

/**
 * Where a project may live: inside the home folder, or on another volume (`/Volumes/<disk>/…`,
 * where many developers keep their code). Everything else — `/`, `/tmp`, `/var/folders` (the
 * throwaway worktrees tools create there), `/Applications`, the system — is never listed, so it
 * can never be opened either. The home folder itself, its `Library` and a bare volume root are
 * not projects.
 */
export function isAllowedProject(path: string, home: string): boolean {
  if (!isAbsolute(path)) return false
  const parts = path.split(sep)
  if (parts.some((p) => p === 'node_modules' || p === '.Trash' || p === '.git')) return false
  if (path.startsWith(home + sep)) {
    const rest = path.slice(home.length + 1)
    return rest !== '' && rest !== 'Library' && !rest.startsWith('Library' + sep)
  }
  // ['', 'Volumes', '<disk>', '<folder>', …]
  return parts[1] === 'Volumes' && parts.length >= 4 && parts[2] !== '' && parts[3] !== ''
}

/**
 * The canonical form of a folder a source reported: symlinks resolved, required to exist, to be
 * a directory and to sit where `isAllowedProject` allows. Null for anything else.
 */
export async function canonicalProject(path: string, home: string): Promise<string | null> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096) return null
  try {
    const real = await realpath(path)
    if (!isAllowedProject(real, home)) return null
    return (await stat(real)).isDirectory() ? real : null
  } catch {
    return null
  }
}

/**
 * Where a git root may be: the home folder or anything under it, or a volume and anything on it.
 * Wider than a project (a root is where the walk starts, not something opened), still never the
 * system.
 */
export async function canonicalRoot(path: string, home: string): Promise<string | null> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096) return null
  try {
    const real = await realpath(path)
    const parts = real.split(sep)
    const allowed = real === home || real.startsWith(home + sep) || (parts[1] === 'Volumes' && parts.length >= 3 && parts[2] !== '')
    return allowed && (await stat(real)).isDirectory() ? real : null
  } catch {
    return null
  }
}

/** `~/Dev/x` → `/Users/me/Dev/x`; anything else unchanged. */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

/** The parent folder as the widget shows it: `~/Dev`, `/Volumes/Dev/clients`. */
export function shortParent(path: string, home: string): string {
  const parent = dirname(path)
  if (parent === home) return '~'
  if (parent.startsWith(home + sep)) return '~' + parent.slice(home.length)
  return parent
}

export function projectName(path: string): string {
  return basename(path) || path
}
