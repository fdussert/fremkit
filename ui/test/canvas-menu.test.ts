import { describe, expect, it, vi } from 'vitest'
import { createAdminStore } from '../src/admin/store'
import { canvasMenu, connectionOf, selectionMenu, widgetMenu, type MenuUi } from '../src/admin/canvasMenu'
import { setLocale } from '../src/shared/i18n'
import { isSeparator, type MenuEntry, type MenuItem } from '../src/shared/ui/contextMenu'
import type { Config, WidgetManifest } from '../src/shared/types'

const clock: WidgetManifest = {
  id: 'clock', name: 'Clock', version: '1.0.0', sdk: 1, description: '', icon: 'clock',
  minSize: [8, 4], defaultSize: [16, 4], subscriptions: [], commands: [],
  settingsSchema: { tz: { type: 'string', label: 'TZ' } }, permissions: { network: [] },
}
const gh: WidgetManifest = {
  ...clock, id: 'gh', name: 'GitHub',
  settingsSchema: { connection: { type: 'connection', label: 'Account', connectionType: 'github' } },
}

function config(): Config {
  return {
    version: 4, locale: 'en', connections: [], secrets: { backend: 'file' },
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    widgets: {
      'clock-1': { widgetId: 'clock', showTitle: true, settings: {} },
      'gh-1': { widgetId: 'gh', showTitle: false, settings: { connection: 'work' }, opacity: 0.6 },
    },
    screens: [
      {
        id: 'edge', name: 'Edge', kind: 'edge', display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 }, nav: [],
        pages: [
          { id: 'a', name: 'Home', items: [{ instanceId: 'clock-1', x: 0, y: 0, w: 16, h: 4 }, { instanceId: 'gh-1', x: 16, y: 0, w: 16, h: 4 }] },
          { id: 'b', name: 'Work', items: [] },
        ],
      },
      {
        id: 'ipad', name: 'iPad', kind: 'edge', display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 }, nav: [],
        pages: [{ id: 'c', name: 'Main', items: [{ instanceId: 'gh-1', x: 0, y: 0, w: 16, h: 4 }] }],
      },
    ],
  }
}

async function make() {
  setLocale('en')
  const store = createAdminStore({
    api: {
      getConfig: async () => config(), getStatus: async () => ({ degraded: false }),
      getWidgets: async () => ({ widgets: { clock, gh }, errors: [], sources: {}, asks: {}, sdk: 1 }),
      putConfig: async (c) => c, rescan: async () => ({ widgets: {}, errors: [], sources: {}, asks: {}, sdk: 1 }),
    },
    subscribeConfig: () => () => {},
    debounceMs: 0,
  })
  await store.load()
  return store
}
const ui = (): MenuUi => ({ revealSection: vi.fn(), focusLibrarySearch: vi.fn() })
const items = (menu: MenuEntry[]): MenuItem[] => menu.filter((e): e is MenuItem => !isSeparator(e))
const find = (menu: MenuEntry[], label: string): MenuItem => {
  const hit = items(menu).find((e) => e.label === label) ?? items(menu).find((e) => e.label.startsWith(label))
  if (!hit) throw new Error(`no "${label}" in ${items(menu).map((e) => e.label).join(', ')}`)
  return hit
}

describe('widgetMenu', () => {
  it('offers the phase-one commands, with shortcuts', async () => {
    const s = await make()
    const menu = widgetMenu(s, 'clock-1', ui())
    const labels = items(menu).map((e) => e.label)
    expect(labels).toEqual([
      'Show title', 'Appearance', 'Copy style', 'Paste style', 'Duplicate', 'Copy', 'Paste',
      'Move to page', 'Also show on screen', 'Move to screen', 'Size', 'Lock position',
      'About this widget…', 'Reload widget', 'Delete everywhere',
    ])
    expect(find(menu, 'Duplicate').shortcut).toBe('⌘D')
    expect(find(menu, 'Copy').shortcut).toBe('⌘C')
    expect(find(menu, 'Paste').disabled).toBe(true)
    expect(find(menu, 'Paste style').disabled).toBe(true)
    expect(find(menu, 'Show title').checked).toBe(true)
    expect(isSeparator(menu[0])).toBe(false)
    expect(isSeparator(menu[menu.length - 1])).toBe(false)
  })

  it('checks the current opacity and applies a preset', async () => {
    const s = await make()
    const appearance = find(widgetMenu(s, 'gh-1', ui()), 'Appearance').children!
    expect(items(appearance).filter((e) => e.checked).map((e) => e.label)).toEqual(['Opacity 60%'])
    find(appearance, 'Opacity 100%').run!()
    expect(s.state.config!.widgets['gh-1']).not.toHaveProperty('opacity')
    find(appearance, 'Opacity 0%').run!()
    expect(s.state.config!.widgets['gh-1'].opacity).toBe(0)
  })

  it('sends the colour items to their inspector sections', async () => {
    const s = await make()
    const u = ui()
    const appearance = find(widgetMenu(s, 'clock-1', u), 'Appearance').children!
    find(appearance, 'Accent').run!()
    expect(u.revealSection).toHaveBeenCalledWith('widget.accent')
    expect(find(appearance, 'Reset appearance').disabled).toBe(true)
  })

  it('enables paste once something was copied', async () => {
    const s = await make()
    find(widgetMenu(s, 'clock-1', ui()), 'Copy').run!()
    find(widgetMenu(s, 'clock-1', ui()), 'Copy style').run!()
    const menu = widgetMenu(s, 'clock-1', ui())
    expect(find(menu, 'Paste').disabled).toBeFalsy()
    expect(find(menu, 'Paste style').disabled).toBeFalsy()
  })

  it('lists the pages with the current one greyed, and a new page', async () => {
    const s = await make()
    const pages = items(find(widgetMenu(s, 'clock-1', ui()), 'Move to page').children!)
    expect(pages.map((p) => [p.label, !!p.disabled])).toEqual([['Home', true], ['Work', false], ['New page', false]])
    pages[1].run!()
    expect(s.state.config!.screens[0].pages[1].items.map((p) => p.instanceId)).toEqual(['clock-1'])
  })

  it('greys the screens that already show the widget', async () => {
    const s = await make()
    const also = items(find(widgetMenu(s, 'gh-1', ui()), 'Also show on screen').children!)
    expect(also.map((p) => [p.label, !!p.disabled])).toEqual([['iPad', true]])
    const clockAlso = items(find(widgetMenu(s, 'clock-1', ui()), 'Also show on screen').children!)
    expect(clockAlso[0].disabled).toBe(false)
  })

  it('offers the manifest sizes, greyed when they do not fit', async () => {
    const s = await make()
    const sizes = items(find(widgetMenu(s, 'clock-1', ui()), 'Size').children!)
    expect(sizes.map((p) => [p.label, !!p.checked, !!p.disabled])).toEqual([
      ['Default size (16×4)', true, false], ['Minimum size (8×4)', false, false],
    ])
  })

  it('toggles the lock, and greys the sizes of a locked tile', async () => {
    const s = await make()
    find(widgetMenu(s, 'clock-1', ui()), 'Lock position').run!()
    const menu = widgetMenu(s, 'clock-1', ui())
    expect(find(menu, 'Lock position').checked).toBe(true)
    expect(items(find(menu, 'Size').children!).every((e) => e.disabled)).toBe(true)
  })

  it('opens the connection a widget uses', async () => {
    const s = await make()
    find(widgetMenu(s, 'gh-1', ui()), 'Open its connection').run!()
    expect(s.state.modal).toBe('connections')
    expect(s.state.editConnectionId).toBe('work')
  })

  it('removes from this screen when shown elsewhere, and asks through a submenu on the last one', async () => {
    const s = await make()
    const shared = find(widgetMenu(s, 'gh-1', ui()), 'Remove from screen')
    expect(shared.shortcut).toBe('⌫')
    const last = find(widgetMenu(s, 'clock-1', ui()), 'Delete everywhere')
    expect(last.danger).toBe(true)
    expect(last.run).toBeUndefined()
    const confirm = items(last.children!)[0]
    expect(confirm.label).toBe('Delete “Clock”')
    confirm.run!()
    expect(s.state.config!.widgets['clock-1']).toBeUndefined()
  })

  it('has no screen submenus when there is a single screen', async () => {
    const s = await make()
    s.removeScreen('ipad')
    const labels = items(widgetMenu(s, 'clock-1', ui())).map((e) => e.label)
    expect(labels).not.toContain('Also show on screen')
    expect(labels).not.toContain('Move to screen')
  })
})

describe('canvasMenu', () => {
  it('leads "Page background…" to the page inspector, with no widget selected', async () => {
    const s = await make()
    const u = ui()
    s.selectPage(1)
    s.select('clock-1')
    find(canvasMenu(s, u), 'Page background').run!()
    expect(s.state.pageIndex).toBe(1)
    expect(s.state.selectedId).toBeNull()
    expect(u.revealSection).toHaveBeenCalledWith('page.background')
  })
  it('pastes, adds, makes a page and opens the screen settings', async () => {
    const s = await make()
    const u = ui()
    const menu = canvasMenu(s, u)
    expect(items(menu).map((e) => e.label)).toEqual(['Paste', 'Select all', 'Add a widget…', 'New page', 'Page background…', 'Screen settings…', 'Reload the dashboard'])
    expect(find(menu, 'Paste').disabled).toBe(true)
    expect(find(menu, 'Select all').shortcut).toBe('⌘A')
    find(menu, 'Select all').run!()
    expect(s.state.selection).toEqual(['clock-1', 'gh-1'])
    find(menu, 'Add a widget').run!()
    expect(u.focusLibrarySearch).toHaveBeenCalled()
    find(menu, 'Screen settings').run!()
    expect(s.state.modal).toBe('settings')
  })
})

describe('selectionMenu', () => {
  const sub = (menu: MenuEntry[], label: string): MenuEntry[] => find(menu, label).children!

  it('offers what makes sense for several tiles, each command one undo step', async () => {
    const s = await make()
    const both = ['clock-1', 'gh-1']
    expect(selectionMenu(s, ['clock-1'])).toEqual([])
    const menu = selectionMenu(s, both)
    expect(items(menu).map((e) => e.label)).toEqual([
      'Show title', 'Appearance', 'Duplicate', 'Copy', 'Paste', 'Move to page', 'Lock position', 'Remove 2 widgets',
    ])
    // gh-1 shows no title: the check is off until all do, and the command turns it on for all.
    expect(find(menu, 'Show title').checked).toBe(false)
    find(menu, 'Show title').run!()
    expect(s.state.config!.widgets['gh-1'].showTitle).toBe(true)
    expect(s.state.config!.widgets['clock-1'].showTitle).toBe(true)
    s.undo()
    expect(s.state.config!.widgets['gh-1'].showTitle).toBe(false)

    // Different opacities: no preset is checked; one sets both.
    const presets = items(sub(menu, 'Appearance'))
    expect(presets.filter((e) => e.checked)).toEqual([])
    find(sub(menu, 'Appearance'), 'Opacity 40%').run!()
    expect(s.state.config!.widgets['clock-1'].opacity).toBe(0.4)
    expect(s.state.config!.widgets['gh-1'].opacity).toBe(0.4)

    find(menu, 'Lock position').run!()
    expect(s.page.value!.items.every((p) => p.locked)).toBe(true)
    expect(find(selectionMenu(s, both), 'Lock position').checked).toBe(true)
  })

  it('confirms in a submenu when the removal deletes a widget, and is one undo step', async () => {
    const s = await make()
    const menu = selectionMenu(s, ['clock-1', 'gh-1'])
    // gh-1 is also on the iPad, clock-1 only here.
    const confirm = items(sub(menu, 'Remove 2 widgets'))
    expect(confirm).toHaveLength(1)
    confirm[0].run!()
    expect(s.page.value!.items).toEqual([])
    expect(s.state.config!.widgets['clock-1']).toBeUndefined()
    expect(s.state.config!.widgets['gh-1']).toBeDefined()
    s.undo()
    expect(s.page.value!.items.map((p) => p.instanceId)).toEqual(['clock-1', 'gh-1'])
  })

  it('moves the group to another page', async () => {
    const s = await make()
    s.selectMany(['clock-1', 'gh-1'])
    find(sub(selectionMenu(s, ['clock-1', 'gh-1']), 'Move to page'), 'Work').run!()
    expect(s.state.pageIndex).toBe(1)
    expect(s.page.value!.items.map((p) => p.instanceId)).toEqual(['clock-1', 'gh-1'])
    expect(s.state.selection).toEqual(['clock-1', 'gh-1'])
  })
})

describe('connectionOf', () => {
  it('reads the connection id, or the type to create one', () => {
    expect(connectionOf(gh, { widgetId: 'gh', showTitle: true, settings: { connection: 'x' } })).toEqual({ id: 'x' })
    expect(connectionOf(gh, { widgetId: 'gh', showTitle: true, settings: {} })).toEqual({ type: 'github' })
    expect(connectionOf(clock, { widgetId: 'clock', showTitle: true, settings: {} })).toBeNull()
  })
})
