/**
 * @vitest-environment jsdom
 *
 * Adding a screen, rendered: the selector lists the screens and opens the dialog, which adds an
 * Edge screen, or a device screen at a paired device's size; a pre-fill goes through a preview
 * that names what is left out, and nothing is saved before Accept.
 *
 * The store is a module singleton built against the real `api`, so its state is seeded directly
 * and the save it schedules is answered by a stubbed fetch. Page drawings are stubbed: they would
 * load every widget in an iframe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AddScreenDialog from '../src/admin/AddScreenDialog.vue'
import ScreenSelector from '../src/admin/ScreenSelector.vue'
import { useAdminStore } from '../src/admin/store'
import type { Config, WidgetManifest } from '../src/shared/types'

const manifest = (id: string, name: string, minSize: [number, number]): WidgetManifest => ({
  id, name: { fr: name, en: name }, version: '1.0.0', sdk: 1,
  description: { fr: '', en: '' }, icon: 'clock',
  minSize, defaultSize: minSize,
  subscriptions: [], commands: [], settingsSchema: {}, permissions: { network: [] },
})

/** The Edge with a clock and a banner too wide for any iPad (40 columns at the least). */
function config(): Config {
  return {
    version: 4,
    connections: [], secrets: { backend: 'file' }, locale: 'en',
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    widgets: {
      'clock-1': { widgetId: 'clock', showTitle: true, settings: {} },
      'banner-1': { widgetId: 'banner', showTitle: true, settings: {} },
    },
    screens: [{
      id: 'edge', name: 'Edge', kind: 'edge',
      display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 },
      nav: [],
      pages: [{ id: 'home', name: 'Home', items: [
        { instanceId: 'clock-1', x: 0, y: 0, w: 8, h: 4 },
        { instanceId: 'banner-1', x: 8, y: 0, w: 48, h: 4 },
      ] }],
    }],
  }
}

const stubs = { PageView: { template: '<div class="page-stub" />' } }

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
    new Response(init?.body ?? '{}', { headers: { 'content-type': 'application/json' } })))
  const s = useAdminStore()
  s.state.config = config()
  s.state.manifests = { clock: manifest('clock', 'Clock', [4, 2]), banner: manifest('banner', 'Banner', [40, 4]) }
  s.selectScreen('edge')
})

afterEach(async () => {
  const s = useAdminStore()
  await s.flush()
  s.state.config = null
  s.state.manifests = {}
  vi.unstubAllGlobals()
})

const button = (wrapper: ReturnType<typeof mount>, text: string) =>
  wrapper.findAll('button').find((b) => b.text() === text)!

/** A paired iPad Pro 13" in landscape, as it reports itself. */
const ipad = { id: 'dev-1', name: 'Kitchen iPad', viewport: { width: 1376, height: 1032 } }

describe('the add-screen dialog', () => {
  it('adds an Edge screen when no device is given: no kind, no size to choose', async () => {
    const s = useAdminStore()
    const wrapper = mount(AddScreenDialog, { attachTo: document.body, global: { stubs } })
    // The one select left is the pre-fill: no kind choice, no preset, no width or height.
    expect(wrapper.findAll('select')).toHaveLength(1)
    expect(wrapper.find('[role="radiogroup"]').exists()).toBe(false)
    expect(wrapper.findAll('input[type="number"]')).toHaveLength(0)
    const add = vi.spyOn(s, 'addScreen')
    await wrapper.find('input').setValue('Second Edge')
    await button(wrapper, 'Add').trigger('click')
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ name: 'Second Edge', kind: 'edge' }))
    expect(s.state.config!.screens[1]).toMatchObject({ name: 'Second Edge', kind: 'edge' })
    expect(wrapper.emitted('created')).toEqual([['second-edge']])
    add.mockRestore()
    wrapper.unmount()
  })

  it('adds a device screen at the device’s size, named after it, and says which one it made', async () => {
    const s = useAdminStore()
    const wrapper = mount(AddScreenDialog, { props: { device: ipad }, attachTo: document.body, global: { stubs } })
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('Kitchen iPad')
    // Shown, not edited.
    expect(wrapper.find('[data-test="device-size"]').text()).toBe('1376 × 1032 px')
    expect(wrapper.findAll('input[type="number"]')).toHaveLength(0)
    expect(wrapper.text()).toContain('Grid: 34 × 24 cells under a 40 px bar.')
    const add = vi.spyOn(s, 'addScreen')
    await button(wrapper, 'Add').trigger('click')
    expect(add).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'device', viewport: { width: 1376, height: 1032 }, orientation: 'landscape',
    }))
    const added = s.state.config!.screens[1]
    expect(added).toMatchObject({ name: 'Kitchen iPad', kind: 'device', display: { viewport: { width: 1376, height: 1032 } } })
    expect(wrapper.emitted('created')).toEqual([[added.id]])
    expect(wrapper.emitted('close')).toHaveLength(1)
    add.mockRestore()
    wrapper.unmount()
  })

  it('previews a pre-fill, names what is left out, and saves only on Accept', async () => {
    const s = useAdminStore()
    const wrapper = mount(AddScreenDialog, { props: { device: ipad }, attachTo: document.body, global: { stubs } })
    await wrapper.find('input').setValue('Kitchen')
    await wrapper.find('select').setValue('edge')
    await button(wrapper, 'Preview…').trigger('click')

    expect(s.state.config!.screens).toHaveLength(1)
    // Under the 40 px bar a device screen starts with: the preview counts the rows addScreen will.
    expect(wrapper.text()).toContain('1 page(s), on a 34 × 24 grid.')
    expect(wrapper.text()).toContain('The look (background, opacities, rotation, admin gesture) is copied from Edge.')
    expect(wrapper.find('[data-test="left-out"]').text()).toContain('Left out, for lack of room: Banner.')
    expect(wrapper.findAll('.page-stub')).toHaveLength(1)

    await button(wrapper, 'Accept').trigger('click')
    const added = s.state.config!.screens[1]
    expect(added).toMatchObject({ id: 'kitchen', name: 'Kitchen', kind: 'device', display: { cols: 34, rows: 24, navHeight: 40, orientation: 'landscape' } })
    expect(added.pages[0].items).toEqual([{ instanceId: 'clock-1', x: 0, y: 0, w: 8, h: 4 }])
    expect(s.state.screenId).toBe('kitchen')
    expect(wrapper.emitted('created')).toEqual([['kitchen']])
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })

  it('pre-fills an Edge screen too', async () => {
    const s = useAdminStore()
    const wrapper = mount(AddScreenDialog, { attachTo: document.body, global: { stubs } })
    await wrapper.find('select').setValue('edge')
    await button(wrapper, 'Preview…').trigger('click')
    expect(wrapper.find('[data-test="left-out"]').exists()).toBe(false)
    await button(wrapper, 'Accept').trigger('click')
    expect(s.state.config!.screens[1].kind).toBe('edge')
    expect(s.state.config!.screens[1].pages[0].items).toHaveLength(2)
    wrapper.unmount()
  })
})

describe('the screen selector', () => {
  it('is a segmented control up to three screens and a menu beyond', async () => {
    const s = useAdminStore()
    const wrapper = mount(ScreenSelector, { attachTo: document.body, global: { stubs } })
    expect(wrapper.findAll('[role="tab"]').map((b) => b.text())).toEqual(['Edge'])
    expect(wrapper.text()).toContain('+ Add a screen')
    for (const name of ['A', 'B', 'C']) s.addScreen({ name, kind: 'edge', prefill: null })
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(0)
    await wrapper.find('.trigger').trigger('click')
    expect(wrapper.findAll('[role="option"]').map((o) => o.text())).toEqual(['Edge', 'A', 'B', 'C'])
    await wrapper.findAll('[role="option"] button')[0].trigger('click')
    expect(s.state.screenId).toBe('edge')
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
