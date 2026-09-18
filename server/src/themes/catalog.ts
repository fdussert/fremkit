import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { BUILTIN_THEME, ThemeSchema, cssVariables, type Theme } from './theme.js'
import { WIDGET_ID_RE } from '../config/schema.js'
import { tr } from '../i18n.js'

export interface ThemeError { id: string; error: string }

/**
 * Where a theme came from. `builtin` is the checkout's `themes/` folder, which ships with the
 * server; `installed` is `<dataDir>/themes`, written by the marketplace installer and by nothing
 * else. Unlike a widget there is nothing to consent to — a theme is validated JSON that runs
 * nothing — but the distinction still decides which folder may be removed and which may not.
 */
export type ThemeSource = 'builtin' | 'installed'

export interface ThemeEntry { theme: Theme; source: ThemeSource }

/** One place themes are read from. Order matters: the first root to claim an id keeps it. */
interface Root { dir: string; source: ThemeSource }

/**
 * The themes on disk, one folder each, scanned like the widget catalogue: a theme is
 * `theme.json` and nothing else, so dropping a folder in and pressing ⟳ in the admin is the
 * whole install. A folder that does not parse is reported rather than ignored, for the same
 * reason a broken manifest is.
 */
export class ThemeCatalog {
  entries = new Map<string, ThemeEntry>()
  errors: ThemeError[] = []
  /**
   * Every id the built-in folder holds, whether or not its `theme.json` could be read.
   *
   * Same reason as the widget catalogue's: a built-in that fails to parse has no entry, and
   * without this an installed folder could take its name — so the day the built-in was fixed,
   * two folders would claim it. This is the set the installer refuses against.
   */
  builtinIds = new Set<string>()

  private readonly roots: Root[]

  /**
   * `dir` is the built-in folder, `installedDir` the marketplace one. The second is optional so
   * every existing caller — the tests, a bench server — keeps working with one folder.
   */
  constructor(readonly dir: string, readonly installedDir?: string) {
    this.roots = [{ dir, source: 'builtin' }]
    if (installedDir) this.roots.push({ dir: installedDir, source: 'installed' })
  }

  /** The themes alone, derived rather than stored: a second map is the one that goes stale. */
  get themes(): Map<string, Theme> {
    return new Map([...this.entries].map(([id, e]) => [id, e.theme]))
  }

  get(id: string): Theme | undefined { return this.entries.get(id)?.theme }
  entry(id: string): ThemeEntry | undefined { return this.entries.get(id) }

  /** The variables for `id`, layered on the built-in theme; the built-in one alone if unknown. */
  variables(id: string): Record<string, string> {
    return cssVariables(this.get(id), this.get(BUILTIN_THEME))
  }

  async scan(): Promise<void> {
    const entries = new Map<string, ThemeEntry>()
    const errors: ThemeError[] = []
    const builtinIds = new Set<string>()
    for (const root of this.roots) {
      let ids: string[] = []
      try { ids = await readdir(root.dir) } catch { ids = [] }
      for (const id of ids) {
        const folder = join(root.dir, id)
        // A name that could never be a theme id is not a theme: `.DS_Store`, the installer's
        // `.tmp-…` staging folder and the `<id>.bak` it keeps while a version is replaced.
        if (!WIDGET_ID_RE.test(id)) continue
        try {
          if (!(await stat(folder)).isDirectory()) continue
          // Recorded before anything is parsed: the id is taken by the folder existing, not by
          // its `theme.json` being readable.
          if (root.source === 'builtin') builtinIds.add(id)
          // Built-ins are read first and keep their id: an installed folder must never stand in
          // for the theme the user thinks they are painting with. The installer refuses the same
          // collision up front (409), so this is the second line.
          if (entries.has(id)) throw new Error(tr(undefined, 'catalog.builtinThemeId', { id }))
          const raw = await readFile(join(folder, 'theme.json'), 'utf8').catch(() => { throw new Error(tr(undefined, 'catalog.themeMissing')) })
          let json: unknown
          try { json = JSON.parse(raw) } catch { throw new Error(tr(undefined, 'catalog.themeNotJson')) }
          const result = ThemeSchema.safeParse(json)
          if (!result.success) throw new Error(tr(undefined, 'catalog.invalidTheme', { issues: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }))
          if (result.data.id !== id) throw new Error(tr(undefined, 'catalog.folderMismatch', { id: result.data.id, folder: id }))
          entries.set(id, { theme: result.data, source: root.source })
        } catch (err) {
          errors.push({ id, error: (err as Error).message })
        }
      }
    }
    this.entries = entries
    this.errors = errors
    this.builtinIds = builtinIds
  }
}
