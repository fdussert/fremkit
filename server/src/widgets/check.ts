/**
 * `pnpm widget:check`: what the registry and the installer will say about a widget folder, said
 * before the pull request rather than after it.
 *
 * Two sets of rules, both applied. The **installer's**, from `marketplace/install.ts` — the
 * entry names, the ceilings, the manifest schema, the SDK generation, the built-in-only channels —
 * because a package that breaks one of them installs nowhere, whatever the registry published.
 * And the **registry's** own, the ones `fremkit-sietch/tools/validate.ts` adds on top: an author,
 * every text a `{ fr, en }` pair, no script loaded from outside the package, no local host name,
 * the compressed size, a changelog entry for the version. Those live in the other repository, so
 * they are restated here in a few lines each; the schema, the address rules and the zip writer
 * they run on are the very files the registry vendors (`tools/vendor/`), imported, not copied.
 */

import { lstat, readdir, readFile } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { builtinOnlyChannels, ManifestSchema, previewProblems, type WidgetManifest } from './manifest.js'
import { isPrivateLiteral } from '../net/private.js'
import { writeZip } from '../backup/zip.js'
import { LIMITS, safeEntryName } from '../marketplace/install.js'
import { SDK_VERSION } from '../bridge/sdk.js'
import { PLACEHOLDER_DESCRIPTION } from './scaffold.js'

/** The registry's ceiling on the zip as downloaded (`LIMITS.maxCompressedBytes` there). */
export const MAX_COMPRESSED_BYTES = 5 * 1024 * 1024

/** Beside the manifest, never packed: what the admin shows before an update. */
export const CHANGELOG_ENTRY = 'CHANGELOG.md'

export interface CheckResult {
  id: string
  /** Refusals: the registry's CI or the installer would turn the widget away. */
  errors: string[]
  /** Not refused, but almost certainly not what the author meant. */
  warnings: string[]
  manifest?: WidgetManifest
  /** Files that would be packed, and the size of the zip they make. */
  files: number
  zipBytes: number
}

export interface CheckOptions {
  /** Ids the built-in folder holds: the installer refuses them. */
  builtinIds?: ReadonlySet<string>
}

/** Names that only ever mean "this machine or this LAN" — the registry's `isLocalName`. */
const LOCAL_SUFFIX = ['.localhost', '.local', '.internal', '.home.arpa', '.lan']
function isLocalName(host: string): boolean {
  const lower = host.toLowerCase().replace(/\.$/, '')
  return lower === 'localhost' || LOCAL_SUFFIX.some((s) => lower.endsWith(s))
}

/** Every text a manifest shows a user, with where it was found — the registry's `localizedTexts`. */
function localizedTexts(manifest: WidgetManifest): { path: string; value: unknown }[] {
  const texts: { path: string; value: unknown }[] = [
    { path: 'name', value: manifest.name },
    { path: 'description', value: manifest.description },
  ]
  for (const [key, field] of Object.entries(manifest.settingsSchema)) {
    texts.push({ path: `settingsSchema.${key}.label`, value: field.label })
    for (const [itemKey, item] of Object.entries(field.itemSchema ?? {})) {
      texts.push({ path: `settingsSchema.${key}.itemSchema.${itemKey}.label`, value: item.label })
      for (const [i, option] of (item.options ?? []).entries()) {
        if (typeof option === 'object') texts.push({ path: `settingsSchema.${key}.itemSchema.${itemKey}.options[${i}].label`, value: option.label })
      }
    }
    for (const [i, option] of (field.options ?? []).entries()) {
      if (typeof option === 'object') texts.push({ path: `settingsSchema.${key}.options[${i}].label`, value: option.label })
    }
  }
  return texts
}

function isBilingual(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const pair = value as Record<string, unknown>
  return typeof pair.fr === 'string' && pair.fr.trim() !== '' && typeof pair.en === 'string' && pair.en.trim() !== ''
}

const SCRIPT_SRC_RE = /<script\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi

/** `<script src=` pointing anywhere but into the package — the registry's `offPackageScripts`. */
function offPackageScripts(html: string): string[] {
  const found: string[] = []
  for (const m of html.matchAll(SCRIPT_SRC_RE)) {
    const src = (m[2] ?? m[3] ?? m[4] ?? '').trim()
    if (src === '' || src === '/fremkit.js') continue
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//') || src.startsWith('/')) found.push(src)
  }
  return found
}

/** The versions a changelog documents: its `## <version>` headings. */
function changelogVersions(text: string): string[] {
  return [...text.matchAll(/^##\s+\[?v?([0-9][^\s\]]*)\]?/gm)].map((m) => m[1])
}

/** Checks one widget folder. Never throws for a problem with the widget; it reports it. */
export async function checkWidgetFolder(folder: string, opts: CheckOptions = {}): Promise<CheckResult> {
  const id = basename(folder)
  const errors: string[] = []
  const warnings: string[] = []
  const packed: { name: string; data: Buffer }[] = []
  let changelog: string | undefined
  let total = 0

  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const name = relative(folder, full).split(sep).join('/')
      // Finder's, on every Mac, and kept out of a pull request by any sensible .gitignore.
      if (entry.name === '.DS_Store') { warnings.push(`${name} is ignored here; keep it out of the pull request`); continue }
      // A symlink would be read through by a packer and publish whatever it points at.
      if ((await lstat(full)).isSymbolicLink()) { errors.push(`symlink: ${name}`); continue }
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) { errors.push(`dotfile: ${name}/`); continue }
        await walk(full)
        continue
      }
      if (!entry.isFile()) { errors.push(`not a regular file: ${name}`); continue }
      if (!safeEntryName(name)) {
        errors.push(name.split('/').some((p) => p.startsWith('.'))
          ? `dotfile: ${name}`
          : `a package may not carry ${name} (nested archive, odd character, or deeper than ${LIMITS.maxPathDepth} levels)`)
        continue
      }
      const data = await readFile(full)
      if (name === CHANGELOG_ENTRY) { changelog = data.toString('utf8'); continue }
      if (data.byteLength > LIMITS.maxFileBytes) errors.push(`${name} is over ${LIMITS.maxFileBytes} bytes`)
      total += data.byteLength
      packed.push({ name, data })
    }
  }
  try {
    if (!(await lstat(folder)).isDirectory()) return { id, errors: [`${folder} is not a folder`], warnings, files: 0, zipBytes: 0 }
    await walk(folder)
  } catch (error) {
    return { id, errors: [`cannot read ${folder}: ${(error as Error).message}`], warnings, files: 0, zipBytes: 0 }
  }

  if (packed.length > LIMITS.maxFiles) errors.push(`over ${LIMITS.maxFiles} files`)
  if (total > LIMITS.maxUncompressedBytes) errors.push(`over ${LIMITS.maxUncompressedBytes} bytes unpacked`)
  packed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const zipBytes = writeZip(packed, new Date(0)).byteLength
  if (zipBytes > MAX_COMPRESSED_BYTES) errors.push(`the package is over ${MAX_COMPRESSED_BYTES} bytes compressed`)

  if (!packed.some((f) => f.name === 'index.html')) errors.push('index.html is missing')
  for (const file of packed) {
    if (!file.name.toLowerCase().endsWith('.html')) continue
    const off = offPackageScripts(file.data.toString('utf8'))
    if (off.length) errors.push(`${file.name} loads a script from outside the package: ${off.join(', ')}`)
  }

  const manifestFile = packed.find((f) => f.name === 'manifest.json')
  if (!manifestFile) {
    errors.push('manifest.json is missing')
    return { id, errors, warnings, files: packed.length, zipBytes }
  }
  let json: unknown
  try { json = JSON.parse(manifestFile.data.toString('utf8')) } catch (error) {
    errors.push(`manifest.json is not valid JSON: ${(error as Error).message}`)
    return { id, errors, warnings, files: packed.length, zipBytes }
  }
  const parsed = ManifestSchema.safeParse(json)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors.push(`manifest.json ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    return { id, errors, warnings, files: packed.length, zipBytes }
  }
  const manifest = parsed.data

  if (manifest.id !== id) errors.push(`the manifest's id "${manifest.id}" does not match the folder "${id}"`)
  if (opts.builtinIds?.has(manifest.id)) errors.push(`"${manifest.id}" is the id of a widget Fremkit ships; the installer refuses it`)
  if (manifest.sdk > SDK_VERSION) errors.push(`sdk ${manifest.sdk} is newer than this Fremkit's (${SDK_VERSION})`)
  const builtinOnly = builtinOnlyChannels(manifest)
  if (builtinOnly.length) errors.push(`channels reserved to built-in widgets: ${builtinOnly.join(', ')}`)
  if (!manifest.author?.trim()) errors.push('author is required: your handle, shown on the widget\'s card')
  for (const host of manifest.permissions.network) {
    if (isPrivateLiteral(host) || isLocalName(host)) errors.push(`permissions.network: private or local host ${host}`)
  }
  for (const { path, value } of localizedTexts(manifest)) {
    if (isBilingual(value)) continue
    errors.push(value === '' || value === undefined ? `${path} is required` : `${path} must be a { "fr": …, "en": … } pair`)
  }
  if (changelog === undefined) errors.push(`${CHANGELOG_ENTRY} is missing: the registry needs an entry for every version`)
  else if (!changelogVersions(changelog).includes(manifest.version)) errors.push(`${CHANGELOG_ENTRY} has no "## ${manifest.version}" entry`)

  const description = manifest.description as unknown
  if (typeof description === 'object' && description !== null
    && ((description as Record<string, unknown>).en === PLACEHOLDER_DESCRIPTION.en || (description as Record<string, unknown>).fr === PLACEHOLDER_DESCRIPTION.fr)) {
    warnings.push('description is still the placeholder pnpm widget:new wrote')
  }
  if (!manifest.license) warnings.push('no license: the card shows none (MIT, Apache-2.0, …)')
  // The size and the format refuse a package everywhere; the dimensions are the registry's rule.
  if (manifest.preview === undefined) {
    warnings.push('no preview: the library and the Sietch show no picture of the widget (pnpm widget:preview makes one)')
  } else {
    const file = packed.find((f) => f.name === manifest.preview)
    errors.push(...previewProblems(manifest, file?.data ?? null, { checkSize: true }))
  }

  return { id, errors, warnings, manifest, files: packed.length, zipBytes }
}
