/**
 * @vitest-environment jsdom
 *
 * `labs.companion` off is Fremplay off: the dashboard draws no Fremplay, the admin's canvas draws
 * them greyed and labelled. The config keeps them either way.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import PageView from '../src/dashboard/PageView.vue'
import NavBar from '../src/dashboard/NavBar.vue'
import { turnedOff, unavailableInstances, visibleScreen } from '../src/shared/companionGate'
import { setLocale } from '../src/shared/i18n'
import type { Config, Page, Screen, WidgetManifest } from '../src/shared/types'

const widgets = {
  fp: { widgetId: 'fremplay', showTitle: false, settings: {} },
  clock: { widgetId: 'clock', showTitle: false, settings: {} },
}
const cfg = (companion: boolean) => ({ labs: { devices: false, companion }, widgets }) as unknown as Config
const at = (instanceId: string) => ({ instanceId, x: 0, y: 0, w: 4, h: 4 })
const screen = (pages: string[][], nav: string[] = []): Screen => ({
  id: 'edge', name: 'Edge', kind: 'edge',
  display: { cols: 20, rows: 10, cell: 40, autoCycleSeconds: 0 },
  nav: nav.map((instanceId) => ({ instanceId, slot: 'left' })),
  pages: pages.map((ids, i) => ({ id: `p${i}`, name: `P${i}`, items: ids.map(at) })),
})

describe('visibleScreen', () => {
  it('is the screen itself with the switch on', () => {
    const s = screen([['fp'], ['clock']], ['fp'])
    expect(visibleScreen(cfg(true), s)).toBe(s)
    expect(turnedOff(cfg(true)).size).toBe(0)
  })

  it('drops Fremplay tiles and bar items, and the pages that held only Fremplay, never an empty one', () => {
    const s = screen([[], ['fp'], ['clock', 'fp']], ['fp', 'clock'])
    const v = visibleScreen(cfg(false), s)
    expect(v.pages.map((p) => [p.id, p.items.map((i) => i.instanceId)])).toEqual([['p0', []], ['p2', ['clock']]])
    expect(v.nav.map((n) => n.instanceId)).toEqual(['clock'])
    // The config's screen is untouched: turning the switch back on restores everything in place.
    expect(s.pages[1].items).toHaveLength(1)
    expect(s.nav).toHaveLength(2)
  })

  it('keeps the first page, emptied, when every page held only Fremplay', () => {
    const v = visibleScreen(cfg(false), screen([['fp'], ['fp']]))
    expect(v.pages.map((p) => [p.id, p.items.length])).toEqual([['p0', 0]])
  })
})

describe('the admin canvas with Fremplay off', () => {
  const manifest = { id: 'fremplay', name: { fr: 'Fremplay', en: 'Fremplay' } } as unknown as WidgetManifest
  const page: Page = { id: 'p', name: 'P', items: [at('fp')] }
  const display = { cols: 20, rows: 10, cell: 40, autoCycleSeconds: 0 }

  it('draws a placed Fremplay greyed and labelled, with no frame running', () => {
    setLocale('fr')
    const w = mount(PageView, { props: { page, config: cfg(false), display, manifests: { fremplay: manifest }, edit: true, off: turnedOff(cfg(false)) } })
    expect(w.find('.box').classes()).toContain('off')
    expect(w.find('[data-test="feature-off"]').text()).toContain('Fonction désactivée')
    expect(w.find('iframe').exists()).toBe(false)
    w.unmount()
    setLocale('en')
    const en = mount(PageView, { props: { page, config: cfg(false), display, manifests: { fremplay: manifest }, off: turnedOff(cfg(false)) } })
    expect(en.find('[data-test="feature-off"]').text()).toContain('Feature turned off')
    en.unmount()
  })

  it('draws it as usual with the switch on', () => {
    const w = mount(PageView, { props: { page, config: cfg(true), display, manifests: { fremplay: manifest }, off: turnedOff(cfg(true)) } })
    expect(w.find('.box').classes()).not.toContain('off')
    expect(w.find('iframe').exists()).toBe(true)
    w.unmount()
  })

  it('greys a Fremplay in the bar too', () => {
    setLocale('en')
    const w = mount(NavBar, {
      props: {
        pages: [page], active: 0, height: 80, navItems: [{ instanceId: 'fp', slot: 'left' }],
        widgets, manifests: { fremplay: manifest }, edit: true, off: turnedOff(cfg(false)),
      },
    })
    expect(w.find('.compact').classes()).toContain('off')
    expect(w.find('.compact [data-test="feature-off"]').text()).toBe('Feature turned off')
    w.unmount()
  })
})

describe('widgets this platform cannot run', () => {
  const placed = { ...widgets, sp: { widgetId: 'spotify', showTitle: false, settings: {} } }
  const config = { labs: { devices: false, companion: true }, widgets: placed } as unknown as Config

  it('lists the placed instances of an unavailable widget', () => {
    expect([...unavailableInstances(config, ['spotify'])]).toEqual(['sp'])
    expect(unavailableInstances(config, []).size).toBe(0)
    expect(unavailableInstances(null, ['spotify']).size).toBe(0)
  })

  it('greys the tile and mounts no frame, ahead of the feature-off label', () => {
    setLocale('en')
    const page: Page = { id: 'p0', name: 'P0', items: [at('sp')] }
    const display = { cols: 20, rows: 10, cell: 40, autoCycleSeconds: 0 } as Screen['display']
    const manifests = { spotify: { id: 'spotify' } as unknown as WidgetManifest }
    const wrapper = mount(PageView, {
      props: { page, config: config, display, manifests, off: new Set(['sp']), unavailable: new Set(['sp']) },
    })
    expect(wrapper.find('[data-test="not-on-platform"]').text()).toContain('Not available on Windows')
    expect(wrapper.find('[data-test="feature-off"]').exists()).toBe(false)
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.find('.box.off').exists()).toBe(true)
  })

  it('does the same for a bar item', () => {
    setLocale('en')
    const manifests = { spotify: { id: 'spotify', compact: { width: 4 } } as unknown as WidgetManifest }
    const wrapper = mount(NavBar, {
      props: { pages: [{ id: 'p0', name: 'P0', items: [] }], active: 0, height: 60, navItems: [{ instanceId: 'sp', slot: 'left' }],
        widgets: placed, manifests, unavailable: new Set(['sp']) },
    })
    expect(wrapper.find('[data-test="not-on-platform"]').exists()).toBe(true)
    expect(wrapper.find('iframe').exists()).toBe(false)
  })
})
