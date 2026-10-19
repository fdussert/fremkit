import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { builtinOnlyChannels, ManifestSchema, type WidgetManifest } from './manifest.js'
import { WIDGET_ID_RE } from '../config/schema.js'
import { tr } from '../i18n.js'

export interface CatalogError { id: string; error: string }

/**
 * Where a widget came from, which is the whole of what the host trusts it on.
 *
 * `builtin` is the `widgets/` folder of the checkout: it ships with the server, it is reviewed
 * with it, and it is what makes a fresh install work with no network at all. `installed` is
 * `<dataDir>/widgets`, written by the marketplace installer and by nothing else — third-party
 * code the user chose, granted exactly the permissions they were shown. `dev` is the folder a
 * widget author works in (`FREMKIT_WIDGET_DEV_DIR`, by default `<dataDir>/widgets-dev`), read
 * only when the server was started with `FREMKIT_WIDGET_DEV=1`: code the person running the
 * server is writing, granted what its manifest asks for — see `effectiveManifest`.
 */
export type WidgetSource = 'builtin' | 'installed' | 'dev'

/** One widget the server can serve: its manifest, where it came from, and the folder it lives in. */
export interface CatalogEntry {
  manifest: WidgetManifest
  source: WidgetSource
  /** The folder holding `manifest.json` and `index.html`; `<root>/<id>`. */
  folder: string
}

/** One place widgets are read from. Order matters: the first root to claim an id keeps it. */
interface Root { dir: string; source: WidgetSource }

export class WidgetCatalog {
  entries = new Map<string, CatalogEntry>()
  errors: CatalogError[] = []
  /**
   * Every id the built-in folder holds, whether or not its manifest could be read.
   *
   * The entries are not enough for "a built-in owns this id": a built-in whose manifest fails to
   * parse lands in `errors`, has no entry, and would have let an installed widget take its name
   * — so the next time the built-in was fixed, two folders would claim it. This is the set the
   * installer refuses against.
   */
  builtinIds = new Set<string>()

  /**
   * The manifests alone, derived rather than stored: two maps to keep in step is one map too
   * many, and the one that would go stale is the one everything reads.
   */
  get manifests(): Map<string, WidgetManifest> {
    return new Map([...this.entries].map(([id, e]) => [id, e.manifest]))
  }

  private readonly roots: Root[]

  /**
   * `dir` is the built-in folder, `installedDir` the marketplace one, `devDir` the widget
   * author's. The last two are optional so every existing caller — the tests, a bench server —
   * keeps working with one folder. The author's folder comes last: a widget being written never
   * stands in for one the user installed, any more than an installed one does for a built-in.
   */
  constructor(readonly dir: string, readonly installedDir?: string, readonly devDir?: string) {
    this.roots = [{ dir, source: 'builtin' }]
    if (installedDir) this.roots.push({ dir: installedDir, source: 'installed' })
    if (devDir) this.roots.push({ dir: devDir, source: 'dev' })
  }

  get(id: string): WidgetManifest | undefined { return this.manifests.get(id) }
  entry(id: string): CatalogEntry | undefined { return this.entries.get(id) }
  /** The folder that owns an id, for the routes that serve its bytes. */
  folderOf(id: string): string | undefined { return this.entries.get(id)?.folder }

  /**
   * Called after every scan, by whatever needs to follow the catalogue.
   *
   * One hook rather than a call beside each of the five `scan()` sites: the marketplace, the
   * rescan route and the boot all mean the same thing by it — "what is installed has changed" —
   * and a sixth site added later would otherwise silently update nothing.
   */
  private readonly watchers: (() => void)[] = []
  onScan(cb: () => void): void { this.watchers.push(cb) }

  async scan(): Promise<void> {
    const entries = new Map<string, CatalogEntry>()
    const errors: CatalogError[] = []
    const builtinIds = new Set<string>()
    for (const root of this.roots) {
      let ids: string[] = []
      try { ids = await readdir(root.dir) } catch { ids = [] }
      for (const id of ids) {
        const folder = join(root.dir, id)
        // A name that could never be a widget id is not a widget: `.DS_Store`, the installer's
        // `.tmp-…` staging folder and the `<id>.bak` it keeps while a version is replaced. None
        // of them is an error to report — they are simply not part of the catalogue.
        if (!WIDGET_ID_RE.test(id)) continue
        try {
          if (!(await stat(folder)).isDirectory()) continue
          // Recorded before anything is parsed: the id is taken by the folder existing, not by
          // its manifest being readable.
          if (root.source === 'builtin') builtinIds.add(id)
          // Built-ins are read first and keep their id: a folder dropped into `data/widgets`
          // must never be able to stand in for the widget the user thinks they are running.
          // The installer refuses the same collision up front (409), so this is the second line.
          const owner = entries.get(id)
          if (owner) throw new Error(tr(undefined, owner.source === 'builtin' ? 'catalog.builtinId' : 'catalog.idTaken', { id }))
          // A widget being written is held to the installer's rule rather than the catalogue's:
          // a built-in's id is taken even while its manifest does not parse, so the author hears
          // about the collision now rather than when the registry refuses it.
          if (root.source === 'dev' && builtinIds.has(id)) throw new Error(tr(undefined, 'catalog.builtinId', { id }))
          await stat(join(folder, 'index.html')).catch(() => { throw new Error(tr(undefined, 'catalog.indexMissing')) })
          const raw = await readFile(join(folder, 'manifest.json'), 'utf8').catch(() => { throw new Error(tr(undefined, 'catalog.manifestMissing')) })
          let json: unknown
          try { json = JSON.parse(raw) } catch { throw new Error(tr(undefined, 'catalog.manifestNotJson')) }
          const result = ManifestSchema.safeParse(json)
          if (!result.success) throw new Error(tr(undefined, 'catalog.invalidManifest', { issues: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }))
          if (result.data.id !== id) throw new Error(tr(undefined, 'catalog.folderMismatch', { id: result.data.id, folder: id }))
          // The installer refuses these already; a folder copied into `data/widgets` by hand
          // never went through it, and a widget being written is told now rather than by the
          // registry.
          const builtinOnly = root.source !== 'builtin' ? builtinOnlyChannels(result.data) : []
          if (builtinOnly.length > 0) throw new Error(tr(undefined, 'catalog.builtinOnlyChannel', { channels: builtinOnly.join(', ') }))
          entries.set(id, { manifest: result.data, source: root.source, folder })
        } catch (err) {
          errors.push({ id, error: (err as Error).message })
        }
      }
    }
    this.entries = entries
    this.builtinIds = builtinIds
    this.errors = errors
    for (const watch of this.watchers) watch()
  }
}
