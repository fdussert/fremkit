import { execFile } from 'node:child_process'
import { targetPlatform, windowsTool, WINDOWS_CHILD_ENV_KEYS } from '../platform/index.js'

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

/**
 * A name that may reach `wsl.exe` or a `\\wsl.localhost` path: `DISTRO_NAME`, not made of dots
 * alone (a folder above the share), and not starting with `-` (an option to `wsl.exe`), both of
 * which the schema's characters allow.
 */
export function isDistroName(name: string): boolean {
  return DISTRO_NAME.test(name) && !/^\.+$/.test(name) && !name.startsWith('-')
}

/** How long one read through `\\wsl.localhost` may take before that distro is reported offline. */
export const WSL_READ_TIMEOUT_MS = 5000
/** `printenv HOME` may have to start the distribution first, which takes a few seconds cold. */
const HOME_LOOKUP_TIMEOUT_MS = 15_000

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
    .filter(isDistroName)
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

/** Runs a program by absolute path with an argument list and answers its stdout. */
export type WslRun = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>

const defaultRun: WslRun = (file, args, env) => new Promise((resolve, reject) => {
  execFile(file, args, { env, shell: false, windowsHide: true, timeout: HOME_LOOKUP_TIMEOUT_MS, maxBuffer: 64 * 1024, encoding: 'utf8' },
    (error, stdout) => (error ? reject(Error('offline')) : resolve(String(stdout))))
})

export interface DistroHomeDeps {
  /** The ticked names, `privacy.wslDistros`, read at call time. */
  ticked: readonly string[]
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  run?: WslRun
  /** Tests only: a cache of their own instead of the process-wide one. */
  cache?: Map<string, HomeEntry>
  now?: () => number
}

/**
 * A lookup, pending or settled: the home once found (null until then), and when it failed (null
 * while pending or once it succeeded).
 */
export interface HomeEntry { home: Promise<string | null>; found: string | null; failedAt: number | null }

/** How long a failed lookup (a timeout included) is remembered before one more try. */
export const HOME_RETRY_MS = 60_000

/**
 * Per distribution: a found home for the life of the process, a failure for `HOME_RETRY_MS`, so a
 * broken distribution is not asked every poll but one that comes back is found again.
 */
const HOMES = new Map<string, HomeEntry>()

/**
 * `wsl.exe` gets the Windows locations it needs to start and nothing else: no `WSLENV`, which would
 * forward Windows variables into the distribution, and no `WSL_UTF8`.
 */
function wslEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const key of [...WINDOWS_CHILD_ENV_KEYS, 'PATH']) {
    const found = Object.keys(env).find((name) => name.toLowerCase() === key.toLowerCase())
    if (found !== undefined && env[found] !== undefined) out[key] = env[found]
  }
  return out
}

/** An absolute POSIX path with no `..` segment, no backslash and no control character; null otherwise. */
export function validHome(raw: string): string | null {
  const home = raw.replace(/\r?\n$/, '')
  if (!home.startsWith('/') || home.length > 1024) return null
  if (/[\\\u0000-\u001f\u007f]/.test(home)) return null
  if (home.split('/').includes('..')) return null
  return home
}

/**
 * The home folder of a ticked distribution (`wsl.exe -d <distro> --exec printenv HOME`), asked
 * once per process when found, again a minute after a failure; concurrent asks share one lookup.
 * Null for a name that is not ticked (nothing runs), an invalid name, another
 * platform, or an answer that is not a plain absolute path. The ticked list is checked before
 * the cache, so unticking a distro stops its use at once, and ticking one is never held up by
 * what another name cached.
 */
export async function distroHome(distro: string, deps: DistroHomeDeps): Promise<string | null> {
  if (targetPlatform(deps.platform) !== 'win32') return null
  if (!isDistroName(distro) || !deps.ticked.includes(distro)) return null
  const cache = deps.cache ?? HOMES
  const now = deps.now ?? Date.now
  let entry = cache.get(distro)
  if (entry && entry.failedAt !== null && now() - entry.failedAt >= HOME_RETRY_MS) entry = undefined
  if (!entry) {
    const env = deps.env ?? process.env
    const run = deps.run ?? defaultRun
    const fresh: HomeEntry = { home: Promise.resolve(null), found: null, failedAt: null }
    fresh.home = run(windowsTool('wsl', env), ['-d', distro, '--exec', 'printenv', 'HOME'], wslEnv(env))
      .then((stdout) => validHome(stdout.trim()))
      .catch(() => null)
      .then((home) => {
        if (home === null) fresh.failedAt = now()
        else fresh.found = home
        return home
      })
    entry = fresh
    cache.set(distro, entry)
  }
  return entry.home
}

/** `\\wsl.localhost\<distro>` followed by the home folder with its slashes turned around. */
export function distroRoot(distro: string, home: string): string {
  if (!isDistroName(distro)) throw new Error('invalid-distro')
  const checked = validHome(home)
  if (checked === null) throw new Error('invalid-home')
  return `\\\\wsl.localhost\\${distro}${checked.replace(/\/+$/, '').replace(/\//g, '\\')}`
}

/**
 * Every read through `\\wsl.localhost` goes through this: a stopped or wedged distribution can
 * leave a file call pending for a long time, and one distro must never hold up the others or the
 * poll. Rejects with `offline` after `ms`; the read itself is left to finish on its own.
 */
export function readWithTimeout<T>(fn: () => Promise<T>, ms: number = WSL_READ_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('offline')), ms)
    let started: Promise<T>
    try { started = fn() } catch (error) { clearTimeout(timer); reject(error); return }
    started.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

export interface WslRoot { distro: string; root: string }

/**
 * The home of a ticked distribution if a lookup already found it, without waiting: a missing one
 * is looked up in the background (deduplicated, failures retried after `HOME_RETRY_MS`) and is
 * there at a later poll. A distribution that is slow to start never holds up a poll.
 */
export function knownHome(distro: string, deps: DistroHomeDeps): string | null {
  if (targetPlatform(deps.platform) !== 'win32') return null
  if (!isDistroName(distro) || !deps.ticked.includes(distro)) return null
  // Starts or joins the lookup; the entry is in the cache once this returns.
  void distroHome(distro, deps)
  return (deps.cache ?? HOMES).get(distro)?.found ?? null
}

/**
 * The ticked distributions whose home is already known, in the order they were ticked. Never
 * waits for a lookup: see `knownHome`.
 */
export async function wslRoots(deps: DistroHomeDeps): Promise<WslRoot[]> {
  if (targetPlatform(deps.platform) !== 'win32') return []
  const names = [...new Set(deps.ticked)].filter(isDistroName)
  return names.flatMap((distro) => {
    const home = knownHome(distro, deps)
    return home ? [{ distro, root: distroRoot(distro, home) }] : []
  })
}
