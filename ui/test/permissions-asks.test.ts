/**
 * @vitest-environment jsdom
 *
 * "Asked for, not granted", rendered.
 *
 * `notGranted()` has its own unit tests, and they passed while the display was dead code: the
 * two components that show permissions never bound `asks`, so the function was always handed
 * `undefined` and always answered "nothing missing". The only test that catches that is one that
 * mounts the components and looks in the DOM.
 *
 * The store is a module singleton built against the real `api`, so its state is seeded directly
 * rather than loaded — what is under test is what the template does with the state, not how the
 * state arrives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import WidgetPermissions from '../src/admin/WidgetPermissions.vue'
import WidgetLibrary from '../src/admin/WidgetLibrary.vue'
import WidgetInspector from '../src/admin/WidgetInspector.vue'
import { useAdminStore } from '../src/admin/store'
import type { Config, WidgetManifest, WidgetPermissionSet } from '../src/shared/types'

/** What the widget may do: the manifest as the server narrowed it to the consent record. */
const GRANTED: WidgetManifest = {
  id: 'nas', name: { fr: 'NAS', en: 'NAS' }, version: '1.1.0', sdk: 1,
  description: { fr: 'Le NAS', en: 'The NAS' }, icon: 'hard-drive',
  minSize: [8, 4], defaultSize: [8, 4],
  subscriptions: ['synology:*'], commands: [], settingsSchema: {},
  permissions: { network: [] },
}

/** What its manifest asks for: an update landed and wants two more things. */
const ASKS: WidgetPermissionSet = {
  subscriptions: ['synology:*', 'system'],
  commands: ['shortcuts'],
  network: [],
}

function config(): Config {
  return {
    version: 3,
    display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 },
    connections: [], secrets: { backend: 'file' }, locale: 'en',
    privacy: { claudeAccountUsage: false },
    marketplace: { installed: {} },
    pages: [{
      id: 'home', name: 'Home',
      widgets: [{ instanceId: 'nas-1', widgetId: 'nas', x: 0, y: 0, w: 8, h: 4, showTitle: true, settings: {} }],
    }],
  } as unknown as Config
}

/** Nothing is loaded here, but the column reads the registry on mount. */
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ registry: 'fremkit-sietch', generatedAt: '2026-09-18T12:00:00.000Z', widgets: [], offline: false, sdk: 1 }),
    { headers: { 'content-type': 'application/json' } },
  )))
  const s = useAdminStore()
  s.state.config = config()
  s.state.manifests = { nas: GRANTED }
  s.state.sources = { nas: 'installed' }
  s.state.asks = { nas: ASKS }
  s.state.catalogErrors = []
  s.select(null)
})

afterEach(() => {
  const s = useAdminStore()
  s.state.manifests = {}
  s.state.asks = {}
  s.state.sources = {}
  s.state.config = null
  s.select(null)
  vi.unstubAllGlobals()
})

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

describe('WidgetPermissions', () => {
  it('lists what was asked for and refused, apart from what was granted', () => {
    const wrapper = mount(WidgetPermissions, { props: { manifest: GRANTED, asks: ASKS } })
    const denied = wrapper.findAll('.group.denied')
    expect(denied).toHaveLength(2)
    const text = denied.map((g) => g.text()).join(' ')
    expect(text).toContain('system')
    expect(text).toContain('shortcuts')
    // And what *was* granted is not in that section.
    expect(wrapper.find('.group:not(.denied)').text()).toContain('synology')
    wrapper.unmount()
  })

  it('says nothing about a built-in, which has no ask to differ from', () => {
    const wrapper = mount(WidgetPermissions, { props: { manifest: GRANTED } })
    expect(wrapper.findAll('.group.denied')).toHaveLength(0)
    wrapper.unmount()
  })

  it('marks the compact line too, so a library card shows it without being opened', () => {
    const wrapper = mount(WidgetPermissions, { props: { manifest: GRANTED, asks: ASKS, compact: true } })
    expect(wrapper.find('.bit.denied').exists()).toBe(true)
    expect(wrapper.find('.bit.denied').text()).toMatch(/2/)
    wrapper.unmount()
  })

  it('leaves the compact line alone when the ask and the grant agree', () => {
    const asks: WidgetPermissionSet = { subscriptions: ['synology:*'], commands: [], network: [] }
    const wrapper = mount(WidgetPermissions, { props: { manifest: GRANTED, asks, compact: true } })
    expect(wrapper.find('.bit.denied').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('the library card', () => {
  it('binds the widget\'s ask, so the refused permissions reach the DOM', async () => {
    // The binding was missing and every unit test still passed: `notGranted()` was handed
    // `undefined` and answered "nothing missing", every time.
    const wrapper = mount(WidgetLibrary, { attachTo: document.body })
    await settle()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.bit.denied').exists()).toBe(true)
    wrapper.unmount()
  })

  it('shows no such mark for a built-in', async () => {
    const s = useAdminStore()
    s.state.sources = { nas: 'builtin' }
    s.state.asks = {}
    const wrapper = mount(WidgetLibrary, { attachTo: document.body })
    await settle()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.bit.denied').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('the widget inspector', () => {
  it('binds the ask of the selected instance', async () => {
    const s = useAdminStore()
    s.select('nas-1')
    const wrapper = mount(WidgetInspector, { attachTo: document.body })
    await wrapper.vm.$nextTick()
    const denied = wrapper.findAll('.group.denied')
    expect(denied.length).toBeGreaterThan(0)
    expect(denied.map((g) => g.text()).join(' ')).toContain('system')
    wrapper.unmount()
  })
})
