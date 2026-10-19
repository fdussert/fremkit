/**
 * What a right click on the editor's canvas offers: one function per menu, each building the list
 * from the store as it is at that moment. Every command goes through a store action, so undo,
 * redo and saving work exactly as they do for the inspector's buttons.
 */
import { pick, t } from '../shared/i18n'
import { surfaceOpacity } from '../shared/background'
import { screensShowing } from '../shared/screens'
import { SEPARATOR, tidy, type MenuEntry, type MenuItem } from '../shared/ui/contextMenu'
import { STYLE_KEYS, type AdminStore } from './store'
import { shortcutHint } from './shortcuts'
import { openSettings } from './settingsWindow'
import type { SettingField, Widget, WidgetManifest } from '../shared/types'

/** What a menu does outside the store: moving the eye to a part of the editor. */
export interface MenuUi {
  /** Opens an inspector section by its id (`widget.settings`, `widget.accent`…) and scrolls to it. */
  revealSection(id: string): void
  /** Puts the cursor in the widget library's search box. */
  focusLibrarySearch(): void
  /**
   * The fix of a widget that is not well (`useHealth`), or null when it is. A widget's menus lead
   * with it, so the problem a badge shows is one click from its cure.
   */
  fix?(instanceId: string): { label: string; run: () => void } | null
  /** "Update to vX" for a widget with a newer version in the registry: news, not a fix. */
  update?(instanceId: string): { label: string; run: () => void } | null
}

/** The inspector section `revealSection` opens for a page's own background. */
export const PAGE_BACKGROUND_SECTION = 'page.background'

/**
 * Shows page `i` with no widget selected, so the inspector holds the page, and opens its
 * background section: where every "Page background…" leads.
 */
export function revealPageBackground(s: AdminStore, i: number, ui: MenuUi): void {
  s.selectPage(i)
  ui.revealSection(PAGE_BACKGROUND_SECTION)
}

/** The tile opacities the Appearance submenu offers, in percent. */
export const OPACITY_PRESETS = [100, 80, 60, 40, 0] as const

/** The shortcut hints, as macOS spells them: read from the editor's one table of shortcuts. */
export const KEYS = {
  duplicate: shortcutHint('duplicate'), copy: shortcutHint('copy'), paste: shortcutHint('paste'), remove: shortcutHint('remove'),
} as const

/**
 * The connection a widget's settings point at — the first `connection` or `connections` field
 * that holds an id — or, when none holds one yet, the type it would need, so the menu can offer
 * to create it.
 */
export function connectionOf(manifest: WidgetManifest | undefined, widget: Widget): { id: string } | { type: string } | null {
  let type = ''
  for (const [key, field] of Object.entries(manifest?.settingsSchema ?? {}) as [string, SettingField][]) {
    if (field.type !== 'connection' && field.type !== 'connections') continue
    const value = widget.settings[key] ?? field.default
    const id = Array.isArray(value) ? value.find((v) => typeof v === 'string' && v) : value
    if (typeof id === 'string' && id) return { id }
    if (!type && field.connectionType) type = field.connectionType
  }
  return type ? { type } : null
}

/** The menu of one tile on the canvas. Empty when the tile is not on the page being edited. */
export function widgetMenu(s: AdminStore, instanceId: string, ui: MenuUi): MenuEntry[] {
  const cfg = s.state.config
  const scr = s.screen.value
  const pages = scr?.pages ?? []
  const placement = s.page.value?.items.find((p) => p.instanceId === instanceId)
  const widget = cfg?.widgets[instanceId]
  if (!cfg || !scr || !placement || !widget) return []
  const manifest = s.state.manifests[widget.widgetId]
  const name = widget.title?.trim() || pick(manifest?.name) || widget.widgetId
  const locked = !!placement.locked

  const opacity = Math.round(surfaceOpacity(widget.opacity) * 100)
  const styled = STYLE_KEYS.some((k) => widget[k] !== undefined)
  const appearance: MenuEntry[] = [
    ...OPACITY_PRESETS.map((p): MenuItem => ({
      label: t('admin.menu.opacity', { percent: p }),
      checked: opacity === p,
      run: () => s.updateInstance(instanceId, { opacity: p === 100 ? undefined : p / 100 }),
    })),
    SEPARATOR,
    { label: t('admin.menu.surfaceColor'), run: () => ui.revealSection('widget.background') },
    { label: t('admin.menu.accent'), run: () => ui.revealSection('widget.accent') },
    { label: t('admin.menu.backgroundImage'), run: () => ui.revealSection('widget.background') },
    SEPARATOR,
    { label: t('admin.menu.resetAppearance'), disabled: !styled, run: () => s.resetAppearance(instanceId) },
  ]

  const otherScreens = cfg.screens.filter((x) => x.id !== scr.id)
  const showing = new Set(screensShowing(cfg, instanceId).map((x) => x.id))
  const screenItems = (run: (id: string) => void): MenuEntry[] => otherScreens.map((x) => ({
    label: x.name, disabled: showing.has(x.id), run: () => run(x.id),
  }))

  const sizes: MenuEntry[] = manifest
    ? ([['defaultSize', manifest.defaultSize], ['minSize', manifest.minSize]] as const).map(([key, size]) => ({
      label: t(`admin.menu.${key}`, { w: size[0], h: size[1] }),
      checked: placement.w === size[0] && placement.h === size[1],
      disabled: !s.canResize(instanceId, [size[0], size[1]]),
      run: () => s.resizeWidget(instanceId, [size[0], size[1]]),
    }))
    : []

  const connection = connectionOf(manifest, widget)
  const lastPlace = s.isLastPlace(instanceId)

  const fix = ui.fix?.(instanceId)
  const update = ui.update?.(instanceId)

  return tidy([
    fix && { label: fix.label, run: fix.run },
    update && { label: update.label, run: update.run },
    (fix || update) && SEPARATOR,
    { label: t('admin.menu.showTitle'), checked: widget.showTitle, run: () => s.updateInstance(instanceId, { showTitle: !widget.showTitle }) },
    { label: t('admin.menu.appearance'), children: appearance },
    { label: t('admin.menu.copyStyle'), run: () => s.copyStyle(instanceId) },
    { label: t('admin.menu.pasteStyle'), disabled: !s.state.styleClipboard, run: () => s.pasteStyle(instanceId) },
    SEPARATOR,
    { label: t('common.duplicate'), shortcut: KEYS.duplicate, run: () => s.duplicateWidget(instanceId) },
    { label: t('admin.menu.copy'), shortcut: KEYS.copy, run: () => s.copyWidget(instanceId) },
    { label: t('admin.menu.paste'), shortcut: KEYS.paste, disabled: !s.state.clipboard, run: () => s.pasteWidget() },
    SEPARATOR,
    {
      label: t('admin.menu.moveToPage'),
      children: tidy([
        ...pages.map((p, i): MenuItem => ({ label: p.name, disabled: i === s.state.pageIndex, run: () => s.moveWidget(instanceId, i) })),
        SEPARATOR,
        { label: t('admin.menu.newPage'), run: () => s.moveWidgetToNewPage(instanceId) },
      ]),
    },
    otherScreens.length > 0 && { label: t('admin.menu.alsoShowOn'), children: screenItems((id) => s.showOnScreen(instanceId, id)) },
    otherScreens.length > 0 && { label: t('admin.menu.moveToScreen'), children: screenItems((id) => s.moveToScreen(instanceId, id)) },
    sizes.length > 0 && { label: t('admin.menu.size'), children: sizes },
    { label: t('admin.menu.lock'), checked: locked, run: () => s.setLocked(instanceId, !locked) },
    SEPARATOR,
    connection && {
      label: t('admin.menu.openConnection'),
      run: () => ('id' in connection ? s.openConnection(connection.id) : s.openNewConnection(connection.type)),
    },
    { label: t('admin.menu.about'), run: () => s.openAbout(instanceId) },
    { label: t('admin.menu.reload'), run: () => s.reloadWidget(instanceId) },
    SEPARATOR,
    // On its last screen the widget itself goes: the submenu is the confirmation, naming it.
    lastPlace
      ? {
        label: t('admin.menu.deleteEverywhere'), danger: true,
        children: [{ label: t('admin.menu.deleteConfirm', { name }), danger: true, run: () => s.removeFromScreen(instanceId) }],
      }
      : { label: t('admin.menu.removeFromScreen'), shortcut: KEYS.remove, run: () => s.removeFromScreen(instanceId) },
  ])
}

/**
 * The menu of several selected tiles: what makes sense for all of them at once. Each command is
 * one store action, so one undo step, whatever the number of tiles.
 */
export function selectionMenu(s: AdminStore, ids: string[]): MenuEntry[] {
  const cfg = s.state.config
  const scr = s.screen.value
  const tiles = (s.page.value?.items ?? []).filter((p) => ids.includes(p.instanceId) && cfg?.widgets[p.instanceId])
  if (!cfg || !scr || tiles.length < 2) return []
  const list = tiles.map((p) => p.instanceId)
  const widgets = list.map((id) => cfg.widgets[id])
  const allShown = widgets.every((w) => w.showTitle)
  const allLocked = tiles.every((p) => p.locked)
  const opacities = new Set(widgets.map((w) => Math.round(surfaceOpacity(w.opacity) * 100)))
  const styled = widgets.some((w) => STYLE_KEYS.some((k) => w[k] !== undefined))
  // Removing deletes the widgets this screen alone shows: then the submenu is the confirmation.
  const deletes = list.filter((id) => s.isLastPlace(id)).length

  return tidy([
    { label: t('admin.menu.showTitle'), checked: allShown, run: () => s.updateWidgets(list, { showTitle: !allShown }) },
    {
      label: t('admin.menu.appearance'),
      children: [
        ...OPACITY_PRESETS.map((p): MenuItem => ({
          label: t('admin.menu.opacity', { percent: p }),
          checked: opacities.size === 1 && opacities.has(p),
          run: () => s.updateWidgets(list, { opacity: p === 100 ? undefined : p / 100 }),
        })),
        SEPARATOR,
        {
          label: t('admin.menu.resetAppearance'), disabled: !styled,
          run: () => s.updateWidgets(list, Object.fromEntries(STYLE_KEYS.map((k) => [k, undefined]))),
        },
      ],
    },
    SEPARATOR,
    { label: t('common.duplicate'), shortcut: KEYS.duplicate, run: () => s.duplicateTiles(list) },
    { label: t('admin.menu.copy'), shortcut: KEYS.copy, run: () => s.copyTiles(list) },
    { label: t('admin.menu.paste'), shortcut: KEYS.paste, disabled: !s.state.clipboard, run: () => s.pasteWidget() },
    SEPARATOR,
    {
      label: t('admin.menu.moveToPage'),
      children: tidy([
        ...scr.pages.map((p, i): MenuItem => ({ label: p.name, disabled: i === s.state.pageIndex, run: () => s.moveTilesToPage(list, i) })),
        SEPARATOR,
        { label: t('admin.menu.newPage'), run: () => s.moveTilesToNewPage(list) },
      ]),
    },
    { label: t('admin.menu.lock'), checked: allLocked, run: () => s.setLockedTiles(list, !allLocked) },
    SEPARATOR,
    !deletes
      ? { label: t('admin.menu.removeTilesFromScreen', { n: list.length }), shortcut: KEYS.remove, run: () => s.removeTiles(list) }
      : deletes === list.length
        ? {
          label: t('admin.menu.deleteEverywhere'), danger: true,
          children: [{ label: t('admin.menu.deleteTilesConfirm', { n: list.length }), danger: true, run: () => s.removeTiles(list) }],
        }
        : {
          label: t('admin.menu.removeTiles', { n: list.length }), danger: true,
          children: [{ label: t('admin.menu.removeTilesConfirm'), danger: true, run: () => s.removeTiles(list) }],
        },
  ])
}

/** The menu of the canvas's empty background. */
export function canvasMenu(s: AdminStore, ui: MenuUi): MenuEntry[] {
  if (!s.state.config) return []
  const hasTiles = !!s.page.value?.items.length
  return tidy([
    { label: t('admin.menu.paste'), shortcut: KEYS.paste, disabled: !s.state.clipboard, run: () => s.pasteWidget() },
    { label: t('admin.menu.selectAll'), shortcut: shortcutHint('selectAll'), disabled: !hasTiles, run: () => s.selectAll() },
    SEPARATOR,
    { label: t('admin.menu.addWidget'), run: () => ui.focusLibrarySearch() },
    { label: t('admin.menu.newPage'), run: () => s.addPage() },
    SEPARATOR,
    { label: t('admin.menu.pageBackground'), run: () => revealPageBackground(s, s.state.pageIndex, ui) },
    { label: t('admin.menu.screenSettings'), run: () => openSettings(s, 'screen') },
    SEPARATOR,
    { label: t('admin.menu.reloadDashboard'), run: () => { const id = s.screen.value?.id; if (id) void s.reloadScreen(id) } },
  ])
}
