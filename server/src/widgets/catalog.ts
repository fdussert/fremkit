import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ManifestSchema, type WidgetManifest } from './manifest.js'

export interface CatalogError { id: string; error: string }

export class WidgetCatalog {
  manifests = new Map<string, WidgetManifest>()
  errors: CatalogError[] = []

  constructor(readonly dir: string) {}

  get(id: string): WidgetManifest | undefined { return this.manifests.get(id) }

  async scan(): Promise<void> {
    const manifests = new Map<string, WidgetManifest>()
    const errors: CatalogError[] = []
    let entries: string[] = []
    try { entries = await readdir(this.dir) } catch { entries = [] }
    for (const id of entries) {
      const folder = join(this.dir, id)
      try {
        if (!(await stat(folder)).isDirectory()) continue
        await stat(join(folder, 'index.html')).catch(() => { throw new Error('index.html manquant') })
        const raw = await readFile(join(folder, 'manifest.json'), 'utf8').catch(() => { throw new Error('manifest.json manquant') })
        let json: unknown
        try { json = JSON.parse(raw) } catch { throw new Error('manifest.json invalide (JSON)') }
        const result = ManifestSchema.safeParse(json)
        if (!result.success) throw new Error('manifest invalide: ' + result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
        if (result.data.id !== id) throw new Error(`id "${result.data.id}" différent du dossier "${id}"`)
        manifests.set(id, result.data)
      } catch (err) {
        errors.push({ id, error: (err as Error).message })
      }
    }
    this.manifests = manifests
    this.errors = errors
  }
}
