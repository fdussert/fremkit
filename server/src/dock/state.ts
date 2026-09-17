import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface DockApp { bundleId: string; name: string; badge: string | null; running: boolean }
/**
 * What the `dock` channel publishes.
 *
 * `updatedAt` is deliberately absent: the helper sends a heartbeat every four seconds, and a
 * timestamp in the payload would make every one of them look like a change to the registry's
 * dedup, waking every subscriber for nothing. The staleness is computed from the timestamp
 * `DockState` keeps to itself and surfaces here as a single boolean.
 */
export interface DockSnapshot { apps: DockApp[]; available: boolean }

/** With no news from the helper for this long, the Dock is considered unreadable. */
export const DOCK_STALE_MS = 10_000
/** A bundle identifier becomes a file name, so it is held to a strict shape. */
export const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** More items than any real Dock holds; a malformed payload cannot grow past this. */
const MAX_APPS = 128
/** Largest icon accepted, decoded. A 128 px PNG is well under 100 kB. */
export const MAX_ICON_BYTES = 512_000
/** Largest number of icons kept, in memory and on disk: one per Dock slot, and no more. */
export const MAX_ICONS = 128
/** How long an unknown bundle id is remembered as unknown, to spare the disk a lookup per frame. */
export const ICON_MISS_TTL_MS = 30_000
/**
 * Largest number of misses remembered at once.
 *
 * A miss is keyed by a bundle id a client asked for, so without a cap a client asking for a new
 * id every second would grow the map forever. Expired entries are swept on insert and, if that
 * frees nothing, the oldest one makes room.
 */
export const MAX_ICON_MISSES = 256
/** PNG magic number, so only an actual image ever lands in the icons folder. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function isPng(buffer: Buffer): boolean {
  return buffer.length > PNG_MAGIC.length && buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)
}

export function assertBundleId(bundleId: string): void {
  if (!BUNDLE_ID_RE.test(bundleId)) throw new Error(`identifiant de bundle invalide : ${bundleId}`)
}

/** Keeps only the entries that have the shape the helper promises, in the order it sent them. */
export function normalizeDockApps(raw: unknown): DockApp[] {
  if (!Array.isArray(raw)) return []
  const apps: DockApp[] = []
  for (const item of raw.slice(0, MAX_APPS)) {
    if (!item || typeof item !== 'object') continue
    const { bundleId, name, badge, running } = item as Record<string, unknown>
    if (typeof bundleId !== 'string' || !BUNDLE_ID_RE.test(bundleId)) continue
    if (typeof name !== 'string' || !name) continue
    apps.push({ bundleId, name, badge: typeof badge === 'string' && badge ? badge : null, running: running === true })
  }
  return apps
}

/**
 * The Dock as the helper last described it, plus the icon cache.
 *
 * Icons live both in memory (served without touching the disk) and in `data/icons`, so a server
 * restart shows the row immediately instead of waiting for the helper to re-upload everything.
 */
export class DockState {
  private apps: DockApp[] = []
  private updatedAt = 0
  /** Least-recently-used first: a `Map` keeps insertion order, and a hit is re-inserted. */
  private icons = new Map<string, Buffer>()
  /** Bundle ids known to have no icon, with the time the miss expires. */
  private misses = new Map<string, number>()
  private readonly iconsDir: string
  private readonly now: () => number

  constructor(opts: { iconsDir: string; now?: () => number }) {
    this.iconsDir = opts.iconsDir
    this.now = opts.now ?? Date.now
  }

  /** Accepts a report; returns how many apps were kept. */
  update(raw: unknown): number {
    this.apps = normalizeDockApps(raw)
    this.updatedAt = this.now()
    return this.apps.length
  }

  snapshot(): DockSnapshot {
    // Strictly less: once a full `DOCK_STALE_MS` has gone by without news, the Dock is stale.
    return { apps: this.apps, available: this.updatedAt > 0 && this.now() - this.updatedAt < DOCK_STALE_MS }
  }

  /** When the last report landed. Internal to the staleness rule; never published. */
  lastUpdatedAt(): number { return this.updatedAt }

  knownIcons(): string[] { return [...this.icons.keys()] }

  /**
   * Stores one icon. Returns false when the cache is full and this bundle is new: the caller
   * answers politely rather than throwing away an icon the dashboard is currently drawing.
   */
  async setIcon(bundleId: string, png: Buffer): Promise<boolean> {
    assertBundleId(bundleId)
    if (!this.icons.has(bundleId) && this.icons.size >= MAX_ICONS) return false
    this.icons.delete(bundleId)
    this.icons.set(bundleId, png)
    this.misses.delete(bundleId)
    await mkdir(this.iconsDir, { recursive: true })
    const target = join(this.iconsDir, `${bundleId}.png`)
    const tmp = `${target}.tmp`
    await writeFile(tmp, png)
    await rename(tmp, target)
    return true
  }

  async getIcon(bundleId: string): Promise<Buffer | null> {
    assertBundleId(bundleId)
    const cached = this.icons.get(bundleId)
    if (cached) {
      // Touch it, so the least recently served icon is the one pruned at boot.
      this.icons.delete(bundleId)
      this.icons.set(bundleId, cached)
      return cached
    }
    const missUntil = this.misses.get(bundleId)
    if (missUntil !== undefined) {
      if (missUntil > this.now()) return null
      this.misses.delete(bundleId)
    }
    try {
      const png = await readFile(join(this.iconsDir, `${bundleId}.png`))
      if (this.icons.size < MAX_ICONS) this.icons.set(bundleId, png)
      return png
    } catch {
      // A widget asking for an app the helper never uploaded would otherwise hit the disk on
      // every render; remember the miss for a short while, and forget it when an icon lands.
      this.rememberMiss(bundleId)
      return null
    }
  }

  /** Records a miss, sweeping the expired ones first and never growing past the cap. */
  private rememberMiss(bundleId: string): void {
    const t = this.now()
    for (const [key, until] of this.misses) {
      if (until <= t) this.misses.delete(key)
    }
    // Insertion order, so the front of the map is the miss that has been there longest.
    while (this.misses.size >= MAX_ICON_MISSES) {
      const oldest = this.misses.keys().next()
      if (oldest.done) break
      this.misses.delete(oldest.value)
    }
    this.misses.set(bundleId, t + ICON_MISS_TTL_MS)
  }

  /** How many misses are remembered. Internal to the cap; exposed for its test. */
  missCount(): number { return this.misses.size }

  /**
   * Reads back whatever previous runs stored, ignoring anything that is not a plain icon and
   * keeping only the `MAX_ICONS` most recently written: a folder that grew past the cap under an
   * older build is trimmed here, on disk as well as in memory.
   */
  async loadIcons(): Promise<void> {
    let entries: string[] = []
    try { entries = await readdir(this.iconsDir) } catch { return }
    const found: Array<{ bundleId: string; file: string; mtimeMs: number }> = []
    for (const entry of entries) {
      if (!entry.endsWith('.png')) continue
      const bundleId = entry.slice(0, -4)
      if (!BUNDLE_ID_RE.test(bundleId)) continue
      try {
        found.push({ bundleId, file: entry, mtimeMs: (await stat(join(this.iconsDir, entry))).mtimeMs })
      } catch { /* vanished between readdir and stat: skip */ }
    }
    found.sort((a, b) => a.mtimeMs - b.mtimeMs)
    // Oldest first, so the survivors end up in the map with the least recent at the front.
    const doomed = found.slice(0, Math.max(0, found.length - MAX_ICONS))
    for (const { file } of doomed) {
      try { await unlink(join(this.iconsDir, file)) } catch { /* already gone: fine */ }
    }
    for (const { bundleId, file } of found.slice(doomed.length)) {
      try { this.icons.set(bundleId, await readFile(join(this.iconsDir, file))) } catch { /* unreadable: skip */ }
    }
  }
}
