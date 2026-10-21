/**
 * What the command palette offers, built at the moment it opens from the editor as it is then.
 *
 * Most commands are not written here: the palette reads the editor's own right-click menus — the
 * selected tile's (`widgetMenu`), the canvas's, the page's, the screen's, a library card's — and
 * turns each item into a command, submenus included (`fromMenu`). A command added to one of those
 * menus is therefore in the palette with nothing to do here. What is written here is what no menu
 * holds: the top bar's buttons (undo, redo, Edit/Test, Connections, Sietch, history), the theme,
 * diagnostics, the shortcuts sheet, and the lists — pages and screens to go to, tiles to select,
 * widgets to add, connections, settings and the widget health's fixes.
 */
import { pick, t } from '../shared/i18n'
import { isSeparator, type MenuEntry } from '../shared/ui/contextMenu'
import type { ConnectionSummary, ConnectionTypeInfo, SettingField } from '../shared/types'
import { canvasMenu, selectionMenu, widgetMenu, type MenuUi } from './canvasMenu'
import { libraryMenu, pageMenu, screenMenu } from './menus'
import { describeProblem, type HealthAction, type HealthEntry } from './health'
import type { MarketplaceStore } from './marketplace'
import { shortcutHint } from './shortcuts'
import { offeredManifests } from './labs'
import type { AdminStore } from './store'
import type { Command, PaletteGroup } from './palette'

/** What the palette does outside the store. */
export interface PaletteUi extends MenuUi {
  renamePage(i: number): void
  renameScreen(id: string): void
  /** The Screen panel, scrolled to its history. */
  openHistory(): void
  openShortcuts(): void
}

/** What the palette reads from the widget health (`useHealth`). */
export interface PaletteHealth {
  entries: HealthEntry[]
  fix(instanceId: string): { label: string; run: () => void } | null
  update(instanceId: string): { label: string; run: () => void } | null
  run(instanceId: string, action: HealthAction): void
}

export interface PaletteSources {
  store: AdminStore
  market: MarketplaceStore
  ui: PaletteUi
  health: PaletteHealth
  connections: ConnectionSummary[]
  connectionTypes: ConnectionTypeInfo[]
  /** The themes the server knows, for the Theme submenu. */
  themes: { id: string; label: string }[]
  /** The theme in use, so its row is checked. */
  theme: string
}

/**
 * A menu's items as commands of `group`: same labels, hints, checks and submenus; separators
 * dropped. Ids are the labels' path under `prefix`, so a command keeps its id while its menu does.
 */
export function fromMenu(entries: MenuEntry[], group: PaletteGroup, prefix: string, context?: string): Command[] {
  const out: Command[] = []
  for (const e of entries) {
    if (isSeparator(e)) continue
    const id = `${prefix}/${e.label}`
    out.push({
      id, group, label: e.label, context,
      shortcut: e.shortcut, checked: e.checked, disabled: e.disabled, danger: e.danger,
      run: e.children?.length ? undefined : e.run,
      children: e.children?.length ? fromMenu(e.children, group, id) : undefined,
    })
  }
  return out
}

/** What the user calls a widget: its title, else its manifest's name, else its id. */
function widgetName(s: AdminStore, instanceId: string): string {
  const w = s.state.config?.widgets[instanceId]
  if (!w) return instanceId
  return w.title?.trim() || pick(s.state.manifests[w.widgetId]?.name) || w.widgetId
}

export function buildCommands(src: PaletteSources): Command[] {
  const { store: s, ui } = src
  const cfg = s.state.config
  const scr = s.screen.value
  const page = s.page.value
  if (!cfg || !scr || !page) return []
  const out: Command[] = []
  const several = cfg.screens.length > 1

  // --- Fixes: the health list's buttons, worst first, as the top bar lists them.
  for (const entry of src.health.entries) {
    const fix = src.health.fix(entry.instanceId)
    if (!fix) continue
    const problem = entry.health.problems[0]
    out.push({
      id: `fix:${entry.instanceId}`, group: 'fix', label: fix.label,
      context: widgetName(s, entry.instanceId),
      keywords: problem ? [describeProblem(problem)] : [],
      run: fix.run,
    })
  }

  // --- The selected tile: its right-click menu. Its fix is already in the fixes.
  const selected = s.selected.value
  if (selected && s.state.mode === 'edit') {
    const menu = widgetMenu(s, selected.instanceId, { ...ui, fix: undefined, update: src.health.update })
    out.push(...fromMenu(menu, 'widget', `widget:${selected.instanceId}`))
  }
  // --- Several selected tiles: the group's right-click menu.
  if (s.state.selection.length > 1 && s.state.mode === 'edit') {
    out.push(...fromMenu(selectionMenu(s, [...s.state.selection]), 'widget', 'selection'))
  }

  // --- Actions: the page's, the screen's and the canvas's menus, then the top bar's buttons.
  // The canvas menu repeats some of the others' ("Page background…", "Screen settings…"): the
  // first one listed is kept, with the page or screen it acts on as its context.
  const actions: Command[] = []
  const seen = new Set<string>()
  const keep = (commands: Command[]): void => {
    for (const c of commands) if (!seen.has(c.label)) { seen.add(c.label); actions.push(c) }
  }
  const pageContext = t('admin.palette.page', { name: page.name })
  const screenContext = t('admin.palette.screen', { name: scr.name })
  keep(fromMenu(pageMenu(s, s.state.pageIndex, { ...ui, rename: ui.renamePage }), 'actions', `page:${page.id}`, pageContext))
  keep(fromMenu(screenMenu(s, scr.id, { rename: ui.renameScreen }), 'actions', `screen:${scr.id}`, screenContext))
  keep(fromMenu(canvasMenu(s, ui), 'actions', 'canvas'))
  const testing = s.state.mode === 'test'
  keep([
    { id: 'app:undo', group: 'actions', label: t('admin.palette.undo'), shortcut: shortcutHint('undo'), disabled: !s.canUndo.value, run: () => s.undo() },
    { id: 'app:redo', group: 'actions', label: t('admin.palette.redo'), shortcut: shortcutHint('redo'), disabled: !s.canRedo.value, run: () => s.redo() },
    {
      id: 'app:mode', group: 'actions', label: t(testing ? 'admin.palette.editMode' : 'admin.palette.testMode'),
      keywords: [t('admin.topbar.mode.edit'), t('admin.topbar.mode.test')],
      run: () => s.setMode(testing ? 'edit' : 'test'),
    },
    { id: 'app:connections', group: 'actions', label: t('admin.palette.openConnections'), run: () => s.openModal('connections') },
    { id: 'app:sietch', group: 'actions', label: t('admin.palette.openSietch'), keywords: ['marketplace', 'registry'], run: () => s.openModal('marketplace') },
    { id: 'app:history', group: 'actions', label: t('admin.palette.history'), run: () => ui.openHistory() },
    {
      id: 'app:theme', group: 'actions', label: t('admin.palette.theme'),
      children: src.themes.map((theme): Command => ({
        id: `app:theme/${theme.id}`, group: 'actions', label: theme.label, checked: theme.id === src.theme,
        run: () => { if (theme.id !== src.theme) s.apply((c) => { c.theme = theme.id }) },
      })),
    },
    {
      id: 'app:diagnostics', group: 'actions', label: t('admin.palette.diagnostics'),
      run: () => { s.openModal('settings'); ui.revealSection('screen.about') },
    },
    { id: 'app:shortcuts', group: 'actions', label: t('admin.shortcuts.title'), shortcut: shortcutHint('shortcuts'), run: () => ui.openShortcuts() },
  ])
  out.push(...actions)

  // --- Go to: every page of every screen, then the screens.
  for (const screen of cfg.screens) {
    screen.pages.forEach((p, i) => {
      out.push({
        id: `goto:${screen.id}/${p.id}`, group: 'goto', label: p.name,
        context: several ? t('admin.palette.pageOf', { screen: screen.name }) : t('admin.palette.kind.page'),
        keywords: [t('admin.palette.kind.page')],
        checked: screen.id === scr.id && i === s.state.pageIndex,
        run: () => { if (screen.id !== scr.id) s.selectScreen(screen.id); s.selectPage(i) },
      })
    })
  }
  if (several) {
    for (const screen of cfg.screens) {
      out.push({
        id: `goto:${screen.id}`, group: 'goto', label: screen.name, context: t('admin.palette.kind.screen'),
        checked: screen.id === scr.id, run: () => s.selectScreen(screen.id),
      })
    }
  }

  // --- Select: every tile of this screen, by title or widget name.
  scr.pages.forEach((p, i) => {
    for (const item of p.items) {
      const widget = cfg.widgets[item.instanceId]
      if (!widget) continue
      const name = widgetName(s, item.instanceId)
      out.push({
        id: `select:${item.instanceId}`, group: 'select', label: name, context: p.name,
        keywords: [pick(s.state.manifests[widget.widgetId]?.name), widget.widgetId],
        checked: item.instanceId === s.state.selectedId,
        run: () => { s.setMode('edit'); s.selectPage(i); s.select(item.instanceId) },
      })
    }
  })

  // --- Add: every widget of the library, onto this page. → opens its card's menu.
  const manifests = offeredManifests(s.state.config, s.state.manifests).sort((a, b) => pick(a.name).localeCompare(pick(b.name)))
  for (const m of manifests) {
    const name = pick(m.name) || m.id
    out.push({
      id: `add:${m.id}`, group: 'add', label: name, context: t('admin.palette.addTo', { page: page.name }),
      keywords: [pick(m.description), m.id, t('admin.palette.add')],
      run: () => s.addWidgetToPage(m.id, s.state.pageIndex),
      children: fromMenu(libraryMenu(s, src.market, m.id), 'add', `add:${m.id}`),
    })
  }

  // --- Connections, by name.
  for (const c of src.connections) {
    out.push({
      id: `connection:${c.id}`, group: 'connections', label: c.name,
      context: src.connectionTypes.find((x) => x.id === c.type)?.name ?? c.type,
      keywords: [t('admin.palette.kind.connection')],
      run: () => s.openConnection(c.id),
    })
  }

  // --- Settings: every setting of every tile of this screen, by its label.
  for (const p of scr.pages) {
    for (const item of p.items) {
      const widget = cfg.widgets[item.instanceId]
      const schema = widget ? s.state.manifests[widget.widgetId]?.settingsSchema ?? {} : {}
      for (const [key, field] of Object.entries(schema) as [string, SettingField][]) {
        // A tile's form leaves out what only the bar's compact rendering reads.
        if (field.scope === 'compact') continue
        out.push({
          id: `setting:${item.instanceId}/${key}`, group: 'settings', label: pick(field.label) || key,
          context: widgetName(s, item.instanceId), keywords: [key],
          run: () => { s.setMode('edit'); src.health.run(item.instanceId, { kind: 'settings', field: key }) },
        })
      }
    }
  }
  return out
}
