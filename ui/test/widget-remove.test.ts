/**
 * @vitest-environment jsdom
 *
 * Remove versus delete, rendered. A widget shown on another screen is only taken off this one —
 * one press, no question, and the inspector says where else it is. On its last screen the same
 * button deletes the widget, so it asks first and names it.
 *
 * The store is a module singleton built against the real `api`, so its state is seeded directly
 * and the save it schedules is answered by a stubbed fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import WidgetInspector from '../src/admin/WidgetInspector.vue'
import NavWidgetsEditor from '../src/admin/NavWidgetsEditor.vue'
import { useAdminStore } from '../src/admin/store'
import { widgetDelete } from '../src/admin/widgetDelete'
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
  const s = useAdminStore()
  s.state.config = config()
  s.state.manifests = { clock: manifest('clock', 'Clock'), cpu: manifest('cpu', 'CPU') }
  s.selectScreen('edge')
})

afterEach(async () => {
  const s = useAdminStore()
  await s.flush()
  widgetDelete.reset()
  s.state.config = null
  s.state.manifests = {}
  s.select(null)
  vi.unstubAllGlobals()
})

const buttons = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('.actions button')

describe('the widget inspector', () => {
  it('only removes a shared widget from this screen, and says where else it is', async () => {
    const s = useAdminStore()
    s.select('clock-1')
    const wrapper = mount(WidgetInspector, { attachTo: document.body })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.hint.shared').text()).toContain('Also shown on: Tablet')
    const remove = buttons(wrapper).find((b) => b.text() === 'Remove from this screen')!
    expect(buttons(wrapper).some((b) => b.text().includes('Delete'))).toBe(false)
    await remove.trigger('click')
    expect(s.state.config!.screens[0].pages[0].items.map((p) => p.instanceId)).toEqual(['cpu-1'])
    expect(s.state.config!.widgets['clock-1']).toBeDefined()
    wrapper.unmount()
  })

  it('asks by name before deleting a widget on its last screen', async () => {
    const s = useAdminStore()
    s.select('cpu-1')
    const wrapper = mount(WidgetInspector, { attachTo: document.body })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.hint.shared').exists()).toBe(false)
    await buttons(wrapper).find((b) => b.text() === 'Delete the widget')!.trigger('click')
    // Armed, not done: the button and the hint both name it.
    expect(s.state.config!.widgets['cpu-1']).toBeDefined()
    expect(buttons(wrapper).some((b) => b.text() === 'Delete “CPU”?')).toBe(true)
    expect(wrapper.find('.hint.bad').text()).toContain('“CPU” is on no other screen')
    await buttons(wrapper).find((b) => b.text() === 'Delete “CPU”?')!.trigger('click')
    expect(s.state.config!.widgets['cpu-1']).toBeUndefined()
    wrapper.unmount()
  })
})

describe('the bar editor', () => {
  it('names the widget on screen, not in a tooltip, before deleting it from its last screen', async () => {
    const s = useAdminStore()
    // `cpu-1` moves from the Edge's page to the Edge's bar: still on no other screen.
    const edge = s.state.config!.screens[0]
    edge.pages[0].items = edge.pages[0].items.filter((p) => p.instanceId !== 'cpu-1')
    edge.nav = [{ instanceId: 'cpu-1', slot: 'left' }]
    const wrapper = mount(NavWidgetsEditor, { attachTo: document.body })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.hint.bad').exists()).toBe(false)
    await wrapper.find('button[title="Delete the widget"]').trigger('click')
    // Armed, not done: the question naming it is text in the row, readable without hovering.
    expect(s.state.config!.widgets['cpu-1']).toBeDefined()
    expect(wrapper.find('.hint.bad').text()).toBe('Delete “CPU”?')
    await wrapper.findAll('button').find((b) => b.text() === 'Confirm?')!.trigger('click')
    expect(s.state.config!.widgets['cpu-1']).toBeUndefined()
    expect(wrapper.find('.hint.bad').exists()).toBe(false)
    wrapper.unmount()
  })
})
