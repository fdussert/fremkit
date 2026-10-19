/**
 * The right-click menus of the rest of the editor — the pages list, the widget library, the bar's
 * widgets and the screens selector — built the way the canvas's are (`canvasMenu.ts`): one
 * function per menu, reading the store as it is when the menu opens, every command going through
 * a store action so undo, redo and saving behave as they do for the buttons.
 *
 * A destructive command confirms the way the canvas's "Delete everywhere" does: its submenu is
 * the question, naming what goes. A menu needs no second click on an armed button.
 */
import { reactive } from 'vue'
import { pick, t } from '../shared/i18n'
import { SEPARATOR, tidy, type MenuEntry, type MenuItem } from '../shared/ui/contextMenu'
import { revealPageBackground, type MenuUi } from './canvasMenu'
import type { MarketplaceStore } from './marketplace'
import { navItemsOf } from '../shared/types'
import { screensShowing } from '../shared/screens'
import type { AdminStore } from './store'
import { openExport, pickLayoutFile } from './share'
import { openSettings } from './settingsWindow'

/** What the pages list adds to a menu: the inline rename lives in the list itself. */
export interface PageMenuUi extends MenuUi {
  rename(i: number): void
}

/** The menu of page `i` of the screen being edited. */
export function pageMenu(s: AdminStore, i: number, ui: PageMenuUi): MenuEntry[] {
  const cfg = s.state.config
  const scr = s.screen.value
  const page = scr?.pages[i]
  if (!cfg || !scr || !page) return []
  const others = cfg.screens.filter((x) => x.id !== scr.id)
  const last = scr.pages.length <= 1
  return tidy([
    { label: t('admin.pages.rename'), run: () => ui.rename(i) },
    { label: t('common.duplicate'), run: () => s.duplicatePage(i) },
    { label: t('admin.menu.pageBackground'), run: () => revealPageBackground(s, i, ui) },
    others.length > 0 && {
      label: t('admin.menu.copyToScreen'),
      children: others.map((x): MenuItem => ({ label: x.name, run: () => s.copyPageToScreen(i, x.id) })),
    },
    { label: t('admin.menu.exportPage'), run: () => openExport(s, { scope: 'page', screen: scr.id, page: page.id }) },
    SEPARATOR,
    { label: t('common.moveUp'), disabled: i === 0, run: () => s.movePage(i, -1) },
    { label: t('common.moveDown'), disabled: i === scr.pages.length - 1, run: () => s.movePage(i, 1) },
    SEPARATOR,
    {
      label: t('admin.menu.deletePage'), danger: true, disabled: last,
      children: [{ label: t('admin.menu.deletePageConfirm', { name: page.name }), danger: true, run: () => s.removePage(i) }],
    },
  ])
}

/**
 * The bar entries whose settings are unfolded in the Screen panel. Module state rather than the
 * editor's own, so "Settings…" from a menu can unfold one before the panel is even open.
 */
export const navSettingsOpen = reactive<string[]>([])

/** Unfolds (or folds) one bar entry's settings in the Screen panel. */
export function toggleNavSettings(instanceId: string, open = !navSettingsOpen.includes(instanceId)): void {
  const at = navSettingsOpen.indexOf(instanceId)
  if (open && at < 0) navSettingsOpen.push(instanceId)
  if (!open && at >= 0) navSettingsOpen.splice(at, 1)
}

/** The Screen panel's section holding the bar's widgets. */
export const NAV_WIDGETS_SECTION = 'screen.navWidgets'

/** The menu of one widget in this screen's bar, from the Screen panel or the canvas's bar. */
export function navWidgetMenu(s: AdminStore, instanceId: string, ui: MenuUi): MenuEntry[] {
  const cfg = s.state.config
  const scr = s.screen.value
  const item = scr?.nav.find((x) => x.instanceId === instanceId)
  const widget = cfg?.widgets[instanceId]
  if (!cfg || !scr || !item || !widget) return []
  const manifest = s.state.manifests[widget.widgetId]
  const name = widget.title?.trim() || pick(manifest?.name) || widget.widgetId
  // Reordering is within a side, as the panel's arrows do it; the ends of a side are disabled.
  const side = navItemsOf(scr).filter((x) => x.slot === item.slot)
  const at = side.findIndex((x) => x.instanceId === instanceId)
  const fix = ui.fix?.(instanceId)
  const update = ui.update?.(instanceId)
  return tidy([
    fix && { label: fix.label, run: fix.run },
    update && { label: update.label, run: update.run },
    (fix || update) && SEPARATOR,
    {
      label: t('admin.menu.settings'),
      run: () => {
        toggleNavSettings(instanceId, true)
        if (s.state.modal !== 'settings') s.openModal('settings')
        ui.revealSection(NAV_WIDGETS_SECTION)
      },
    },
    SEPARATOR,
    { label: t('admin.menu.moveLeft'), disabled: at <= 0, run: () => s.moveNavWidget(instanceId, -1) },
    { label: t('admin.menu.moveRight'), disabled: at < 0 || at >= side.length - 1, run: () => s.moveNavWidget(instanceId, 1) },
    SEPARATOR,
    s.isLastPlace(instanceId)
      ? {
        label: t('admin.menu.deleteEverywhere'), danger: true,
        children: [{ label: t('admin.menu.deleteConfirm', { name }), danger: true, run: () => s.removeNavWidget(instanceId) }],
      }
      : { label: t('admin.menu.removeFromBar'), run: () => s.removeNavWidget(instanceId) },
  ])
}

/** Opens the marketplace on one widget: the view that holds it, its card alone in the list. */
function showInSietch(s: AdminStore, market: MarketplaceStore, widgetId: string, view: 'installed' | 'updates'): void {
  market.state.kind = 'widget'
  market.setView(view)
  market.state.search = widgetId
  s.openModal('marketplace')
}

/** The menu of one card of the widget library: a kind of widget, not an instance. */
export function libraryMenu(s: AdminStore, market: MarketplaceStore, widgetId: string): MenuEntry[] {
  const manifest = s.state.manifests[widgetId]
  const scr = s.screen.value
  if (!manifest || !scr) return []
  const name = pick(manifest.name) || widgetId
  const installed = s.state.sources[widgetId] === 'installed'
  const listed = market.state.widgets.find((w) => w.id === widgetId)
  const update = listed?.updateAvailable ? listed : null
  return tidy([
    {
      label: t('admin.menu.addToPage'),
      children: scr.pages.map((p, i): MenuItem => ({ label: p.name, run: () => s.addWidgetToPage(widgetId, i) })),
    },
    manifest.compact && { label: t('admin.menu.addToBar'), run: () => s.addNavWidget(widgetId) },
    SEPARATOR,
    (installed || listed) && { label: t('admin.menu.showInSietch'), run: () => showInSietch(s, market, widgetId, 'installed') },
    update && {
      label: t('admin.menu.updateTo', { version: update.version }),
      // The update runs where its consent dialog lives: in the marketplace, on the Updates view.
      run: () => { showInSietch(s, market, widgetId, 'updates'); void market.start(update, true) },
    },
    installed && {
      label: t('admin.menu.uninstall'), danger: true,
      children: [{
        label: t('admin.menu.uninstallConfirm', { name }), danger: true,
        // In the marketplace too, which is where it asks about the connections left behind.
        run: () => { showInSietch(s, market, widgetId, 'installed'); void market.uninstall(widgetId) },
      }],
    },
  ])
}

/** What the screens selector adds to a menu: the inline rename lives in the selector itself. */
/** The menu of the bar's own background, in the canvas: what the bar is set up from. */
export function navBarMenu(s: AdminStore, ui: MenuUi): MenuEntry[] {
  if (!s.state.config) return []
  const reveal = (id: string): void => { s.openModal('settings'); ui.revealSection(id) }
  return tidy([
    { label: t('admin.menu.newPage'), run: () => s.addPage() },
    { label: t('admin.menu.addNavWidget'), run: () => reveal('screen.navWidgets') },
    SEPARATOR,
    { label: t('admin.menu.navBarSettings'), run: () => reveal('screen.layout') },
  ])
}

export interface ScreenMenuUi {
  rename(screenId: string): void
}

/** The menu of one screen in the selector above the canvas. */
export function screenMenu(s: AdminStore, screenId: string, ui: ScreenMenuUi, devices: string[] = []): MenuEntry[] {
  const cfg = s.state.config
  const scr = cfg?.screens.find((x) => x.id === screenId)
  if (!cfg || !scr) return []
  const last = cfg.screens.length <= 1
  // The same count the Screen panel's confirmation gives: the widgets no other screen shows.
  const ids = new Set([...scr.nav.map((x) => x.instanceId), ...scr.pages.flatMap((p) => p.items.map((x) => x.instanceId))])
  const onlyHere = [...ids].filter((id) => screensShowing(cfg, id).every((x) => x.id === scr.id)).length
  return tidy([
    { label: t('admin.screens.rename'), run: () => ui.rename(screenId) },
    { label: t('admin.menu.screenSettings'), run: () => { s.selectScreen(screenId); openSettings(s, 'screen') } },
    { label: t('admin.menu.reloadDashboard'), run: () => { void s.reloadScreen(screenId) } },
    SEPARATOR,
    { label: t('admin.menu.exportScreen'), run: () => openExport(s, { scope: 'screen', screen: screenId }) },
    { label: t('admin.menu.exportSetup'), run: () => openExport(s, { scope: 'setup' }) },
    { label: t('admin.menu.importLayout'), run: () => { s.selectScreen(screenId); pickLayoutFile(s) } },
    SEPARATOR,
    {
      label: t('admin.inspector.screen.remove'), danger: true, disabled: last,
      children: tidy([
        // A paired device showing it is left with nothing: said before, as the Screen panel does.
        devices.length > 0 && { label: t('admin.menu.screenDevices', { names: devices.join(', ') }), disabled: true },
        devices.length > 0 && SEPARATOR,
        {
          label: t(onlyHere ? 'admin.menu.deleteScreenWidgets' : 'admin.menu.deleteScreenConfirm', { name: scr.name, count: onlyHere }),
          danger: true, run: () => s.removeScreen(screenId),
        },
      ]),
    },
  ])
}
