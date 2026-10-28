import { targetPlatform } from '../platform/index.js'

/**
 * The WSL distributions the user ticked under Privacy (`privacy.wslDistros`), and where their
 * files are seen from Windows: `\\wsl.localhost\<distro>\…`.
 *
 * Nothing here touches a distribution the user did not tick. `wsl.exe --list` (through the
 * PowerShell host) only names the installed ones and boots none; `wsl.exe -d <distro>` boots the
 * one named, which is why it runs only for a ticked name. Every name is checked against
 * `DISTRO_NAME` before it reaches an argument list or a path.
 */

/** A distribution name as the config, the hook schema and `host.ps1` accept it. */
export const DISTRO_NAME = /^[A-Za-z0-9._-]{1,64}$/

/** The part of `PowerShellHost` the list needs; the tests give a fake. */
export interface WslListHost {
  call<T>(op: 'wsl.list', arg?: unknown, timeoutMs?: number): Promise<T>
}

/**
 * Names from `wsl.exe --list --quiet`. That program writes UTF-16LE, which `host.ps1` decodes;
 * whatever survives of a byte-order mark, a NUL or a carriage return is stripped here too, and a
 * name the schema would refuse is dropped rather than shown.
 */
export function cleanDistroNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const names = raw
    .filter((line): line is string => typeof line === 'string')
    .flatMap((line) => line.split(/\r?\n/))
    .map((line) => line.replace(/[﻿\u0000]/g, '').trim())
    .filter((name) => DISTRO_NAME.test(name))
  return [...new Set(names)]
}

/** The installed distributions on Windows, none anywhere else (nothing is spawned there). */
export async function listDistros(host: WslListHost | (() => WslListHost), platform: NodeJS.Platform = process.platform): Promise<string[]> {
  if (targetPlatform(platform) !== 'win32') return []
  try {
    const h = typeof host === 'function' ? host() : host
    return cleanDistroNames(await h.call<unknown>('wsl.list', undefined, 6000))
  } catch {
    // No WSL, or the host could not answer: there is nothing to offer.
    return []
  }
}
