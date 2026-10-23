/**
 * @vitest-environment jsdom
 *
 * A widget this platform cannot run is drawn as a notice, never as a frame, wherever the
 * dashboard draws a widget: the bar's popover, the bar item and the AddScreen preview's page.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import NavPopover from '../src/dashboard/NavPopover.vue'
import CompactWidgetFrame from '../src/dashboard/CompactWidgetFrame.vue'
import { setLocale } from '../src/shared/i18n'
import type { NavItem, WidgetManifest } from '../src/shared/types'

const manifest = { id: 'spotify', name: { fr: 'Spotify', en: 'Spotify' }, compact: { width: 4 } } as unknown as WidgetManifest
const widgets = { sp: { widgetId: 'spotify', showTitle: false, settings: {} } }
const item: NavItem = { instanceId: 'sp', slot: 'left' }

describe('NavPopover', () => {
  const props = { item, widgets, manifest, cell: 40, anchor: { left: 10, width: 40, top: 10 }, screen: { width: 800, height: 400 } }

  it('mounts no frame for an unavailable widget and says so', () => {
    setLocale('en')
    const w = mount(NavPopover, { props: { ...props, unavailable: true } })
    expect(w.find('iframe').exists()).toBe(false)
    expect(w.find('[data-test="not-on-platform"]').text()).toBe('Not available on Windows')
    w.unmount()
  })

  it('still mounts it otherwise', () => {
    const w = mount(NavPopover, { props })
    expect(w.find('iframe').exists()).toBe(true)
    expect(w.find('[data-test="not-on-platform"]').exists()).toBe(false)
    w.unmount()
  })
})

describe('CompactWidgetFrame', () => {
  it('greys an unavailable widget, labelled, with no frame, even when also off', () => {
    setLocale('en')
    const w = mount(CompactWidgetFrame, { props: { item, widgets, manifest, cell: 40, height: 60, off: true, unavailable: true } })
    expect(w.find('.compact').classes()).toContain('off')
    expect(w.find('[data-test="not-on-platform"]').exists()).toBe(true)
    expect(w.find('[data-test="feature-off"]').exists()).toBe(false)
    expect(w.find('iframe').exists()).toBe(false)
    w.unmount()
  })
})
