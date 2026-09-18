/**
 * @vitest-environment jsdom
 *
 * "Widgets for this connection", under the connection form.
 *
 * A connection is credentials for a provider and shows nothing on a screen by itself; the widget
 * that does now lives on the registry for every product-specific one. Somebody who has just
 * typed a Homey token has no reason to know that, so this asserts they are told where it is —
 * and that the list is filtered by the connection actually in front of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ConnectionWidgets from '../src/admin/ConnectionWidgets.vue'
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
    shadowsBuiltin: false, placedOn: [],
    ...over,
  }
}

function seed(widgets: MarketplaceWidget[]): void {
  const m = useMarketplaceStore()
  m.state.widgets = widgets
  m.state.loaded = true
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no request expected') }))
})

afterEach(() => {
  const m = useMarketplaceStore()
  m.state.widgets = []
  m.state.loaded = false
  m.state.busy = null
  m.state.consent = null
  vi.unstubAllGlobals()
})

describe('the widgets a connection feeds', () => {
  it('lists only the ones that name this connection type', () => {
    seed([
      widget({ id: 'homey-devices' }),
      widget({ id: 'homey-flows' }),
      widget({ id: 'bambu-job', connections: ['bambu'] }),
      widget({ id: 'clock', connections: [] }),
    ])
    const wrapper = mount(ConnectionWidgets, { props: { type: 'homey' }, attachTo: document.body })
    const ids = wrapper.findAll('.row').map((r) => r.attributes('data-widget'))
    expect(ids).toEqual(['homey-devices', 'homey-flows'])
    wrapper.unmount()
  })

  it('marks an installed one with the dot and offers it no button', () => {
    seed([widget({ id: 'homey-devices', installed: true, installedVersion: '1.1.0' }), widget({ id: 'homey-flows' })])
    const wrapper = mount(ConnectionWidgets, { props: { type: 'homey' }, attachTo: document.body })
    expect(wrapper.find('[data-widget="homey-devices"] .dot.ok').exists()).toBe(true)
    expect(wrapper.find('[data-widget="homey-devices"] button').exists()).toBe(false)
    expect(wrapper.find('[data-widget="homey-flows"] button').exists()).toBe(true)
    wrapper.unmount()
  })

  it('installs from here, with its own consent dialog', async () => {
    seed([widget()])
    const wrapper = mount(ConnectionWidgets, { props: { type: 'homey' }, attachTo: document.body })
    await wrapper.find('[data-widget="homey-devices"] button').trigger('click')
    await wrapper.vm.$nextTick()
    // The marketplace panel is not mounted here, so a prompt it would have rendered is a button
    // that silently does nothing.
    expect(useMarketplaceStore().state.consent?.widget.id).toBe('homey-devices')
    expect(wrapper.text()).toMatch(/homey/)
    wrapper.unmount()
  })

  it('shows nothing at all for a connection no widget names', () => {
    seed([widget({ connections: ['bambu'] })])
    const wrapper = mount(ConnectionWidgets, { props: { type: 'ics' }, attachTo: document.body })
    expect(wrapper.find('.widgets').exists()).toBe(false)
    wrapper.unmount()
  })
})
