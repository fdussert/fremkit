import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { APP_BUNDLE_ID_RE, type InstalledApp, type InstalledApps } from './installed.js'

const run = promisify(execFile)

/** The size `sips` renders into. Matches what the helper uploads for the Dock. */
export const ICON_SIZE = 256
/** How long a bundle with no extractable icon is remembered as such, to spare `sips` a retry. */
export const ICON_MISS_TTL_MS = 5 * 60 * 1000

type Convert = (icns: string, out: string) => Promise<void>

/**
 * Renders one `.icns` to PNG.
 *
 * `execFile` with an argument list, never a shell: both paths are built here, but a file name
 * inside `/Applications` is still someone else's string.
 */
const sipsConvert: Convert = async (icns, out) => {
  await run('sips', ['-s', 'format', 'png', '-Z', String(ICON_SIZE), icns, '--out', out], { maxBuffer: 1024 * 1024 })
}

/**
 * Icons for applications the Dock never reported.
 *
 * The helper uploads an icon per Dock slot; everything else — an application a shortcut button
 * points at but that is not in the Dock — is extracted here from the bundle itself and cached in
 * `data/icons/apps`, so the conversion happens once per application and never per render.
 */
export class AppIcons {
  private readonly dir: string
  private readonly apps: Pick<InstalledApps, 'find'>
  private readonly convert: Convert
  private readonly now: () => number
  private readonly misses = new Map<string, number>()
  private readonly inFlight = new Map<string, Promise<Buffer | null>>()

  constructor(opts: { dir: string; apps: Pick<InstalledApps, 'find'>; convert?: Convert; now?: () => number }) {
    this.dir = opts.dir
    this.apps = opts.apps
    this.convert = opts.convert ?? sipsConvert
    this.now = opts.now ?? Date.now
  }

  /** The cached PNG for a bundle id, extracting it from the installed bundle the first time. */
  async get(bundleId: string): Promise<Buffer | null> {
    if (!APP_BUNDLE_ID_RE.test(bundleId)) return null
    const cached = await readFile(join(this.dir, `${bundleId}.png`)).catch(() => null)
    if (cached) return cached
    const missUntil = this.misses.get(bundleId)
    if (missUntil !== undefined) {
      if (missUntil > this.now()) return null
      this.misses.delete(bundleId)
    }
    const running = this.inFlight.get(bundleId)
    if (running) return running
    const task = this.extract(bundleId).finally(() => { this.inFlight.delete(bundleId) })
    this.inFlight.set(bundleId, task)
    return task
  }

  private async extract(bundleId: string): Promise<Buffer | null> {
    const app = await this.apps.find(bundleId)
    const icns = app && icnsPath(app)
    if (!icns) return this.miss(bundleId)
    const target = join(this.dir, `${bundleId}.png`)
    const tmp = `${target}.tmp`
    try {
      await mkdir(this.dir, { recursive: true })
      await this.convert(icns, tmp)
      const png = await readFile(tmp)
      await rename(tmp, target)
      return png
    } catch {
      // No `.icns` on disk (the icon lives in an `Assets.car`), or `sips` refused it.
      await unlink(tmp).catch(() => { /* never written: fine */ })
      return this.miss(bundleId)
    }
  }

  private miss(bundleId: string): null {
    const t = this.now()
    for (const [key, until] of this.misses) if (until <= t) this.misses.delete(key)
    this.misses.set(bundleId, t + ICON_MISS_TTL_MS)
    return null
  }
}

/**
 * The `.icns` an application declares, or null when it has none we can read.
 *
 * `CFBundleIconFile` is the classic resource, with or without its extension. When only
 * `CFBundleIconName` is set the icon lives in an asset catalogue, which nothing on the system
 * unpacks for us — the caller answers 404 rather than guessing.
 */
export function icnsPath(app: InstalledApp): string | null {
  const file = app.iconFile
  if (!file) return null
  // A file name from a plist: keep it to one path component, so nothing can climb out of Resources.
  if (file.includes('/') || file.includes('\\') || file === '.' || file === '..') return null
  const name = /\.icns$/i.test(file) ? file : `${file}.icns`
  return join(app.path, 'Contents', 'Resources', name)
}
