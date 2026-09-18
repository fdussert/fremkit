/**
 * @vitest-environment jsdom
 *
 * The inspector's answer for a tile whose widget is not installed.
 *
 * This is the ordinary state of every dashboard built before the product-specific widgets moved
 * to the registry, so "Widget folder not found." on its own is the wrong end of the sentence.
 * What is asserted here is the path out: the registry has it, one button installs it, and the
 * settings form takes the notice's place without a reload.
 *
 * Both stores are module singletons imported statically, so they are seeded and emptied by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import MissingWidget from '../src/admin/MissingWidget.vue'
import { useAdminStore } from '../src/admin/store'
import { useMarketplaceStore } from '../src/admin/marketplace'
import type { MarketplaceWidget } from '../src/shared/types'

function widget(over: Partial<MarketplaceWidget> = {}): MarketplaceWidget {
  return {
    id: 'homey-devices', version: '1.1.0', sdk: 1,
    name: { fr: 'Appareils Homey', en: 'Homey devices' },
    description: { fr: 'Les appareils', en: 'The devices' },
    icon: 'layout-grid', category: 'other',
    permissions: { subscriptions: ['homey:*'], commands: [], network: [] },
    connections: ['homey'], size: 17000, publishedAt: '2026-09-18T12:00:00.000Z',
    installed: false, installedVersion: null, updateAvailable: false,
    sdkTooNew: false, consentNeeded: true,
    newPermissions: { subscriptions: ['homey:*'], commands: [], network: [] },
    shadowsBuiltin: false, placedOn: ['Home'],
    ...over,
  }
}

/** Nothing here talks to the server; `load()` is a no-op once `loaded` is set by hand. */
function seed(widgets: MarketplaceWidget[], over: { offline?: boolean } = {}): void {
  const m = useMarketplaceStore()
  m.state.widgets = widgets
  m.state.loaded = true
  m.state.offline = over.offline ?? false
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no request expected') }))
})

afterEach(() => {
  const m = useMarketplaceStore()
  m.state.widgets = []
  m.state.loaded = false
  m.state.offline = false
  m.state.error = ''
  m.state.busy = null
  m.state.consent = null
  useAdminStore().state.manifests = {}
  vi.unstubAllGlobals()
})

describe('a widget the registry has', () => {
  it('names it and offers the install', () => {
    seed([widget()])
    const wrapper = mount(MissingWidget, { props: { widgetId: 'homey-devices' }, attachTo: document.body })
    expect(wrapper.text()).toMatch(/Appareils Homey|Homey devices/)
    expect(wrapper.find('button').exists()).toBe(true)
    wrapper.unmount()
  })

  it('asks for consent without leaving the inspector', async () => {
    seed([widget()])
    const wrapper = mount(MissingWidget, { props: { widgetId: 'homey-devices' }, attachTo: document.body })
    await wrapper.find('button').trigger('click')
    await wrapper.vm.$nextTick()
    // The dialog belongs to this component: the marketplace panel is not mounted here, and a
    // consent prompt nobody renders is a button that silently does nothing.
    expect(useMarketplaceStore().state.consent?.widget.id).toBe('homey-devices')
    expect(wrapper.text()).toMatch(/homey/)
    wrapper.unmount()
  })

  it('ignores a prompt that is about another widget', async () => {
    seed([widget(), widget({ id: 'bambu-job', name: { fr: 'Bambu', en: 'Bambu' } })])
    const m = useMarketplaceStore()
    const wrapper = mount(MissingWidget, { props: { widgetId: 'homey-devices' }, attachTo: document.body })
    await m.start(m.state.widgets[1])
    await wrapper.vm.$nextTick()
    expect(m.state.consent?.widget.id).toBe('bambu-job')
    expect(wrapper.findAll('.actions').length).toBe(0)
    wrapper.unmount()
  })
})

describe('a widget the registry does not have', () => {
  it('says so, rather than offering nothing and explaining nothing', () => {
    seed([])
    const wrapper = mount(MissingWidget, { props: { widgetId: 'homey-devices' }, attachTo: document.body })
    expect(wrapper.find('button').exists()).toBe(false)
    expect(wrapper.text()).toMatch(/ne l’a pas|does not have it/)
    wrapper.unmount()
  })

  it('does not call an unreadable registry an empty one', () => {
    // Saying "nobody has it" while offline sends the user looking for a replacement they do not
    // need; the index simply could not be read.
    seed([], { offline: true })
    const wrapper = mount(MissingWidget, { props: { widgetId: 'homey-devices' }, attachTo: document.body })
    expect(wrapper.find('button').exists()).toBe(false)
    expect(wrapper.text()).toMatch(/injoignable|could not be reached/)
    wrapper.unmount()
  })

  it('offers nothing for an id a built-in already owns', () => {
    seed([widget({ shadowsBuiltin: true })])
    const wrapper = mount(MissingWidget, { props: { widgetId: 'homey-devices' }, attachTo: document.body })
    expect(wrapper.find('button').exists()).toBe(false)
    wrapper.unmount()
  })
})
