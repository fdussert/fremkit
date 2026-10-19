import { describe, expect, it } from 'vitest'
import { createAdminStore } from '../src/admin/store'
import { setLocale } from '../src/shared/i18n'
import type { Config, Screen, WidgetManifest } from '../src/shared/types'

/**
 * Taking a widget off one screen while another still shows it: the editor says where it still
 * is and offers to go there, rather than leaving the user to wonder why it is still counted.
 */
const clock: WidgetManifest = {
  id: 'clock', name: 'Clock', version: '1.0.0', sdk: 1, description: '', icon: 'clock',
  minSize: [8, 4], defaultSize: [8, 4], subscriptions: [], commands: [],
  settingsSchema: {}, permissions: { network: [] }, compact: { width: 3 },
}

const screen = (id: string, name: string, extra: Partial<Screen> = {}): Screen => ({
  id, name, kind: 'edge', display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 }, nav: [],
  pages: [{ id: 'home', name: 'Home', items: [] }], ...extra,
})

function config(): Config {
  return {
    version: 4, locale: 'en', connections: [], secrets: { backend: 'file' },
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    widgets: {
      shared: { widgetId: 'clock', showTitle: true, settings: {}, title: 'Docker' },
      barred: { widgetId: 'clock', showTitle: true, settings: {} },
      alone: { widgetId: 'clock', showTitle: true, settings: {} },
    },
    screens: [
      screen('edge', 'Edge', {
        pages: [{ id: 'home', name: 'Home', items: [
          { instanceId: 'shared', x: 0, y: 0, w: 8, h: 4 },
          { instanceId: 'barred', x: 8, y: 0, w: 8, h: 4 },
          { instanceId: 'alone', x: 16, y: 0, w: 8, h: 4 },
        ] }],
      }),
      screen('pad', 'iPad', {
        nav: [{ instanceId: 'barred', slot: 'left' }],
        pages: [
          { id: 'one', name: 'One', items: [] },
          { id: 'two', name: 'Two', items: [{ instanceId: 'shared', x: 0, y: 6, w: 8, h: 4 }] },
        ],
      }),
    ],
  }
}

async function make() {
  setLocale('en')
  const store = createAdminStore({
    api: {
      getConfig: async () => config(), getStatus: async () => ({ degraded: false }),
      getWidgets: async () => ({ widgets: { clock }, errors: [], sources: {}, asks: {}, sdk: 1 }),
      putConfig: async (c) => c, rescan: async () => ({ widgets: {}, errors: [], sources: {}, asks: {}, sdk: 1 }),
    },
    subscribeConfig: () => () => {},
    debounceMs: 0,
  })
  await store.load()
  store.selectScreen('edge')
  return store
}

describe('a widget taken off a screen another one still shows', () => {
  it('says where it still is, by its page there', async () => {
    const s = await make()
    s.removeFromScreen('shared')
    expect(s.state.notice).toMatchObject({ name: 'Docker', count: 1, screenName: 'iPad', pageIndex: 1, pageName: 'Two' })
    expect(s.state.config!.widgets.shared).toBeDefined()
  })

  it('names the other screen\'s bar when that is where it is', async () => {
    const s = await make()
    s.removeFromScreen('barred')
    expect(s.state.notice).toMatchObject({ screenName: 'iPad', pageIndex: null, pageName: null })
  })

  it('says nothing when that was its last place', async () => {
    const s = await make()
    s.removeFromScreen('alone')
    expect(s.state.notice).toBeNull()
    expect(s.state.config!.widgets.alone).toBeUndefined()
  })

  it('counts a group, and leads to the first one still shown', async () => {
    const s = await make()
    s.removeTiles(['shared', 'barred', 'alone'])
    expect(s.state.notice).toMatchObject({ count: 2, instanceId: 'shared' })
  })

  it('goes there: that screen, that page, the widget selected', async () => {
    const s = await make()
    s.removeFromScreen('shared')
    s.goToNotice()
    expect(s.screen.value!.id).toBe('pad')
    expect(s.state.pageIndex).toBe(1)
    expect(s.state.selectedId).toBe('shared')
    expect(s.state.notice).toBeNull()
  })
})
