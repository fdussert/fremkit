/**
 * @vitest-environment jsdom
 *
 * The library's "already on your other screens" section, rendered: it lists what another screen
 * shows, a click places that same widget here, and it disappears once nothing is left to offer.
 *
 * The store is a module singleton built against the real `api`, so its state is seeded directly
 * and the save it schedules is answered by a stubbed fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import WidgetLibrary from '../src/admin/WidgetLibrary.vue'
import { useAdminStore } from '../src/admin/store'
import { useMarketplaceStore } from '../src/admin/marketplace'
import type { Config, WidgetManifest } from '../src/shared/types'

const manifest = (id: string, name: string): WidgetManifest => ({
  id, name: { fr: name, en: name }, version: '1.0.0', sdk: 1,
  description: { fr: '', en: '' }, icon: 'clock',
  minSize: [4, 2], defaultSize: [8, 4],
  subscriptions: [], commands: [], settingsSchema: {}, permissions: { network: [] },
})

/** `clock-1` on both screens, `cpu-1` on the Edge only. */
function config(): Config {
  return {
    version: 4,
    connections: [], secrets: { backend: 'file' }, locale: 'en',
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    widgets: {
      'clock-1': { widgetId: 'clock', showTitle: true, settings: {} },
      'cpu-1': { widgetId: 'cpu', showTitle: true, settings: {} },
    },
    screens: [
      {
        id: 'edge', name: 'Edge', kind: 'edge',
        display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 },
        nav: [],
        pages: [{ id: 'home', name: 'Home', items: [
          { instanceId: 'clock-1', x: 0, y: 0, w: 8, h: 4 },
          { instanceId: 'cpu-1', x: 8, y: 0, w: 8, h: 4 },
        ] }],
      },
      {
        id: 'tablet', name: 'Tablet', kind: 'device',
        display: { cols: 34, rows: 23, cell: 40, autoCycleSeconds: 0, viewport: { width: 1376, height: 1032 } },
        nav: [],
        pages: [{ id: 'main', name: 'Main', items: [{ instanceId: 'clock-1', x: 0, y: 0, w: 8, h: 4 }] }],
      },
    ],
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
    new Response(init?.body ?? '{}', { headers: { 'content-type': 'application/json' } })))
  const market = useMarketplaceStore()
  market.state.widgets = []
  vi.spyOn(market, 'load').mockResolvedValue(undefined as never)
  const s = useAdminStore()
  s.state.config = config()
  s.state.manifests = { clock: manifest('clock', 'Clock'), cpu: manifest('cpu', 'CPU') }
  s.selectScreen('tablet')
})

afterEach(async () => {
  const s = useAdminStore()
  await s.flush()
  s.state.config = null
  s.state.manifests = {}
  s.select(null)
  vi.unstubAllGlobals()
})

describe('the widget library', () => {
  it('offers Fremplay only while labs.companion is on', async () => {
    const s = useAdminStore()
    s.state.manifests = { ...s.state.manifests, fremplay: manifest('fremplay', 'Fremplay') }
    s.selectScreen('edge')
    const wrapper = mount(WidgetLibrary, { attachTo: document.body })
    expect(wrapper.text()).not.toContain('Fremplay')
    s.state.config = { ...s.state.config!, labs: { devices: false, companion: true } }
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Fremplay')
    wrapper.unmount()
  })

  it('offers the widgets of other screens and places one on click', async () => {
    const s = useAdminStore()
    const wrapper = mount(WidgetLibrary, { attachTo: document.body })
    const card = wrapper.findAll('.existing')
    expect(card).toHaveLength(1)
    expect(card[0].text()).toContain('CPU')
    expect(wrapper.text()).toContain('Already on your other screens')

    await card[0].trigger('click')
    expect(s.screen.value!.pages[0].items.map((p) => p.instanceId)).toEqual(['clock-1', 'cpu-1'])
    expect(s.state.config!.widgets['cpu-1']).toBeDefined()
    expect(wrapper.find('.existing').exists()).toBe(false)
    wrapper.unmount()
  })

  it('hides the section when there is nothing to offer', () => {
    const s = useAdminStore()
    s.selectScreen('edge')
    const wrapper = mount(WidgetLibrary, { attachTo: document.body })
    expect(wrapper.find('.existing').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Already on your other screens')
    wrapper.unmount()
  })
})
