import { nextTick, shallowRef } from 'vue'
import { setSectionsOpen } from '../shared/ui/BaseSection.vue'
import type { MenuUi } from './canvasMenu'
import { showSettingsSection } from './settingsWindow'

/**
 * Moving the eye to a part of the editor, for the commands a menu cannot finish by itself: a
 * colour is picked in the inspector, a widget is chosen in the library.
 */
export const editorFocus: MenuUi = {
  /**
   * Opens the section `id` and scrolls it into view: in the inspector, or in the settings window,
   * whose pane holding it comes up first. '' only brings the inspector up.
   */
  revealSection(id: string): void {
    if (!id) return
    showSettingsSection(id)
    setSectionsOpen([id], true)
    void nextTick(() => {
      document.querySelector(`[data-section="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
  },
  focusLibrarySearch(): void {
    const input = document.querySelector<HTMLInputElement>('[data-library-search] input')
    input?.focus()
    input?.select()
  },
}

/**
 * A rename asked for away from the list that does it in place — the command palette's "Rename" —
 * by page or screen id. The pages list and the screens selector watch it, start their inline
 * rename, and clear it.
 */
export const renameRequest = shallowRef<{ kind: 'page' | 'screen'; id: string } | null>(null)
