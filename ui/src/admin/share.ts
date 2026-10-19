/**
 * "Export…" and "Import a layout…": what the two dialogs are open about, and how a file gets to
 * the import dialog — a menu, a button or a drop onto the admin.
 *
 * The server builds and reads the file (`server/src/share/`); the admin shows it and applies it
 * through the store's `apply()`, as `shareApply.ts`. Module state rather than the store's: none
 * of it is part of the dashboard, and a menu can open a dialog before any component holds it.
 */
import { reactive } from 'vue'
import { t } from '../shared/i18n'
import type { LayoutRequest } from '../shared/api'
import type { AdminStore } from './store'

/** Largest file the admin even tries to read: the server's own limit, plus room. */
export const MAX_LAYOUT_FILE_BYTES = 24 * 1024 * 1024

export interface ShareState {
  /** What the export dialog is building. */
  exporting: LayoutRequest | null
  /** The parsed file the import dialog is reading, and the name it came under. */
  importing: { raw: unknown; fileName: string } | null
}

export const share = reactive<ShareState>({ exporting: null, importing: null })

/** Opens the export dialog on a page, a screen or the whole setup. Saves pending edits first. */
export function openExport(s: AdminStore, req: LayoutRequest): void {
  share.exporting = req
  s.openModal('export')
}

/** True for a drag that carries files — not one of the editor's own widget drags. */
export function carriesFiles(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
}

/** Reads a dropped or picked file and opens the import dialog on it, or says why it cannot. */
export async function openImportFile(s: AdminStore, file: File): Promise<void> {
  if (file.size > MAX_LAYOUT_FILE_BYTES) { s.state.toast = t('admin.share.import.tooLarge'); return }
  let raw: unknown
  try {
    raw = JSON.parse(await file.text())
  } catch {
    s.state.toast = t('admin.share.import.notJson', { name: file.name })
    return
  }
  share.importing = { raw, fileName: file.name }
  s.openModal('import')
}

/**
 * Asks for a layout file with the system's picker. A transient input, so a menu can call it with
 * no component holding one; the helper's admin window answers it through its open panel.
 */
export function pickLayoutFile(s: AdminStore): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json,application/json'
  input.style.display = 'none'
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    input.remove()
    if (file) void openImportFile(s, file)
  })
  document.body.appendChild(input)
  input.click()
}

/** `1.2 MB`, `340 kB`: sizes in the dialogs. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} kB`
}
