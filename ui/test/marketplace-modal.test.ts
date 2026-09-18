/**
 * @vitest-environment jsdom
 *
 * The registry is a modal now, and the count has to be right before anybody opens it.
 *
 * This was `widget-library-browse.test.ts`, asserting the same property about the Browse tab in
 * the widget column: the index is read when the column mounts, so the badge is right on the
 * first paint. The tab is gone — a shop does not belong in the palette used on every visit — so
 * that coverage moved to the top bar's entry, and the column's side of it is now the chip that
 * opens the modal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import WidgetLibrary from '../src/admin/WidgetLibrary.vue'
import TopBar from '../src/admin/TopBar.vue'
import { useAdminStore } from '../src/admin/store'
import { useMarketplaceStore } from '../src/admin/marketplace'
import type { Config, MarketplaceResponse, MarketplaceWidget, WidgetManifest } from '../src/shared/types'

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

/** Only `/api/marketplace` is answered: mounting these two on their own asks for nothing else. */
function serve(body: MarketplaceResponse): { calls: string[] } {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url)
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  }))
  return { calls }
}

const MANIFEST: WidgetManifest = {
  id: 'demo', name: { fr: 'Démo', en: 'Demo' }, version: '1.0.0', sdk: 1,
  description: { fr: 'Un widget', en: 'A widget' }, icon: 'layout-grid',
  minSize: [8, 4], defaultSize: [8, 4], subscriptions: [], commands: [],
  settingsSchema: {}, permissions: { network: [] },
}

function config(): Config {
  return {
    version: 2,
    display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 },
    connections: [], secrets: { backend: 'file' }, locale: 'en',
    privacy: { claudeAccountUsage: false }, marketplace: { installed: {} },
    pages: [{ id: 'home', name: 'Home', widgets: [] }],
  } as unknown as Config
}

/**
 * Both stores are module singletons, and the modules are imported statically here — so
 * `vi.resetModules()` would not give a test a fresh one. They are emptied by hand instead,
 * which is honest about what is shared.
 */
function reset(): void {
  const s = useAdminStore()
  s.state.manifests = {}
  s.state.sources = {}
  s.state.asks = {}
  s.state.config = null
  s.closeModal()
  const m = useMarketplaceStore()
  m.state.widgets = []
  m.state.loaded = false
  m.state.loading = false
  m.state.offline = false
  m.state.error = ''
  m.state.search = ''
  m.state.results = {}
  m.setView('available')
}

beforeEach(reset)
afterEach(() => { reset(); vi.unstubAllGlobals() })

/**
 * Lets the mount's `load()` settle. `Response.json()` crosses a macrotask on some Node versions
 * (it did on the CI runner and not on the machine that wrote this), so a fixed number of
 * microtask turns is not a wait — a real timer turn is.
 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('the widget column', () => {
  it('reads the index when it mounts, without being the thing that shows it', async () => {
    const { calls } = serve(answer([widget()]))
    const wrapper = mount(WidgetLibrary, { attachTo: document.body })
    await settle()
    await wrapper.vm.$nextTick()
    expect(calls).toContain('/api/marketplace')
    // No tab, no segmented control: the palette is a palette again.
    expect(wrapper.findAll('.seg button')).toHaveLength(0)
    wrapper.unmount()
  })

  it('marks an installed widget with a dot and its version', async () => {
    serve(answer([]))
    const s = useAdminStore()
    s.state.config = config()
    s.state.manifests = { demo: MANIFEST }
    s.state.sources = { demo: 'installed' }
    const wrapper = mount(WidgetLibrary, { attachTo: document.body })
    await settle()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.dot.ok').exists()).toBe(true)
    expect(wrapper.text()).toContain('v1.0.0')
    wrapper.unmount()
  })

  it('offers a chip that opens the modal on the Updates view', async () => {
    serve(answer([widget()]))
    const s = useAdminStore()
    s.state.config = config()
    s.state.manifests = { demo: MANIFEST }
    s.state.sources = { demo: 'installed' }
    const wrapper = mount(WidgetLibrary, { attachTo: document.body })
    await settle()
    await wrapper.vm.$nextTick()

    const chip = wrapper.find('.chip.up')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('2.0.0')
    await chip.trigger('click')
    expect(useAdminStore().state.modal).toBe('marketplace')
    expect(useMarketplaceStore().state.view).toBe('updates')
    wrapper.unmount()
  })

  it('shows neither dot nor chip for a built-in', async () => {
    serve(answer([widget({ updateAvailable: false })]))
    const s = useAdminStore()
    s.state.config = config()
    s.state.manifests = { demo: MANIFEST }
    s.state.sources = { demo: 'builtin' }
    const wrapper = mount(WidgetLibrary, { attachTo: document.body })
    await settle()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.chip.up').exists()).toBe(false)
    expect(wrapper.find('.dot.ok').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('the top bar entry', () => {
  /** The badge reads the store the column filled, so the column is what mounts first. */
  async function withIndex(widgets: MarketplaceWidget[]): Promise<ReturnType<typeof mount>> {
    serve(answer(widgets))
    const s = useAdminStore()
    s.state.config = config()
    const column = mount(WidgetLibrary, { attachTo: document.body })
    await settle()
    column.unmount()
    const bar = mount(TopBar, { attachTo: document.body })
    await bar.vm.$nextTick()
    return bar
  }

  const sietch = (bar: ReturnType<typeof mount>) =>
    bar.findAll('button.panel').find((b) => b.text().includes('Sietch'))

  it('carries the count of what is waiting', async () => {
    const bar = await withIndex([widget({ id: 'a' }), widget({ id: 'b' }), widget({ id: 'c', updateAvailable: false })])
    const entry = sietch(bar)
    expect(entry).toBeTruthy()
    expect(entry!.text()).toContain('2')
    bar.unmount()
  })

  it('carries no badge when nothing is waiting', async () => {
    const bar = await withIndex([widget({ updateAvailable: false })])
    expect(sietch(bar)!.find('.chip').exists()).toBe(false)
    bar.unmount()
  })

  it('opens the modal', async () => {
    const bar = await withIndex([])
    await sietch(bar)!.trigger('click')
    expect(useAdminStore().state.modal).toBe('marketplace')
    bar.unmount()
  })

  it('is there when the registry cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const s = useAdminStore()
    s.state.config = config()
    const column = mount(WidgetLibrary, { attachTo: document.body })
    await settle()
    column.unmount()
    const bar = mount(TopBar, { attachTo: document.body })
    await bar.vm.$nextTick()
    expect(sietch(bar)).toBeTruthy()
    bar.unmount()
  })
})
