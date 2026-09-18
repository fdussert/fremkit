/**
 * @vitest-environment jsdom
 *
 * The update badge has to be right *before* anybody looks at Browse.
 *
 * It counts the installed widgets with a newer version waiting, and it sits on the tab nobody is
 * on — so a badge that only appeared once you had opened the tab was a badge that never told you
 * anything. The index is therefore read when the column mounts, which is a fact about the
 * component and not about the store, so the component is mounted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import WidgetLibrary from '../src/admin/WidgetLibrary.vue'
import type { MarketplaceResponse, MarketplaceWidget } from '../src/shared/types'

function widget(over: Partial<MarketplaceWidget> = {}): MarketplaceWidget {
  return {
    id: 'demo', version: '2.0.0', sdk: 1,
    name: { fr: 'Démo', en: 'Demo' }, description: { fr: 'Un widget', en: 'A widget' },
    icon: 'layout-grid',
    permissions: { subscriptions: [], commands: [], network: [] },
    connections: [], size: 2048, publishedAt: '2026-09-18T12:00:00.000Z',
    installed: true, installedVersion: '1.0.0', updateAvailable: true,
    sdkTooNew: false, consentNeeded: false,
    newPermissions: { subscriptions: [], commands: [], network: [] },
    shadowsBuiltin: false,
    ...over,
  }
}

const answer = (widgets: MarketplaceWidget[], over: Partial<MarketplaceResponse> = {}): MarketplaceResponse =>
  ({ registry: 'fremkit-sietch', generatedAt: '2026-09-18T12:00:00.000Z', widgets, offline: false, sdk: 1, ...over })

/** Only `/api/marketplace` is answered: mounting the column on its own asks for nothing else. */
function serve(body: MarketplaceResponse): { calls: string[] } {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url)
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  }))
  return { calls }
}

/** The store is a module singleton; one fresh module registry per test keeps them apart. */
beforeEach(() => { vi.resetModules() })
afterEach(() => { vi.unstubAllGlobals() })

/**
 * Lets the mount's `load()` settle. `Response.json()` crosses a macrotask on some Node versions
 * (it did on the CI runner and not on the machine that wrote this), so a fixed number of
 * microtask turns is not a wait — a real timer turn is.
 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

const tabLabels = (wrapper: ReturnType<typeof mount>): string[] =>
  wrapper.findAll('.seg button').map((b) => b.text())

describe('the Browse tab badge', () => {
  it('counts the waiting updates without the tab ever being opened', async () => {
    const { calls } = serve(answer([widget()]))
    const wrapper = mount(WidgetLibrary, { attachTo: document.body })
    await settle()
    await wrapper.vm.$nextTick()

    expect(calls).toContain('/api/marketplace')
    await vi.waitFor(() => {
      expect(tabLabels(wrapper).some((label) => label.includes('(1)'))).toBe(true)
    })
    // And the local tab is still the one showing.
    expect(wrapper.find('.browse').exists()).toBe(false)
    wrapper.unmount()
  })

  it('carries no count when nothing is waiting', async () => {
    serve(answer([widget({ updateAvailable: false })]))
    const wrapper = mount(WidgetLibrary, { attachTo: document.body })
    await settle()
    await wrapper.vm.$nextTick()
    expect(tabLabels(wrapper).some((label) => label.includes('('))).toBe(false)
    wrapper.unmount()
  })

  it('does not fall over when the registry cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const wrapper = mount(WidgetLibrary, { attachTo: document.body })
    await settle()
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.seg button')).toHaveLength(2)
    wrapper.unmount()
  })
})
