/**
 * @vitest-environment jsdom
 *
 * `labs.fremdev` off is Fremdev off: the dashboard draws no Fremdev, the admin's canvas draws them
 * greyed and labelled. The config keeps them either way. Fremplay is always on and never gated.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import PageView from '../src/dashboard/PageView.vue'
import NavBar from '../src/dashboard/NavBar.vue'
import { turnedOff, visibleScreen } from '../src/shared/fremdevGate'
import { setLocale } from '../src/shared/i18n'
import type { Config, Page, Screen, WidgetManifest } from '../src/shared/types'

const widgets = {
  fd: { widgetId: 'fremdev', showTitle: false, settings: {} },
  fp: { widgetId: 'fremplay', showTitle: false, settings: {} },
  clock: { widgetId: 'clock', showTitle: false, settings: {} },
}
const cfg = (fremdev: boolean) => ({ labs: { fremdev }, widgets }) as unknown as Config
const at = (instanceId: string) => ({ instanceId, x: 0, y: 0, w: 4, h: 4 })
const screen = (pages: string[][], nav: string[] = []): Screen => ({
  id: 'edge', name: 'Edge', kind: 'edge',
  display: { cols: 20, rows: 10, cell: 40, autoCycleSeconds: 0 },
  nav: nav.map((instanceId) => ({ instanceId, slot: 'left' })),
  pages: pages.map((ids, i) => ({ id: `p${i}`, name: `P${i}`, items: ids.map(at) })),
})

describe('visibleScreen', () => {
  it('is the screen itself with the switch on', () => {
    const s = screen([['fd'], ['clock']], ['fd'])
    expect(visibleScreen(cfg(true), s)).toBe(s)
    expect(turnedOff(cfg(true)).size).toBe(0)
  })

  it('drops Fremdev tiles and bar items, and the pages that held only Fremdev, never an empty one', () => {
    const s = screen([[], ['fd'], ['clock', 'fd']], ['fd', 'clock'])
    const v = visibleScreen(cfg(false), s)
    expect(v.pages.map((p) => [p.id, p.items.map((i) => i.instanceId)])).toEqual([['p0', []], ['p2', ['clock']]])
    expect(v.nav.map((n) => n.instanceId)).toEqual(['clock'])
    // The config's screen is untouched: turning the switch back on restores everything in place.
    expect(s.pages[1].items).toHaveLength(1)
    expect(s.nav).toHaveLength(2)
  })

  it('never touches Fremplay, whatever a 0.5.0 config said about labs.companion', () => {
    const s = screen([['fp'], ['clock']], ['fp'])
    expect(visibleScreen(cfg(true), s)).toBe(s)
    const old = { labs: { companion: false, fremdev: true }, widgets } as unknown as Config
    expect(visibleScreen(old, s)).toBe(s)
    // Fremdev off: only Fremdev goes.
    const both = screen([['fp', 'fd'], ['fd']], ['fp', 'fd'])
    const v = visibleScreen(cfg(false), both)
    expect(v.pages.map((p) => p.items.map((i) => i.instanceId))).toEqual([['fp']])
    expect(v.nav.map((n) => n.instanceId)).toEqual(['fp'])
    expect([...turnedOff(cfg(false))]).toEqual(['fd'])
  })

  it('keeps the first page, emptied, when every page held only Fremdev', () => {
    const v = visibleScreen(cfg(false), screen([['fd'], ['fd']]))
    expect(v.pages.map((p) => [p.id, p.items.length])).toEqual([['p0', 0]])
  })
})

describe('the admin canvas with Fremdev off', () => {
  const manifest = { id: 'fremdev', name: { fr: 'Fremdev', en: 'Fremdev' } } as unknown as WidgetManifest
  const page: Page = { id: 'p', name: 'P', items: [at('fd')] }
  const display = { cols: 20, rows: 10, cell: 40, autoCycleSeconds: 0 }

  it('draws a placed Fremdev greyed and labelled, with no frame running', () => {
    setLocale('fr')
    const w = mount(PageView, { props: { page, config: cfg(false), display, manifests: { fremdev: manifest }, edit: true, off: turnedOff(cfg(false)) } })
    expect(w.find('.box').classes()).toContain('off')
    expect(w.find('[data-test="feature-off"]').text()).toContain('Fonction désactivée')
    expect(w.find('iframe').exists()).toBe(false)
    w.unmount()
    setLocale('en')
    const en = mount(PageView, { props: { page, config: cfg(false), display, manifests: { fremdev: manifest }, off: turnedOff(cfg(false)) } })
    expect(en.find('[data-test="feature-off"]').text()).toContain('Feature turned off')
    en.unmount()
  })

  it('draws it as usual with the switch on', () => {
    const w = mount(PageView, { props: { page, config: cfg(true), display, manifests: { fremdev: manifest }, off: turnedOff(cfg(true)) } })
    expect(w.find('.box').classes()).not.toContain('off')
    expect(w.find('iframe').exists()).toBe(true)
    w.unmount()
  })

  it('greys a Fremdev in the bar too', () => {
    setLocale('en')
    const w = mount(NavBar, {
      props: {
        pages: [page], active: 0, height: 80, navItems: [{ instanceId: 'fd', slot: 'left' }],
        widgets, manifests: { fremdev: manifest }, edit: true, off: turnedOff(cfg(false)),
      },
    })
    expect(w.find('.compact').classes()).toContain('off')
    expect(w.find('.compact [data-test="feature-off"]').text()).toBe('Feature turned off')
    w.unmount()
  })
})

describe('the widget lists with Fremdev off', () => {
  const manifests = {
    fremdev: { id: 'fremdev', name: { fr: 'Fremdev', en: 'Fremdev' } },
    fremplay: { id: 'fremplay', name: { fr: 'Fremplay', en: 'Fremplay' } },
    clock: { id: 'clock', name: { fr: 'Horloge', en: 'Clock' } },
  } as unknown as Record<string, WidgetManifest>

  it('leave Fremdev out until its switch is on, and always offer Fremplay', async () => {
    const { offeredManifests, widgetOffered } = await import('../src/admin/labs')
    expect(offeredManifests(cfg(false), manifests).map((m) => m.id).sort()).toEqual(['clock', 'fremplay'])
    expect(offeredManifests(cfg(true), manifests).map((m) => m.id).sort()).toEqual(['clock', 'fremdev', 'fremplay'])
    expect(widgetOffered(null, 'fremdev')).toBe(false)
    expect(widgetOffered(null, 'fremplay')).toBe(true)
  })
})
