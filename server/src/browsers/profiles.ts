import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * A Chromium browser whose profiles a shortcut may open a link in.
 *
 * A closed list: the bundle is looked up by its own name in the Applications folders, and the
 * profiles are read from the browser's own data folder. Nothing a setting says names a program.
 */
interface KnownBrowser {
  /** What the editor shows and what the saved value starts with: "Brave — Perso". */
  name: string
  /** The bundle's file name, looked up in `/Applications` then `~/Applications`. */
  app: string
  /** The browser's data folder, under `~/Library/Application Support`. */
  data: string
}

export const BROWSERS: readonly KnownBrowser[] = [
  { name: 'Brave', app: 'Brave Browser.app', data: 'BraveSoftware/Brave-Browser' },
  { name: 'Chrome', app: 'Google Chrome.app', data: 'Google/Chrome' },
  { name: 'Edge', app: 'Microsoft Edge.app', data: 'Microsoft Edge' },
]

/** One profile of an installed browser, as the editor offers it. */
export interface BrowserProfile {
  browser: string
  /** The name the user gave the profile in the browser ("Perso"), never the account's e-mail. */
  name: string
  /** What a shortcut saves: `<browser> — <profile name>`. */
  value: string
}

/** The program to open and the profile folder to pass it, for one saved value. */
export type ResolvedProfile = { ok: true; app: string; dir: string } | { ok: false; error: 'unknownBrowser' | 'unknownProfile' }

/**
 * A profile folder name as Chromium writes them ("Default", "Profile 3"): no separator, no
 * dot-only name, so it can never leave the browser's data folder.
 */
const PROFILE_DIR_RE = /^(?!\.+$)[A-Za-z0-9 ._-]{1,64}$/

/** `Brave — Perso`; an en dash or a hyphen is accepted too, since that is what people type. */
const VALUE_RE = /^\s*(\S+)\s+[—–-]\s+(.+?)\s*$/

/** How many profiles one browser may list, so a damaged `Local State` cannot grow the answer forever. */
const MAX_PROFILES = 50

/** How far the folders are probed when `Local State` cannot be read: `Profile 1` to `Profile 20`. */
const PROBED_PROFILES = 20

export const profileValue = (browser: string, name: string): string => `${browser} — ${name}`

export interface BrowserProfilesOptions {
  home?: string
  /** Folders searched for the bundles, in order. */
  appDirs?: string[]
}

export class BrowserProfiles {
  private readonly home: string
  private readonly appDirs: string[]

  constructor(opts: BrowserProfilesOptions = {}) {
    this.home = opts.home ?? homedir()
    this.appDirs = opts.appDirs ?? ['/Applications', join(this.home, 'Applications')]
  }

  /** Every profile of every installed browser of the list, in the browser's own order. */
  async list(): Promise<BrowserProfile[]> {
    const out: BrowserProfile[] = []
    for (const browser of BROWSERS) {
      if (!(await this.appOf(browser))) continue
      for (const { name } of await this.profilesOf(browser)) out.push({ browser: browser.name, name, value: profileValue(browser.name, name) })
    }
    return out
  }

  /**
   * The bundle and the profile folder a saved value names.
   *
   * The profile is matched on the name the browser shows first, then on the folder name, which
   * covers a profile typed by hand ("Brave — Profile 3"). Either way the folder has to exist.
   */
  async resolve(value: string): Promise<ResolvedProfile> {
    const match = VALUE_RE.exec(value)
    const browser = match ? BROWSERS.find((b) => b.name.toLowerCase() === match[1]!.toLowerCase()) : undefined
    const app = browser ? await this.appOf(browser) : null
    if (!match || !browser || !app) return { ok: false, error: 'unknownBrowser' }
    const wanted = match[2]!.toLowerCase()
    const profiles = await this.profilesOf(browser)
    const dir = profiles.find((p) => p.name.toLowerCase() === wanted)?.dir ?? match[2]!
    if (!PROFILE_DIR_RE.test(dir) || !(await isDir(join(this.dataOf(browser), dir)))) return { ok: false, error: 'unknownProfile' }
    return { ok: true, app, dir }
  }

  private dataOf(browser: KnownBrowser): string {
    return join(this.home, 'Library', 'Application Support', browser.data)
  }

  private async appOf(browser: KnownBrowser): Promise<string | null> {
    for (const dir of this.appDirs) {
      const path = join(dir, browser.app)
      if (await isDir(path)) return path
    }
    return null
  }

  /**
   * The profiles `Local State` lists: only each one's folder and display name are read.
   *
   * macOS keeps another application's data from a process that was not granted access to it
   * (Full Disk Access): the file cannot be opened, though a folder in it can still be looked at.
   * The profiles are then the folders Chromium names, found one by one, under their folder name.
   */
  private async profilesOf(browser: KnownBrowser): Promise<{ dir: string; name: string }[]> {
    let state: unknown
    try {
      state = JSON.parse(await readFile(join(this.dataOf(browser), 'Local State'), 'utf8'))
    } catch {
      return this.probedProfiles(browser)
    }
    const cache = (state as { profile?: { info_cache?: unknown } } | null)?.profile?.info_cache
    if (!cache || typeof cache !== 'object') return []
    return Object.entries(cache as Record<string, { name?: unknown } | null>)
      .filter(([dir, info]) => PROFILE_DIR_RE.test(dir) && typeof info?.name === 'string' && info.name.trim() !== '')
      .slice(0, MAX_PROFILES)
      .map(([dir, info]) => ({ dir, name: (info!.name as string).trim().slice(0, 100) }))
  }

  private async probedProfiles(browser: KnownBrowser): Promise<{ dir: string; name: string }[]> {
    const base = this.dataOf(browser)
    const dirs = ['Default', ...Array.from({ length: PROBED_PROFILES }, (_, i) => `Profile ${i + 1}`)]
    const found = await Promise.all(dirs.map((dir) => isDir(join(base, dir))))
    return dirs.filter((_, i) => found[i]).map((dir) => ({ dir, name: dir }))
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
