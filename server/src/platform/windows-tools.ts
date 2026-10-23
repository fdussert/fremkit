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

