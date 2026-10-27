/**
 * The right-click menus of the GIF board's editor panel, built like the rest of the editor's
 * (`menus.ts`): read the store when the menu opens, edit through `apply()`. Renaming and labelling
 * happen inline in the panel, which hands its `ui` in.
 */
import { t } from '../shared/i18n'
import type { MenuEntry } from '../shared/ui/contextMenu'
import { removeGroup, removeItem } from './gifBoard'
import type { AdminStore } from './store'

export interface GifMenuUi {
  label(itemId: string): void
  rename(groupId: string): void
}

/** The menu of one GIF: its label, and removing it. */
export function gifItemMenu(s: AdminStore, itemId: string, ui: GifMenuUi): MenuEntry[] {
  const known = s.state.config?.gifs?.groups.some((g) => g.items.some((x) => x.id === itemId))
  if (!known) return []
  return [
    { label: t('admin.gifs.label'), run: () => ui.label(itemId) },
    { label: t('admin.gifs.remove'), danger: true, run: () => s.apply((c) => { if (c.gifs) removeItem(c.gifs, itemId) }) },
  ]
}

/** The menu of one group: renaming it, and deleting it with its GIFs once the submenu names them. */
export function gifGroupMenu(s: AdminStore, groupId: string, ui: GifMenuUi): MenuEntry[] {
  const group = s.state.config?.gifs?.groups.find((g) => g.id === groupId)
  if (!group) return []
  return [
    { label: t('admin.gifs.rename'), run: () => ui.rename(groupId) },
    {
      label: t('admin.gifs.deleteGroup'), danger: true,
      children: [{
        label: t('admin.gifs.deleteGroupConfirm', { name: group.name, count: group.items.length }), danger: true,
        run: () => s.apply((c) => { if (c.gifs) removeGroup(c.gifs, groupId) }),
      }],
    },
  ]
}
