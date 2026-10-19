/**
 * @vitest-environment jsdom
 *
 * The settings window: its search across the panes, the routing of a reveal to the pane that
 * holds the section, the entry points that open it on a given pane, and the window itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { DICTIONARIES, setLocale, translate } from '../src/shared/i18n'
import type { Config } from '../src/shared/types'
import {
  APP_PANES, foldableSections, openSettings, paneOfSection, searchSettings, settingsPane, settingsQuery, SETTINGS_INDEX,
  showSettingsSection,
} from '../src/admin/settingsWindow'
import { editorFocus } from '../src/admin/editorFocus'
import { openHistory } from '../src/admin/history'
import { createAdminStore, useAdminStore } from '../src/admin/store'
import { screenMenu } from '../src/admin/menus'
import { canvasMenu } from '../src/admin/canvasMenu'
import SettingsWindow from '../src/admin/settings/SettingsWindow.vue'

const fr = (key: string): string => translate('fr', key)
const en = (key: string): string => translate('en', key)
const ids = (found: ReturnType<typeof searchSettings>): string[] => [...(found?.values() ?? [])].flatMap((x) => [...x])

function config(): Config {
  return {
    version: 4,
    connections: [], secrets: { backend: 'file' }, locale: 'en',
    labs: { devices: true },
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    widgets: {},
    screens: [
      { id: 'edge', name: 'Edge', kind: 'edge', display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 }, nav: [], pages: [{ id: 'home', name: 'Home', items: [] }] },
      { id: 'desk', name: 'Desk', kind: 'edge', display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 }, nav: [], pages: [{ id: 'home', name: 'Home', items: [] }] },
    ],
  }
}

const makeStore = () => createAdminStore({
  api: {
    getConfig: async () => config(), getStatus: async () => ({ degraded: false }),
    getWidgets: async () => ({ widgets: {}, errors: [], sources: {}, asks: {}, sdk: 1 }),
    putConfig: async (c) => c, rescan: async () => ({ widgets: {}, errors: [], sources: {}, asks: {}, sdk: 1 }),
  },
  subscribeConfig: () => () => {},
  debounceMs: 0,
})

beforeEach(() => {
  settingsPane.value = 'screen'
  settingsQuery.value = ''
})

describe('the settings index', () => {
  it('names only keys both languages have', () => {
    const keys = SETTINGS_INDEX.flatMap((e) => [...(e.title ? [e.title] : []), ...e.labels])
    for (const key of keys) {
      expect(DICTIONARIES.fr[key], key).toBeTruthy()
      expect(DICTIONARIES.en[key], key).toBeTruthy()
    }
    for (const pane of ['screen', ...APP_PANES.map((p) => p.id)]) {
      expect(DICTIONARIES.fr[`admin.settings.pane.${pane}`]).toBeTruthy()
      expect(DICTIONARIES.en[`admin.settings.pane.${pane}`]).toBeTruthy()
    }
  })

  it('gives every app pane at least one block, and no id twice', () => {
    for (const p of APP_PANES) expect(SETTINGS_INDEX.some((e) => e.pane === p.id), p.id).toBe(true)
    const all = SETTINGS_INDEX.map((e) => e.id)
    expect(new Set(all).size).toBe(all.length)
  })

  it('folds only the panes that have several sections', () => {
    expect(foldableSections('screen')).toEqual(['screen.layout', 'screen.navWidgets', 'screen.background', 'screen.brightness', 'screen.kiosk'])
    expect(foldableSections('history')).toEqual(['screen.history', 'screen.backup'])
    expect(foldableSections('privacy')).toEqual([])
    expect(foldableSections('general')).toEqual([])
  })
})

describe('searchSettings', () => {
  it('finds nothing to filter for an empty query', () => {
    expect(searchSettings('', fr)).toBeNull()
    expect(searchSettings('   ', fr)).toBeNull()
  })

  it('finds a field label, accents ignored', () => {
    expect(ids(searchSettings('opacité', fr))).toEqual(['screen.layout'])
    expect(ids(searchSettings('opacite', fr))).toEqual(['screen.layout'])
  })

  it('finds a section title in either language', () => {
    expect(ids(searchSettings('kiosque', fr))).toEqual(['screen.kiosk'])
    expect(ids(searchSettings('kiosk', en))).toEqual(['screen.kiosk'])
    expect(ids(searchSettings('backup', en))).toContain('screen.backup')
    expect(ids(searchSettings('sauvegarde', fr))).toContain('screen.backup')
  })

  it('files what it finds under its pane, in the sidebar order', () => {
    const found = searchSettings('theme', en)!
    expect([...found.keys()]).toEqual(['appearance'])
    expect([...searchSettings('privacy', en)!.keys()]).toEqual(['privacy'])
  })

  it('wants every word typed, and says when nothing matches', () => {
    expect(ids(searchSettings('bar opacity', en))).toEqual(['screen.layout'])
    expect(searchSettings('zzz-nothing', en)!.size).toBe(0)
  })

  it('does not match the placeholders in a label', () => {
    expect(ids(searchSettings('percent', en))).toEqual([])
  })
})

describe('routing a reveal to its pane', () => {
  it('knows the pane of every settings section and of no other', () => {
    expect(paneOfSection('screen.layout')).toBe('screen')
    expect(paneOfSection('screen.navWidgets')).toBe('screen')
    expect(paneOfSection('screen.brightness')).toBe('screen')
    expect(paneOfSection('screen.share')).toBe('share')
    expect(paneOfSection('screen.history')).toBe('history')
    expect(paneOfSection('screen.backup')).toBe('history')
    expect(paneOfSection('screen.privacy')).toBe('privacy')
    expect(paneOfSection('screen.devices')).toBe('devices')
    expect(paneOfSection('screen.about')).toBe('about')
    expect(paneOfSection('widget.settings')).toBeNull()
    expect(paneOfSection('page.background')).toBeNull()
  })

  it('switches the pane and clears a search that could hide the section', () => {
    settingsPane.value = 'privacy'
    settingsQuery.value = 'kiosk'
    expect(showSettingsSection('screen.about')).toBe(true)
    expect(settingsPane.value).toBe('about')
    expect(settingsQuery.value).toBe('')
  })

  it('leaves the window alone for an inspector section', () => {
    settingsPane.value = 'privacy'
    editorFocus.revealSection('widget.accent')
    expect(settingsPane.value).toBe('privacy')
  })

  it('goes through editorFocus, which the menus and the palette call', () => {
    editorFocus.revealSection('screen.navWidgets')
    expect(settingsPane.value).toBe('screen')
    editorFocus.revealSection('screen.about')
    expect(settingsPane.value).toBe('about')
  })
})

describe('opening the settings window', () => {
  it('reopens where it was left, or on the pane asked for', () => {
    const s = makeStore()
    settingsPane.value = 'privacy'
    openSettings(s)
    expect(s.state.modal).toBe('settings')
    expect(settingsPane.value).toBe('privacy')
    openSettings(s, 'screen')
    expect(settingsPane.value).toBe('screen')
  })

  it('opens on the history from the top bar button', () => {
    const s = makeStore()
    openHistory(s)
    expect(s.state.modal).toBe('settings')
    expect(settingsPane.value).toBe('history')
  })

  it('opens on the screen pane from a screen menu and the canvas menu', () => {
    const s = makeStore()
    s.state.config = config()
    settingsPane.value = 'about'
    const item = screenMenu(s, 'desk', { rename: vi.fn() }).find((e) => 'label' in e && e.label.startsWith('Réglages'))
    ;(item as { run: () => void }).run()
    expect(s.screen.value!.id).toBe('desk')
    expect(settingsPane.value).toBe('screen')
    settingsPane.value = 'about'
    const canvas = canvasMenu(s, { revealSection: vi.fn(), focusLibrarySearch: vi.fn() })
    ;(canvas.find((e) => 'label' in e && e.label.startsWith('Réglages')) as { run: () => void }).run()
    expect(settingsPane.value).toBe('screen')
  })
})

describe('SettingsWindow', () => {
  const stubs = { DevicesSection: true, HistorySection: true, DiagnosticsSection: true, NavWidgetsEditor: true, BackgroundPicker: true, ScreenBrightness: true }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"themes":{},"errors":[]}', { headers: { 'content-type': 'application/json' } })))
    setLocale('en')
    const s = useAdminStore()
    s.state.config = config()
    s.state.manifests = {}
    s.selectScreen('edge')
  })
  afterEach(async () => {
    const s = useAdminStore()
    await s.flush()
    s.state.config = null
    setLocale(undefined)
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('lists every screen, then the app panes, and switches screen and pane', async () => {
    const wrapper = mount(SettingsWindow, { attachTo: document.body, global: { stubs } })
    const entries = wrapper.findAll('nav button').map((b) => b.text())
    expect(entries).toEqual(['Edge', 'Desk', 'General', 'Appearance', 'Share', 'History & backup', 'Privacy', 'Devices', 'About'])
    expect(wrapper.find('h3').text()).toBe('Edge')
    expect(wrapper.find('[data-section="screen.layout"]').exists()).toBe(true)
    // Several sections: the fold buttons are there.
    expect(wrapper.find('button[title="Expand all"]').exists()).toBe(true)

    await wrapper.findAll('nav button')[1].trigger('click')
    expect(useAdminStore().screen.value!.id).toBe('desk')
    expect(wrapper.find('h3').text()).toBe('Desk')

    await wrapper.findAll('nav button').find((b) => b.text() === 'Privacy')!.trigger('click')
    expect(wrapper.find('h3').text()).toBe('Privacy')
    // One section, shown bare: nothing to fold.
    expect(wrapper.find('button[title="Expand all"]').exists()).toBe(false)
    expect(wrapper.find('[data-section="screen.privacy"]').element.tagName).toBe('DIV')
    wrapper.unmount()
  })

  it('shows only what a search found, opened, and Escape clears it', async () => {
    const wrapper = mount(SettingsWindow, { attachTo: document.body, global: { stubs } })
    const input = wrapper.find('nav input')
    await input.setValue('kiosk')
    await flushPromises()
    expect(wrapper.find('h3').text()).toBe('Search results')
    const shown = wrapper.findAll('[data-section]').map((el) => el.attributes('data-section'))
    expect(shown).toEqual(['screen.kiosk'])
    expect((wrapper.find('[data-section="screen.kiosk"]').element as HTMLDetailsElement).open).toBe(true)

    await input.setValue('opacity backup zzz')
    expect(wrapper.text()).toContain('No setting matches this search.')

    await input.trigger('keydown', { key: 'Escape' })
    expect(settingsQuery.value).toBe('')
    expect(wrapper.find('h3').text()).toBe('Edge')
    wrapper.unmount()
  })
})
