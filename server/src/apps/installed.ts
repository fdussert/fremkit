import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * A bundle identifier that is allowed to become a file name.
 *
 * Stricter than the Dock's own rule: this one is used before the icon cache touches the disk, so
 * it accepts only what a real reverse-DNS identifier is made of and nothing that could traverse.
 */
export const APP_BUNDLE_ID_RE = /^[A-Za-z0-9.-]+$/

/** How long a scan is reused. Applications are installed rarely; a scan reads hundreds of plists. */
export const INSTALLED_TTL_MS = 10 * 60 * 1000

/** How many bundles one scan keeps, so a pathological folder cannot grow the answer forever. */
const MAX_APPS = 2000

/**
 * One installed application.
 *
 * `path` and the icon keys stay on the server: the route publishes only what the admin and the
 * widgets need to name an application and ask for its icon.
 */
export interface InstalledApp {
  name: string
  bundleId: string
  path: string
  /** The bundle's file name without `.app`, when it differs from `name` ("Visual Studio Code"). */
  file: string | null
  /** `CFBundleIconFile`, the classic `.icns` in `Contents/Resources`. */
  iconFile: string | null
  /** `CFBundleIconName`, an asset catalogue entry we cannot read. */
  iconName: string | null
}

/** What `GET /api/apps/installed` answers: enough to show and to match, no filesystem paths. */
export type InstalledAppSummary = Pick<InstalledApp, 'name' | 'bundleId'> & { file?: string }

export interface ScanRoot {
  path: string
  /** Also look one level down, for the folders vendors group their applications in. */
  deep?: boolean
}

/** Where macOS keeps applications, plus the one level down that Setapp and Utilities live in. */
export function defaultRoots(home = homedir()): ScanRoot[] {
  return [
    { path: '/Applications', deep: true },
    { path: join(home, 'Applications'), deep: true },
    { path: '/System/Applications', deep: false },
    { path: '/System/Applications/Utilities', deep: false },
  ]
}

type ReadDir = (path: string) => Promise<string[]>
type ReadPlist = (path: string) => Promise<Record<string, unknown> | null>

/**
 * Reads one `Info.plist`.
 *
 * `plutil` is asked for JSON rather than a plist parser being written here: plists are as often
 * binary as XML, and the converter ships with the system. `execFile` with an argument list, never
 * a shell — the path comes from a directory listing, not from a caller, but the rule holds.
 */
export async function readInfoPlist(path: string): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await run('plutil', ['-convert', 'json', '-o', '-', path], { maxBuffer: 4 * 1024 * 1024 })
    const parsed: unknown = JSON.parse(stdout)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    // Not a bundle, unreadable, or a plist `plutil` refuses: it is simply not an application.
    return null
  }
}

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

/** The record for one `.app` folder, or null when it carries no usable identifier. */
export function appFromPlist(path: string, info: Record<string, unknown> | null): InstalledApp | null {
  if (!info) return null
  const bundleId = str(info.CFBundleIdentifier)
  if (!bundleId || !APP_BUNDLE_ID_RE.test(bundleId)) return null
  const file = basename(path).replace(/\.app$/i, '')
  const name = str(info.CFBundleDisplayName) ?? str(info.CFBundleName) ?? file
  return {
    name,
    bundleId,
    path,
    file: file === name ? null : file,
    iconFile: str(info.CFBundleIconFile),
    iconName: str(info.CFBundleIconName),
  }
}

/** What the route publishes: the name, the identifier, and the file name when it differs. */
export function summarize(app: InstalledApp): InstalledAppSummary {
  return app.file ? { name: app.name, bundleId: app.bundleId, file: app.file } : { name: app.name, bundleId: app.bundleId }
}

/**
 * The applications installed on this machine, scanned once every ten minutes.
 *
 * The scan is shared: a row of widgets asking at the same moment waits on one walk rather than
 * spawning a `plutil` per button per caller.
 */
export class InstalledApps {
  private readonly roots: ScanRoot[]
  private readonly readDir: ReadDir
  private readonly readPlist: ReadPlist
  private readonly now: () => number
  private readonly ttlMs: number
  private cache: InstalledApp[] = []
  private scannedAt = 0
  private inFlight: Promise<InstalledApp[]> | null = null

  constructor(opts: { roots?: ScanRoot[]; readDir?: ReadDir; readPlist?: ReadPlist; now?: () => number; ttlMs?: number } = {}) {
    this.roots = opts.roots ?? defaultRoots()
    this.readDir = opts.readDir ?? ((path) => readdir(path))
    this.readPlist = opts.readPlist ?? readInfoPlist
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? INSTALLED_TTL_MS
  }

  /** The list, from the cache while it is fresh. Sorted by name, one entry per bundle id. */
  async list(): Promise<InstalledApp[]> {
    if (this.scannedAt > 0 && this.now() - this.scannedAt < this.ttlMs) return this.cache
    if (this.inFlight) return this.inFlight
    this.inFlight = this.scan()
      .then((apps) => {
        this.cache = apps
        this.scannedAt = this.now()
        return apps
      })
      .finally(() => { this.inFlight = null })
    return this.inFlight
  }

  /** One application by bundle id, or null. Used by the icon route, so it goes through the cache. */
  async find(bundleId: string): Promise<InstalledApp | null> {
    if (!APP_BUNDLE_ID_RE.test(bundleId)) return null
    return (await this.list()).find((a) => a.bundleId === bundleId) ?? null
  }

  private async bundlePaths(): Promise<string[]> {
    const paths: string[] = []
    const seen = new Set<string>()
    const push = (path: string): void => { if (!seen.has(path)) { seen.add(path); paths.push(path) } }
    for (const root of this.roots) {
      let entries: string[] = []
      try { entries = await this.readDir(root.path) } catch { continue }
      for (const entry of entries) {
        if (entry.startsWith('.')) continue
        if (entry.toLowerCase().endsWith('.app')) { push(join(root.path, entry)); continue }
        if (!root.deep) continue
        // Not an application: try it as a folder of applications (Setapp, Utilities, a vendor's).
        let nested: string[] = []
        try { nested = await this.readDir(join(root.path, entry)) } catch { continue }
        for (const inner of nested) {
          if (!inner.startsWith('.') && inner.toLowerCase().endsWith('.app')) push(join(root.path, entry, inner))
        }
      }
    }
    return paths.slice(0, MAX_APPS)
  }

  private async scan(): Promise<InstalledApp[]> {
    const byId = new Map<string, InstalledApp>()
    for (const path of await this.bundlePaths()) {
      const app = appFromPlist(path, await this.readPlist(join(path, 'Contents', 'Info.plist')))
      // First root wins: /Applications is the copy the user launches, not the one in a folder.
      if (app && !byId.has(app.bundleId)) byId.set(app.bundleId, app)
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
}
