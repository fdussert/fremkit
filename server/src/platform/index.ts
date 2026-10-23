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

const ABSOLUTE_WINDOWS = /^[A-Za-z]:\\/
const DEFAULT_SYSTEM_ROOT = 'C:\\Windows'

/** `%SystemRoot%` when it is an absolute `X:\…` path, `C:\Windows` otherwise (never a relative path). */
export function systemRoot(env: Record<string, string | undefined> = process.env): string {
  const value = env.SystemRoot ?? env.SYSTEMROOT ?? env.systemroot
  if (typeof value !== 'string' || !ABSOLUTE_WINDOWS.test(value)) return DEFAULT_SYSTEM_ROOT
  return value.length > 3 ? value.replace(/\\+$/, '') : value
}

/** The system tools the server runs on Windows, always by absolute path. */
export type WindowsTool = 'powershell' | 'icacls' | 'whoami' | 'ping' | 'rundll32' | 'wsl'

const TOOL_PATHS: Record<WindowsTool, string> = {
  powershell: 'System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  icacls: 'System32\\icacls.exe',
  whoami: 'System32\\whoami.exe',
  ping: 'System32\\PING.EXE',
  rundll32: 'System32\\rundll32.exe',
  wsl: 'System32\\wsl.exe',
}

export function windowsTool(name: WindowsTool, env: Record<string, string | undefined> = process.env): string {
  return `${systemRoot(env)}\\${TOOL_PATHS[name]}`
}

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
    for (const dir of (path ?? '').split(';')) {
      if (!ABSOLUTE_WINDOWS.test(dir) || seen.has(dir.toLowerCase())) continue
      seen.add(dir.toLowerCase())
      rest.push(dir)
    }
    return [...system, ...rest].join(';')
  }
  const rest = (path ?? '').split(':').filter((dir) => dir.startsWith('/') && !(SYSTEM_DIRS as readonly string[]).includes(dir))
  return [...SYSTEM_DIRS, ...new Set(rest)].join(':')
}
