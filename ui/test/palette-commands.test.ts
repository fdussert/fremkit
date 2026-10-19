import { describe, expect, it, vi } from 'vitest'
import { createAdminStore } from '../src/admin/store'
import { buildCommands, fromMenu, type PaletteSources, type PaletteUi } from '../src/admin/paletteCommands'
import { searchCommands, type Command } from '../src/admin/palette'
import { widgetMenu } from '../src/admin/canvasMenu'
import { setLocale } from '../src/shared/i18n'
import { SEPARATOR } from '../src/shared/ui/contextMenu'
import type { MarketplaceStore } from '../src/admin/marketplace'
import type { HealthEntry } from '../src/admin/health'
import type { Config, WidgetManifest } from '../src/shared/types'

const clock: WidgetManifest = {
  id: 'clock', name: 'Clock', version: '1.0.0', sdk: 1, description: 'The time', icon: 'clock',
  minSize: [4, 2], defaultSize: [8, 4], subscriptions: [], commands: [],
  settingsSchema: {
    format: { type: 'enum', label: { en: 'Time format', fr: 'Format de l’heure' }, options: ['12', '24'] },
    compactOnly: { type: 'boolean', label: 'Bar only', scope: 'compact' },
  },
  permissions: { network: [] },
}
const meteo: WidgetManifest = { ...clock, id: 'meteo', name: 'Météo', settingsSchema: {} }

function config(): Config {
  return {
    version: 4, locale: 'en', connections: [], secrets: { backend: 'file' },
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    widgets: {
      'clock-1': { widgetId: 'clock', showTitle: true, settings: {}, title: 'Paris' },
      'meteo-1': { widgetId: 'meteo', showTitle: true, settings: {} },
    },
    screens: [
      {
        id: 'edge', name: 'Edge', kind: 'edge', display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 }, nav: [],
        pages: [
          { id: 'a', name: 'Home', items: [{ instanceId: 'clock-1', x: 0, y: 0, w: 8, h: 4 }] },
          { id: 'b', name: 'Work', items: [{ instanceId: 'meteo-1', x: 0, y: 0, w: 8, h: 4 }] },
        ],
      },
      {
        id: 'ipad', name: 'iPad', kind: 'edge', display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 }, nav: [],
        pages: [{ id: 'c', name: 'Main', items: [] }],
      },
    ],
  }
}

async function make() {
  setLocale('en')
  const store = createAdminStore({
    api: {
      getConfig: async () => config(), getStatus: async () => ({ degraded: false }),
      getWidgets: async () => ({ widgets: { clock, meteo }, errors: [], sources: {}, asks: {}, sdk: 1 }),
      putConfig: async (c) => c, rescan: async () => ({ widgets: {}, errors: [], sources: {}, asks: {}, sdk: 1 }),
    },
    subscribeConfig: () => () => {},
    debounceMs: 0,
  })
  await store.load()
  const ui: PaletteUi = {
    revealSection: vi.fn(), focusLibrarySearch: vi.fn(), renamePage: vi.fn(), renameScreen: vi.fn(),
    openHistory: vi.fn(), openShortcuts: vi.fn(),
  }
  const health = { entries: [] as HealthEntry[], fix: vi.fn(() => null), update: vi.fn(() => null), run: vi.fn() }
  const sources: PaletteSources = {
    store, ui, health,
    market: { state: { widgets: [] } } as unknown as MarketplaceStore,
    connections: [{ id: 'gh', type: 'github', name: 'Work account', fields: {}, secrets: {} }],
    connectionTypes: [{ id: 'github', name: 'GitHub', description: '', icon: 'github', fields: [] }],
    themes: [{ id: 'fremkit', label: 'Fremkit' }, { id: 'edge', label: 'Edge' }],
    theme: 'fremkit',
  }
  return { store, ui, health, sources }
}

const find = (commands: Command[], group: string, label: string): Command => {
  const hit = commands.find((c) => c.group === group && c.label === label)
  if (!hit) throw new Error(`no ${group} "${label}" in ${commands.filter((c) => c.group === group).map((c) => c.label).join(', ')}`)
  return hit
}

describe('fromMenu', () => {
  it('keeps labels, hints, checks and submenus, drops separators, ids by path', () => {
    const run = vi.fn()
    const out = fromMenu([
      { label: 'Duplicate', shortcut: '⌘D', run }, SEPARATOR,
      { label: 'Size', children: [{ label: 'Default', checked: true, run }] },
    ], 'widget', 'w:x', 'Clock')
    expect(out.map((c) => c.label)).toEqual(['Duplicate', 'Size'])
    expect(out[0]).toMatchObject({ id: 'w:x/Duplicate', shortcut: '⌘D', context: 'Clock', run })
    expect(out[1].run).toBeUndefined()
    expect(out[1].children![0]).toMatchObject({ id: 'w:x/Size/Default', checked: true, group: 'widget' })
  })
})

describe('buildCommands', () => {
  it('offers the selected tile its whole right-click menu, and a new menu item with it', async () => {
    const { store, sources } = await make()
    store.select('clock-1')
    const commands = buildCommands(sources)
    const widget = commands.filter((c) => c.group === 'widget').map((c) => c.label)
    const menu = widgetMenu(store, 'clock-1', sources.ui).filter((e) => !('separator' in e)).map((e) => (e as { label: string }).label)
    expect(widget).toEqual(menu)
    find(commands, 'widget', 'Duplicate').run!()
    expect(Object.keys(store.state.config!.widgets)).toHaveLength(3)
  })

  it('has no widget section with nothing selected, or in Test mode', async () => {
    const { store, sources } = await make()
    expect(buildCommands(sources).some((c) => c.group === 'widget')).toBe(false)
    store.select('clock-1')
    store.setMode('test')
    expect(buildCommands(sources).some((c) => c.group === 'widget')).toBe(false)
  })

  it('lists the page, canvas and screen menus once each, then the top bar', async () => {
    const { sources, ui } = await make()
    const actions = buildCommands(sources).filter((c) => c.group === 'actions')
    const labels = actions.map((c) => c.label)
    expect(new Set(labels).size).toBe(labels.length)
    for (const label of ['New page', 'Duplicate', 'Page background…', 'Screen settings…', 'Reload the dashboard', 'Export screen…', 'Import a layout…',
      'Undo', 'Redo', 'Switch to Test mode', 'Open Connections', 'Open the Sietch', 'Version history', 'Theme', 'Copy diagnostics…', 'Keyboard shortcuts']) {
      expect(labels, label).toContain(label)
    }
    expect(find(actions, 'actions', 'Undo').disabled).toBe(true)
    find(actions, 'actions', 'Rename').run!()
    expect(ui.renamePage).toHaveBeenCalledWith(0)
    find(actions, 'actions', 'Keyboard shortcuts').run!()
    expect(ui.openShortcuts).toHaveBeenCalled()
  })

  it('switches the theme from a submenu that checks the current one', async () => {
    const { store, sources } = await make()
    const theme = find(buildCommands(sources), 'actions', 'Theme')
    expect(theme.children!.map((c) => [c.label, c.checked])).toEqual([['Fremkit', true], ['Edge', false]])
    theme.children![1].run!()
    expect(store.state.config!.theme).toBe('edge')
  })

  it('goes to any page of any screen, and to a screen', async () => {
    const { store, sources } = await make()
    const commands = buildCommands(sources)
    expect(find(commands, 'goto', 'Home').checked).toBe(true)
    find(commands, 'goto', 'Main').run!()
    expect(store.screen.value!.id).toBe('ipad')
    find(commands, 'goto', 'Edge').run!()
    expect(store.screen.value!.id).toBe('edge')
  })

  it('selects a tile of this screen on whichever page it is, by its title', async () => {
    const { store, sources } = await make()
    const commands = buildCommands(sources)
    expect(commands.filter((c) => c.group === 'select').map((c) => c.label)).toEqual(['Paris', 'Météo'])
    find(commands, 'select', 'Météo').run!()
    expect(store.state.pageIndex).toBe(1)
    expect(store.state.selectedId).toBe('meteo-1')
    // The search folds accents, as the library's does.
    expect(searchCommands(commands, 'meteo').flatMap((s) => s.hits.map((h) => h.command.id))).toContain('select:meteo-1')
  })

  it('adds a widget onto the current page', async () => {
    const { store, sources } = await make()
    store.selectPage(1)
    const add = find(buildCommands(sources), 'add', 'Clock')
    expect(add.children!.length).toBeGreaterThan(0)
    add.run!()
    expect(store.page.value!.items).toHaveLength(2)
  })

  it('opens a connection by its name', async () => {
    const { store, sources } = await make()
    const c = find(buildCommands(sources), 'connections', 'Work account')
    expect(c.context).toBe('GitHub')
    c.run!()
    expect(store.state.modal).toBe('connections')
    expect(store.state.editConnectionId).toBe('gh')
  })

  it('jumps to a tile setting by its label, leaving out what only the bar reads', async () => {
    const { sources, health } = await make()
    const settings = buildCommands(sources).filter((c) => c.group === 'settings')
    expect(settings.map((c) => [c.label, c.context])).toEqual([['Time format', 'Paris']])
    settings[0].run!()
    expect(health.run).toHaveBeenCalledWith('clock-1', { kind: 'settings', field: 'format' })
  })

  it('lists the health fixes first, by widget', async () => {
    const { store, sources } = await make()
    const run = vi.fn()
    sources.health.entries = [{
      instanceId: 'meteo-1', widget: store.state.config!.widgets['meteo-1'],
      health: { level: 'error', problems: [{ level: 'error', code: 'offline', action: { kind: 'reload' } }], update: null },
      place: { screenId: 'edge', screenName: 'Edge', pageIndex: 1, pageName: 'Work' },
    }]
    sources.health.fix = vi.fn((id: string) => (id === 'meteo-1' ? { label: 'Fix: Reload', run } : null))
    const commands = buildCommands(sources)
    const fix = commands.find((c) => c.group === 'fix')!
    expect(fix).toMatchObject({ label: 'Fix: Reload', context: 'Météo' })
    expect(searchCommands(commands, '')[0].group).toBe('fix')
    fix.run!()
    expect(run).toHaveBeenCalled()
  })
})
