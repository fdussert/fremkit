/**
 * Turning a downloaded package into a folder under `data/widgets`.
 *
 * The registry applies these rules too, at pull-request time, so an author hears about a mistake
 * early. That is the kind version. This is the one that counts: the bytes arriving here came
 * over the network, from a site this server does not control, and a registry can be wrong, be
 * forked, or be replaced by whoever owns a DNS record one day. Nothing here trusts anything the
 * archive says about itself beyond the hash, which was checked before it was opened.
 *
 * Nothing in this file runs widget code, and nothing in it writes outside `data/widgets`.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readZip, ZipError } from '../backup/zip.js'
import { ManifestSchema, type WidgetManifest } from '../widgets/manifest.js'
import { SDK_VERSION } from '../bridge/sdk.js'
import { isPrivateLiteral } from '../net/private.js'
import { tr } from '../i18n.js'
import type { Locale } from '../config/schema.js'

export const LIMITS = {
  maxFiles: 200,
  maxUncompressedBytes: 20 * 1024 * 1024,
  maxFileBytes: 5 * 1024 * 1024,
  /**
   * How deep a path inside a package may go. A widget is a page and its assets; eight levels is
   * already more than any of the built-ins use, and an unbounded depth is a cheap way to make a
   * filesystem — or a backup reading it back — unhappy.
   */
  maxPathDepth: 8,
} as const

/**
 * A staging folder this old is not an install in progress; it is one that died.
 *
 * Ten minutes is far longer than writing two hundred small files takes, and short enough that
 * the sweep happens on the next install rather than never.
 */
export const STALE_STAGING_MS = 10 * 60 * 1000

/**
 * Suffixes an entry may not carry.
 *
 * An archive inside a package is a payload nothing in the chain looks inside: not the registry's
 * validator, not `readZip`, not the catalogue. The registry refuses these too; this is the copy
 * that protects a user from a registry rather than an author from a mistake.
 */
const FORBIDDEN_SUFFIX = ['.zip', '.tar', '.tgz', '.gz', '.7z', '.rar', '.xz', '.bz2']

export type InstallErrorKey =
  | 'marketplace.badPackage'
  | 'marketplace.badManifest'
  | 'marketplace.idMismatch'
  | 'marketplace.sdkTooNew'
  | 'marketplace.hashMismatch'

export class InstallError extends Error {
  constructor(readonly key: InstallErrorKey, locale?: Locale) {
    super(tr(locale, key))
    this.name = 'InstallError'
  }
}

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * The names an entry may carry once unpacked.
 *
 * `readZip` gives back whatever the archive stored. An entry called `../../fremkit.json` would be
 * written outside the widget's folder, one called `.env` would be served to nothing but would
 * sit on the disk, and a backslash is the same escape spelled for a filesystem this is not on.
 * Everything is judged before a single byte is written.
 */
export function safeEntryName(name: string): boolean {
  if (name === '' || name.length > 255 * 4) return false
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false
  if (name.includes('\\') || name.includes('\0')) return false
  // A trailing slash is a directory record; the folders are created from the file paths instead.
  if (name.endsWith('/')) return false
  const parts = name.split('/')
  if (parts.length > LIMITS.maxPathDepth) return false
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.startsWith('.'))) return false
  const lower = name.toLowerCase()
  if (FORBIDDEN_SUFFIX.some((suffix) => lower.endsWith(suffix))) return false
  return true
}

export interface ReadPackageResult {
  manifest: WidgetManifest
  files: { name: string; data: Buffer }[]
}

/**
 * Opens a package and holds it to every rule, without writing anything.
 *
 * `expected` is what the index promised. The hash is checked first, because everything after it
 * is parsing attacker-chosen bytes and there is no reason to do any of it for an archive that is
 * already not the one that was advertised.
 */
export function readPackage(
  zip: Buffer,
  expected: { id: string; sha256: string; size: number },
  locale?: Locale,
): ReadPackageResult {
  if (zip.byteLength !== expected.size || sha256(zip) !== expected.sha256) {
    throw new InstallError('marketplace.hashMismatch', locale)
  }

  let entries: { name: string; data: Buffer }[]
  try {
    entries = readZip(zip, { maxEntries: LIMITS.maxFiles, maxTotalBytes: LIMITS.maxUncompressedBytes })
  } catch (err) {
    if (err instanceof ZipError) throw new InstallError('marketplace.badPackage', locale)
    throw err
  }

  const seen = new Set<string>()
  for (const entry of entries) {
    if (!safeEntryName(entry.name)) throw new InstallError('marketplace.badPackage', locale)
    if (entry.data.byteLength > LIMITS.maxFileBytes) throw new InstallError('marketplace.badPackage', locale)
    // Two entries of the same name: which one ends up on disk would depend on the write order,
    // which is exactly the kind of question an archive should not get to ask.
    const key = entry.name.toLowerCase()
    if (seen.has(key)) throw new InstallError('marketplace.badPackage', locale)
    seen.add(key)
  }

  const manifestEntry = entries.find((e) => e.name === 'manifest.json')
  if (!manifestEntry) throw new InstallError('marketplace.badPackage', locale)
  if (!entries.some((e) => e.name === 'index.html')) throw new InstallError('marketplace.badPackage', locale)

  let json: unknown
  try { json = JSON.parse(manifestEntry.data.toString('utf8')) } catch { throw new InstallError('marketplace.badManifest', locale) }
  const parsed = ManifestSchema.safeParse(json)
  if (!parsed.success) throw new InstallError('marketplace.badManifest', locale)
  const manifest = parsed.data

  // The id decides the folder. It has to be the one the user asked to install, or a package
  // could land under a name they never saw — including one they already trust.
  if (manifest.id !== expected.id) throw new InstallError('marketplace.idMismatch', locale)
  if (manifest.sdk > SDK_VERSION) throw new InstallError('marketplace.sdkTooNew', locale)
  // The schema refuses these already. Said twice because it is the rule that turns the proxy
  // into a way to read this machine's own services, and one check is never enough for that one.
  if (manifest.permissions.network.some((host) => isPrivateLiteral(host))) {
    throw new InstallError('marketplace.badManifest', locale)
  }

  return { manifest, files: entries }
}

/**
 * Writes a validated package over `<installedDir>/<id>`, replacing whatever was there.
 *
 * Built somewhere else first and moved into place, so a failure halfway through leaves the
 * widget that was working exactly as it was rather than a folder that is half of two versions.
 * The previous folder is kept as `<id>.bak` until the move succeeds, and removed after — if the
 * removal itself fails the install is still done, and a stale `.bak` is inert: the catalogue
 * scans `<dataDir>/widgets` and a name with a dot in it is not a widget id.
 */
export interface RecoverOptions {
  /**
   * Restore only this widget's backup.
   *
   * Passed by `writePackage`, and the reason it has to be: the route's lock serialises installs
   * *per id*, so installing B while A is between its two renames is allowed and normal. A
   * recovery that restored every backup would then put `A.bak` back over the hole A is about to
   * fill, and A's own rename would fail on a directory that is suddenly not empty. Left out —
   * at boot, when nothing can be in flight — every backup is considered.
   */
  id?: string
  now?: number
}

/**
 * Undoes whatever a crash in the middle of a swap left behind.
 *
 * Two shapes are possible, because the swap is `target → .bak`, then `staging → target`. If the
 * process died between the two, the widget's folder is *gone* and its previous version is
 * sitting in `<id>.bak` — so it goes back. And a staging folder nobody renamed is dead weight
 * that the catalogue ignores but the disk does not.
 *
 * The staging sweep stays whole-directory, because it is guarded by age instead: a `.tmp-…` that
 * belongs to an install happening right now is minutes newer than the threshold, and one left by
 * a process that died would otherwise never be swept at all — its widget may never be installed
 * again.
 *
 * Everything here is best-effort: an install that cannot tidy up is still an install, and the
 * mess is inert — neither `<id>.bak` nor `.tmp-…` is a widget id, so the catalogue never reads
 * them.
 */
export async function recoverStaging(installedDir: string, opts: RecoverOptions = {}): Promise<void> {
  const now = opts.now ?? Date.now()
  let entries: string[]
  try { entries = await readdir(installedDir) } catch { return }
  for (const entry of entries) {
    const full = join(installedDir, entry)
    const backup = /^(.+)\.bak$/.exec(entry)
    if (backup) {
      if (opts.id !== undefined && backup[1] !== opts.id) continue
      const target = join(installedDir, backup[1])
      // Only when the widget itself is missing: a `.bak` beside a working folder is the leftover
      // of a *successful* swap whose cleanup failed, and restoring it would undo the install.
      const present = await stat(target).then(() => true, () => false)
      if (!present) await rename(full, target).catch(() => {})
      else await rm(full, { recursive: true, force: true }).catch(() => {})
      continue
    }
    if (!entry.startsWith('.tmp-')) continue
    const age = await stat(full).then((s) => now - s.mtimeMs, () => 0)
    if (age > STALE_STAGING_MS) await rm(full, { recursive: true, force: true }).catch(() => {})
  }
}

export async function writePackage(installedDir: string, id: string, files: { name: string; data: Buffer }[]): Promise<void> {
  await mkdir(installedDir, { recursive: true })
  await recoverStaging(installedDir, { id })
  const target = join(installedDir, id)
  const backup = join(installedDir, `${id}.bak`)
  const staging = await mkdtemp(join(installedDir, `.tmp-${id}-`))

  try {
    for (const file of files) {
      const full = join(staging, file.name)
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, file.data)
    }
    await rm(backup, { recursive: true, force: true })
    // ENOENT is the first install of this widget; anything else is a real failure.
    await rename(target, backup).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err
    })
    try {
      await rename(staging, target)
    } catch (err) {
      // Put back what was working before giving up.
      await rename(backup, target).catch(() => {})
      throw err
    }
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw err
  }
  await rm(backup, { recursive: true, force: true }).catch(() => {})
}

/** Removes an installed widget's folder. A folder that is not there is not an error. */
export async function removePackage(installedDir: string, id: string): Promise<void> {
  await rm(join(installedDir, id), { recursive: true, force: true })
}
