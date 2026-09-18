/**
 * @vitest-environment jsdom
 *
 * A tile whose widget is not installed.
 *
 * It happens to every dashboard built before a widget moved to the registry, and it used to be a
 * grey block with a raw id on it — which reads as a bug rather than as something to act on. The
 * id stays, because it is what the admin's inspector is searched by, but the block says what is
 * actually wrong.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import WidgetFrame from '../src/dashboard/WidgetFrame.vue'
import CompactWidgetFrame from '../src/dashboard/CompactWidgetFrame.vue'
import type { NavWidget, WidgetInstance, WidgetManifest } from '../src/shared/types'

const instance: WidgetInstance = {
  instanceId: 'w-1', widgetId: 'homey-devices', x: 0, y: 0, w: 8, h: 4, showTitle: false, settings: {},
}
const navWidget: NavWidget = { instanceId: 'n-1', widgetId: 'homey-devices', slot: 'left', settings: {} }

const MANIFEST: WidgetManifest = {
  id: 'homey-devices', name: { fr: 'Appareils Homey', en: 'Homey devices' }, version: '1.0.0', sdk: 1,
  minSize: [8, 4], defaultSize: [8, 4], subscriptions: [], commands: [],
  settingsSchema: {}, permissions: { network: [] },
} as unknown as WidgetManifest

describe('a tile with no widget behind it', () => {
  it('says it is not installed, and still names it', () => {
    const wrapper = mount(WidgetFrame, { props: { instance, cell: 40 } })
    const missing = wrapper.find('.missing')
    expect(missing.exists()).toBe(true)
    expect(missing.text()).toMatch(/non installé|not installed/)
    // The id is what the admin's inspector is found by, so it stays on the tile.
    expect(missing.text()).toContain('homey-devices')
    wrapper.unmount()
  })

  it('says nothing of the sort once the widget is there', () => {
    const wrapper = mount(WidgetFrame, { props: { instance, manifest: MANIFEST, cell: 40 } })
    expect(wrapper.find('.missing').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('a bar slot with no widget behind it', () => {
  it('spends its one line on the words rather than on the id', () => {
    const wrapper = mount(CompactWidgetFrame, { props: { navWidget, cell: 40, height: 80 } })
    const missing = wrapper.find('.missing')
    expect(missing.text()).toMatch(/non installé|not installed/)
    expect(missing.text()).not.toContain('homey-devices')
    wrapper.unmount()
  })
})
