export const ABSOLUTE_WINDOWS = /^[A-Za-z]:\\/
const DEFAULT_SYSTEM_ROOT = 'C:\\Windows'

/** `%SystemRoot%` when it is an absolute `X:\…` path, `C:\Windows` otherwise (never a relative path). */
export function systemRoot(env: Record<string, string | undefined> = process.env): string {
  const value = env.SystemRoot ?? env.SYSTEMROOT ?? env.systemroot
  if (typeof value !== 'string' || !ABSOLUTE_WINDOWS.test(value)) return DEFAULT_SYSTEM_ROOT
  return value.replace(/\\+$/, '')
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


/**
 * The environment a Windows child of the server gets, besides what the macOS list holds: the
 * profile and system locations a program needs to start, and the account name (non-secret; the
 * Claude CLI and git read it). `PATHEXT` and `ComSpec` are left out on purpose: every child here
 * is a `.exe` run by absolute path, and neither is ever needed to find one.
 */
export const WINDOWS_CHILD_ENV_KEYS = [
  'SystemRoot', 'USERPROFILE', 'USERNAME', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'TEMP', 'TMP',
] as const

/**
 * An environment variable by name. Windows names ignore case (`Path`, `SYSTEMROOT`), and an
 * injected plain object does not do that by itself; elsewhere the name is exact. The one lookup
 * every Windows child environment and folder goes through.
 */
export function envValue(env: Record<string, string | undefined>, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (env[name] !== undefined || platform !== 'win32') return env[name]
  const wanted = name.toLowerCase()
  const key = Object.keys(env).find((k) => k.toLowerCase() === wanted)
  return key === undefined ? undefined : env[key]
}

/**
 * A per-user or per-machine folder from the environment (`USERPROFILE`, `LOCALAPPDATA`,
 * `ProgramFiles`), only when it is an absolute `X:\…` path. A missing or relative value yields
 * null, so a caller skips that candidate rather than join onto the current folder.
 */
export function windowsEnvDir(name: string, env: Record<string, string | undefined> = process.env): string | null {
  const value = envValue(env, name, 'win32')
  if (typeof value !== 'string' || !ABSOLUTE_WINDOWS.test(value)) return null
  return value.replace(/(?<=.{3})\\+$/, '')
}

/** `base\segment\…` for each base that is a valid environment folder, in order; none are invented. */
export function windowsUserCandidates(
  parts: ReadonlyArray<readonly [envName: string, relative: string]>,
  env: Record<string, string | undefined> = process.env,
): string[] {
  return parts.flatMap(([name, relative]) => {
    const base = windowsEnvDir(name, env)
    return base ? [`${base}\\${relative}`] : []
  })
}
