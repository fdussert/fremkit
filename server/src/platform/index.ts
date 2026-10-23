/**
 * The platform table's key, and the Windows system locations everything else is built from.
 *
 * Only `darwin` and `win32` are real targets. Any other platform (the Linux CI, the e2e runs) is
 * treated as `darwin`, so those environments keep today's behaviour.
 */
export type Platform = 'darwin' | 'win32'

export function targetPlatform(p: NodeJS.Platform = process.platform): Platform {
  return p === 'win32' ? 'win32' : 'darwin'
}

export { systemRoot, windowsTool, windowsEnvDir, windowsUserCandidates, WINDOWS_CHILD_ENV_KEYS, ABSOLUTE_WINDOWS } from './windows-tools.js'
export type { WindowsTool } from './windows-tools.js'
import { ABSOLUTE_WINDOWS, systemRoot } from './windows-tools.js'

/** The macOS system folders, first on `PATH`. */
export const SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'] as const

function windowsSystemDirs(env: Record<string, string | undefined>): string[] {
  const root = systemRoot(env)
  return [`${root}\\System32`, root, `${root}\\System32\\Wbem`, `${root}\\System32\\WindowsPowerShell\\v1.0`]
}

/**
 * The `PATH` the server runs its children with: the system's own folders first, then the rest in
 * their order. Relative and empty entries (which mean "the current folder") are dropped, and so
 * are repeats (case-insensitively on Windows).
 */
export function safePath(path: string | undefined, platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): string {
  if (targetPlatform(platform) === 'win32') {
    const system = windowsSystemDirs(env)
    const seen = new Set(system.map((dir) => dir.toLowerCase()))
    const rest: string[] = []
    for (const entry of (path ?? '').split(';')) {
      // Windows allows a quoted entry and a trailing backslash; neither changes the folder.
      const dir = entry.trim().replace(/^"(.*)"$/, '$1').replace(/(?<=.{4})\\+$/, '')
      if (!ABSOLUTE_WINDOWS.test(dir) || seen.has(dir.toLowerCase())) continue
      seen.add(dir.toLowerCase())
      rest.push(dir)
    }
    return [...system, ...rest].join(';')
  }
  const rest = (path ?? '').split(':').filter((dir) => dir.startsWith('/') && !(SYSTEM_DIRS as readonly string[]).includes(dir))
  return [...SYSTEM_DIRS, ...new Set(rest)].join(':')
}
