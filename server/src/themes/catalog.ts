import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { BUILTIN_THEME, ThemeSchema, cssVariables, type Theme } from './theme.js'

export interface ThemeError { id: string; error: string }

/**
 * The themes found in `themes/`, one folder each, scanned like the widget catalog: a theme is
 * `theme.json` and nothing else, so dropping a folder in and pressing ⟳ in the admin is the
 * whole install. A folder that does not parse is reported rather than ignored, for the same
 * reason a broken manifest is.
 */
export class ThemeCatalog {
  themes = new Map<string, Theme>()
  errors: ThemeError[] = []

  constructor(readonly dir: string) {}

  get(id: string): Theme | undefined { return this.themes.get(id) }

  /** The variables for `id`, layered on the built-in theme; the built-in one alone if unknown. */
  variables(id: string): Record<string, string> {
    return cssVariables(this.get(id), this.get(BUILTIN_THEME))
  }

  async scan(): Promise<void> {
    const themes = new Map<string, Theme>()
    const errors: ThemeError[] = []
    let entries: string[] = []
    try { entries = await readdir(this.dir) } catch { entries = [] }
    for (const id of entries) {
      const folder = join(this.dir, id)
      try {
        if (!(await stat(folder)).isDirectory()) continue
        const raw = await readFile(join(folder, 'theme.json'), 'utf8').catch(() => { throw new Error('theme.json manquant') })
        let json: unknown
        try { json = JSON.parse(raw) } catch { throw new Error('theme.json invalide (JSON)') }
        const result = ThemeSchema.safeParse(json)
        if (!result.success) throw new Error('thème invalide: ' + result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
        if (result.data.id !== id) throw new Error(`id "${result.data.id}" différent du dossier "${id}"`)
        themes.set(id, result.data)
      } catch (err) {
        errors.push({ id, error: (err as Error).message })
      }
    }
    this.themes = themes
    this.errors = errors
  }
}
