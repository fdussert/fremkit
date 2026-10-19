import { describe, expect, it, vi } from 'vitest'
import { createAdminStore } from '../src/admin/store'
import { libraryMenu, navBarMenu, navSettingsOpen, navWidgetMenu, pageMenu, screenMenu, type PageMenuUi } from '../src/admin/menus'
import { dropIndex } from '../src/admin/pageDrag'
import { share } from '../src/admin/share'
import type { MarketplaceStore } from '../src/admin/marketplace'
import { setLocale } from '../src/shared/i18n'
import { isSeparator, type MenuEntry, type MenuItem } from '../src/shared/ui/contextMenu'
import type { Config, MarketplaceWidget, WidgetManifest } from '../src/shared/types'

const clock: WidgetManifest = {
  id: 'clock', name: 'Clock', version: '1.0.0', sdk: 1, description: '', icon: 'clock',
  minSize: [8, 4], defaultSize: [16, 4], subscriptions: [], commands: [],
  settingsSchema: {}, permissions: { network: [] }, compact: { width: 3 },
}
const huge: WidgetManifest = { ...clock, id: 'huge', name: 'Huge', minSize: [40, 4], defaultSize: [48, 4], compact: undefined }
const plain: WidgetManifest = { ...clock, id: 'plain', name: 'Plain', compact: undefined }

function config(): Config {
  return {
    version: 4, locale: 'en', connections: [], secrets: { backend: 'file' },
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    widgets: {
      'clock-1': { widgetId: 'clock', showTitle: true, settings: { tz: 'UTC' } },
      'huge-1': { widgetId: 'huge', showTitle: true, settings: {} },
      'clock-bar': { widgetId: 'clock', showTitle: true, settings: {} },
      'clock-bar2': { widgetId: 'clock', showTitle: true, settings: {} },
      'pad-1': { widgetId: 'clock', showTitle: true, settings: {} },
    },
    screens: [
      {
        id: 'edge', name: 'Edge', kind: 'edge', display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 },
        nav: [{ instanceId: 'clock-bar', slot: 'left' }, { instanceId: 'clock-bar2', slot: 'left' }],
        pages: [
          { id: 'a', name: 'Home', background: { image: 'dunes.webp' }, items: [
            { instanceId: 'clock-1', x: 0, y: 0, w: 16, h: 4 }, { instanceId: 'huge-1', x: 0, y: 4, w: 48, h: 4 },
          ] },
          { id: 'b', name: 'Work', items: [] },
          { id: 'c', name: 'Play', items: [] },
        ],
      },
      {
        id: 'pad', name: 'iPad', kind: 'device', display: { cols: 20, rows: 12, cell: 40, autoCycleSeconds: 0 }, nav: [],
        pages: [{ id: 'a', name: 'Main', items: [{ instanceId: 'pad-1', x: 0, y: 0, w: 8, h: 4 }] }],
      },
    ],
  }
}

async function make(sources: Record<string, 'builtin' | 'installed'> = {}) {
  setLocale('en')
  const store = createAdminStore({
    api: {
      getConfig: async () => config(), getStatus: async () => ({ degraded: false }),
      getWidgets: async () => ({ widgets: { clock, huge, plain }, errors: [], sources, asks: {}, sdk: 1 }),
      putConfig: async (c) => c, rescan: async () => ({ widgets: {}, errors: [], sources: {}, asks: {}, sdk: 1 }),
    },
    subscribeConfig: () => () => {},
    debounceMs: 0,
  })
  await store.load()
  return store
}
const pageUi = (): PageMenuUi => ({ revealSection: vi.fn(), focusLibrarySearch: vi.fn(), rename: vi.fn() })
const items = (menu: MenuEntry[]): MenuItem[] => menu.filter((e): e is MenuItem => !isSeparator(e))
const labels = (menu: MenuEntry[]): string[] => items(menu).map((e) => e.label)
const find = (menu: MenuEntry[], label: string): MenuItem => {
  const hit = items(menu).find((e) => e.label === label) ?? items(menu).find((e) => e.label.startsWith(label))
  if (!hit) throw new Error(`no "${label}" in ${labels(menu).join(', ')}`)
  return hit
}

describe('pageMenu', () => {
  it('offers the page commands, Move up greyed on the first page', async () => {
    const s = await make()
    const menu = pageMenu(s, 0, pageUi())
    expect(labels(menu)).toEqual(['Rename', 'Duplicate', 'Page background…', 'Copy to screen', 'Export page…', 'Move up', 'Move down', 'Delete page'])
    expect(find(menu, 'Move up').disabled).toBe(true)
    expect(find(menu, 'Move down').disabled).toBeFalsy()
    expect(labels(find(menu, 'Copy to screen').children!)).toEqual(['iPad'])
  })

  it('opens the export dialog on that page', async () => {
    const s = await make()
    find(pageMenu(s, 1, pageUi()), 'Export page').run!()
    expect(s.state.modal).toBe('export')
    expect(share.exporting).toEqual({ scope: 'page', screen: 'edge', page: 'b' })
  })

  it('renames through the list, and opens the page background on that page', async () => {
    const s = await make()
    const u = pageUi()
    find(pageMenu(s, 2, u), 'Rename').run!()
    expect(u.rename).toHaveBeenCalledWith(2)
    find(pageMenu(s, 2, u), 'Page background').run!()
    expect(s.state.pageIndex).toBe(2)
    expect(u.revealSection).toHaveBeenCalledWith('page.background')
  })

  it('confirms a delete in its submenu, naming the page, and greys it on the last page', async () => {
    const s = await make()
    const del = find(pageMenu(s, 1, pageUi()), 'Delete page')
    expect(labels(del.children!)).toEqual(['Delete “Work”'])
    find(del.children!, 'Delete “Work”').run!()
    expect(s.screen.value!.pages.map((p) => p.name)).toEqual(['Home', 'Play'])
    s.removePage(1)
    expect(find(pageMenu(s, 0, pageUi()), 'Delete page').disabled).toBe(true)
  })

  it('moves a page up and down', async () => {
    const s = await make()
    find(pageMenu(s, 2, pageUi()), 'Move up').run!()
    expect(s.screen.value!.pages.map((p) => p.id)).toEqual(['a', 'c', 'b'])
  })
})

describe('reorderPage', () => {
  it('moves a page to its drop index and keeps the editor on the page it showed', async () => {
    const s = await make()
    s.selectPage(1)
    s.reorderPage(0, 2)
    expect(s.screen.value!.pages.map((p) => p.id)).toEqual(['b', 'c', 'a'])
    expect(s.page.value!.id).toBe('b')
    s.reorderPage(2, 0)
    expect(s.screen.value!.pages.map((p) => p.id)).toEqual(['a', 'b', 'c'])
    s.undo()
    expect(s.screen.value!.pages.map((p) => p.id)).toEqual(['b', 'c', 'a'])
  })

  it('ignores a drop where it started or out of range', async () => {
    const s = await make()
    s.reorderPage(1, 1)
    s.reorderPage(0, 9)
    expect(s.canUndo.value).toBe(false)
  })
})

describe('dropIndex', () => {
  const rows = [0, 1, 2, 3].map((i) => ({ top: i * 30, height: 30 }))
  it('counts the other rows whose middle is above the pointer', () => {
    expect(dropIndex(rows, 5, 2)).toBe(0)
    expect(dropIndex(rows, 50, 0)).toBe(1)
    expect(dropIndex(rows, 80, 0)).toBe(2)
    expect(dropIndex(rows, 200, 0)).toBe(3)
    expect(dropIndex(rows, 40, 3)).toBe(1)
  })
  it('leaves a page where it is while the pointer stays on its own row', () => {
    expect(dropIndex(rows, 70, 2)).toBe(2)
  })
})

describe('copyPageToScreen', () => {
  it('copies the page as new widgets laid out for the other screen, background included', async () => {
    const s = await make()
    s.copyPageToScreen(0, 'pad')
    const pad = s.state.config!.screens[1]
    expect(pad.pages).toHaveLength(2)
    const copy = pad.pages[1]
    expect(copy).toMatchObject({ name: 'Home', background: { image: 'dunes.webp' } })
    // Its own id on that screen: the iPad already has a page `a`.
    expect(copy.id).not.toBe('a')
    expect(copy.items).toHaveLength(1)
    const id = copy.items[0].instanceId
    expect(id).not.toBe('clock-1')
    expect(s.state.config!.widgets[id]).toMatchObject({ widgetId: 'clock', settings: { tz: 'UTC' } })
    // The huge widget does not fit a 20-column grid: no orphan is left behind for it.
    expect(Object.values(s.state.config!.widgets).filter((w) => w.widgetId === 'huge')).toHaveLength(1)
    expect(s.state.toast).toMatch(/left out/)
    // The editor stays where it was.
    expect(s.screen.value!.id).toBe('edge')
  })
})

describe('navWidgetMenu', () => {
  it('moves within its side, and removes from the bar or deletes on its last place', async () => {
    const s = await make()
    const menu = navWidgetMenu(s, 'clock-bar', pageUi())
    expect(labels(menu)).toEqual(['Settings…', 'Move left', 'Move right', 'Delete everywhere'])
    expect(find(menu, 'Move left').disabled).toBe(true)
    find(menu, 'Move right').run!()
    expect(s.screen.value!.nav.map((x) => x.instanceId)).toEqual(['clock-bar2', 'clock-bar'])
    find(find(navWidgetMenu(s, 'clock-bar', pageUi()), 'Delete everywhere').children!, 'Delete').run!()
    expect(s.screen.value!.nav.map((x) => x.instanceId)).toEqual(['clock-bar2'])
    expect(s.state.config!.widgets['clock-bar']).toBeUndefined()
  })

  it('opens its settings in the settings window', async () => {
    const s = await make()
    const u = pageUi()
    find(navWidgetMenu(s, 'clock-bar2', u), 'Settings').run!()
    expect(s.state.modal).toBe('settings')
    expect(navSettingsOpen).toContain('clock-bar2')
    expect(u.revealSection).toHaveBeenCalledWith('screen.navWidgets')
  })
})

/** Only what libraryMenu reads of the marketplace, plus spies on what it calls. */
function market(widgets: Partial<MarketplaceWidget>[] = []) {
  const state = { widgets, kind: 'theme', view: 'available', search: '' }
  return {
    state,
    setView: vi.fn((v: string) => { state.view = v }),
    start: vi.fn(async () => {}),
    uninstall: vi.fn(async () => {}),
  } as unknown as MarketplaceStore & { start: ReturnType<typeof vi.fn>; uninstall: ReturnType<typeof vi.fn> }
}

describe('navBarMenu', () => {
  it('adds a page, and opens the Screen panel on the bar widgets or the bar settings', async () => {
    const s = await make()
    const ui = { revealSection: vi.fn(), focusLibrarySearch: vi.fn() }
    const menu = navBarMenu(s, ui)
    const labels = menu.filter((e): e is MenuItem => !isSeparator(e)).map((e) => e.label)
    expect(labels).toEqual(['New page', 'Add a widget to the bar…', 'Navigation bar settings…'])
    const pages = s.screen.value!.pages.length
    ;(menu[0] as MenuItem).run!()
    expect(s.screen.value!.pages).toHaveLength(pages + 1)
    ;(menu[1] as MenuItem).run!()
    expect(s.state.modal).toBe('settings')
    expect(ui.revealSection).toHaveBeenLastCalledWith('screen.navWidgets')
    ;(menu[3] as MenuItem).run!()
    expect(ui.revealSection).toHaveBeenLastCalledWith('screen.layout')
  })
})

describe('libraryMenu', () => {
  it('adds to a chosen page, and to the bar only for a compact widget', async () => {
    const s = await make()
    const menu = libraryMenu(s, market(), 'clock')
    expect(labels(menu)).toEqual(['Add to page', 'Add to the bar'])
    find(find(menu, 'Add to page').children!, 'Play').run!()
    expect(s.state.pageIndex).toBe(2)
    expect(s.page.value!.items).toHaveLength(1)
    expect(labels(libraryMenu(s, market(), 'plain'))).toEqual(['Add to page'])
    find(libraryMenu(s, market(), 'clock'), 'Add to the bar').run!()
    expect(s.screen.value!.nav).toHaveLength(3)
  })

  it('offers the Sietch, an update and an uninstall for a registry widget', async () => {
    const s = await make({ plain: 'installed' })
    const m = market([{ id: 'plain', version: '2.0.0', updateAvailable: true }])
    const menu = libraryMenu(s, m, 'plain')
    expect(labels(menu)).toEqual(['Add to page', 'Show in the Sietch', 'Update to 2.0.0', 'Uninstall'])
    find(menu, 'Show in the Sietch').run!()
    expect(s.state.modal).toBe('marketplace')
    expect(m.state).toMatchObject({ kind: 'widget', view: 'installed', search: 'plain' })
    find(menu, 'Update to').run!()
    expect(m.start).toHaveBeenCalledWith(expect.objectContaining({ id: 'plain' }), true)
    expect(m.state.view).toBe('updates')
    const uninstall = find(menu, 'Uninstall')
    expect(uninstall.danger).toBe(true)
    find(uninstall.children!, 'Uninstall “Plain”').run!()
    expect(m.uninstall).toHaveBeenCalledWith('plain')
  })
})

describe('screenMenu', () => {
  it('renames, opens the settings of that screen and deletes it with its own widgets counted', async () => {
    const s = await make()
    const rename = vi.fn()
    const menu = screenMenu(s, 'pad', { rename }, ['Kitchen iPad'])
    expect(labels(menu)).toEqual(['Rename', 'Screen settings…', 'Reload the dashboard', 'Export screen…', 'Export the whole setup…', 'Import a layout…', 'Delete this screen'])
    find(menu, 'Rename').run!()
    expect(rename).toHaveBeenCalledWith('pad')
    find(menu, 'Screen settings').run!()
    expect(s.screen.value!.id).toBe('pad')
    expect(s.state.modal).toBe('settings')
    const confirm = find(menu, 'Delete this screen').children!
    expect(labels(confirm)).toEqual(['Leaves without a screen: Kitchen iPad', 'Delete “iPad” and its 1 own widget(s)'])
    expect(find(confirm, 'Leaves').disabled).toBe(true)
    find(confirm, 'Delete “iPad”').run!()
    expect(s.state.config!.screens.map((x) => x.id)).toEqual(['edge'])
    expect(find(screenMenu(s, 'edge', { rename }), 'Delete this screen').disabled).toBe(true)
  })

  it('exports that screen, or the whole setup', async () => {
    const s = await make()
    find(screenMenu(s, 'pad', { rename: vi.fn() }), 'Export screen').run!()
    expect(share.exporting).toEqual({ scope: 'screen', screen: 'pad' })
    find(screenMenu(s, 'pad', { rename: vi.fn() }), 'Export the whole setup').run!()
    expect(share.exporting).toEqual({ scope: 'setup' })
    expect(s.state.modal).toBe('export')
  })
})
