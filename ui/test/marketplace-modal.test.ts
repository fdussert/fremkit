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
import MarketplacePanel from '../src/admin/MarketplacePanel.vue'
import UpdateAllDialog from '../src/admin/UpdateAllDialog.vue'
import TopBar from '../src/admin/TopBar.vue'
import { useAdminStore } from '../src/admin/store'
import { useMarketplaceStore } from '../src/admin/marketplace'
import type { Config, MarketplaceResponse, MarketplaceTheme, MarketplaceWidget, WidgetManifest } from '../src/shared/types'

function widget(over: Partial<MarketplaceWidget> = {}): MarketplaceWidget {
  return {
    id: 'demo', version: '2.0.0', sdk: 1,
    name: { fr: 'Démo', en: 'Demo' }, description: { fr: 'Un widget', en: 'A widget' },
    icon: 'layout-grid', category: 'other',
    permissions: { subscriptions: [], commands: [], network: [] },
    connections: [], size: 2048, publishedAt: '2026-09-18T12:00:00.000Z',
    installed: true, installedVersion: '1.0.0', updateAvailable: true,
    sdkTooNew: false, consentNeeded: false,
    newPermissions: { subscriptions: [], commands: [], network: [] },
    shadowsBuiltin: false, placedOn: [],
    ...over,
  }
}

const answer = (widgets: MarketplaceWidget[], over: Partial<MarketplaceResponse> = {}): MarketplaceResponse =>
  ({ registry: 'fremkit-sietch', generatedAt: '2026-09-18T12:00:00.000Z', widgets, themes: [], offline: false, sdk: 1, ...over })

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
  m.state.consent = null
  m.state.updateAllOpen = false
  m.state.updatingAll = false
  m.state.busy = null
  m.state.kind = 'widget'
  m.state.themes = []
  m.state.installMissingOpen = false
  m.state.resultsAre = 'update'
  m.setView('available')
  // BaseSection remembers which shelves are open in localStorage, module scope, across mounts.
  try { localStorage.clear() } catch { /* private window */ }
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

describe('the panel itself', () => {
  async function panel(widgets: MarketplaceWidget[]): Promise<ReturnType<typeof mount>> {
    serve(answer(widgets))
    const wrapper = mount(MarketplacePanel, { attachTo: document.body })
    await settle()
    await wrapper.vm.$nextTick()
    return wrapper
  }

  it('says an installed widget is here, with the dot before the words', async () => {
    const wrapper = await panel([widget({ updateAvailable: false, version: '1.0.0' })])
    const row = wrapper.find('[data-widget="demo"]')
    expect(row.find('.dot.ok').exists()).toBe(true)
    expect(row.text()).toContain('1.0.0')
    wrapper.unmount()
  })

  it('offers Remove as the destructive one, not as the primary', async () => {
    const wrapper = await panel([widget({ updateAvailable: false })])
    const remove = wrapper.find('[data-widget="demo"] button.danger')
    expect(remove.exists()).toBe(true)
    expect(remove.classes()).not.toContain('primary')
    wrapper.unmount()
  })

  it('has nothing to update in bulk when nothing is waiting', async () => {
    const wrapper = await panel([widget({ updateAvailable: false })])
    useMarketplaceStore().setView('updates')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.bar button.bulk').exists()).toBe(false)
    wrapper.unmount()
  })

  it('disables every button while a series is running', async () => {
    const wrapper = await panel([widget()])
    useMarketplaceStore().setView('updates')
    useMarketplaceStore().state.updatingAll = true
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.bar button.bulk').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-widget="demo"] button.danger').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('offers the kind switch, now that there are two', async () => {
    const wrapper = await panel([widget()])
    expect(wrapper.find('.kinds').exists()).toBe(true)
    expect(wrapper.find('.kinds').findAll('button')).toHaveLength(2)
    wrapper.unmount()
  })

  it('gives a consent refusal somewhere to go', async () => {
    const wrapper = await panel([widget()])
    const m = useMarketplaceStore()
    m.setView('updates')
    m.state.results = { demo: { ok: false, error: 'it asks for more', newPermissions: { subscriptions: ['system'], commands: [], network: [] } } }
    await wrapper.vm.$nextTick()
    const link = wrapper.find('[data-widget="demo"] button.review')
    expect(link.exists()).toBe(true)
    await link.trigger('click')
    expect(m.state.consent?.added.subscriptions).toEqual(['system'])
    wrapper.unmount()
  })

  it('offers no way back when the failure was not about consent', async () => {
    const wrapper = await panel([widget()])
    const m = useMarketplaceStore()
    m.setView('updates')
    m.state.results = { demo: { ok: false, error: 'the package does not match its hash' } }
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-widget="demo"] button.review').exists()).toBe(false)
    expect(wrapper.find('[data-widget="demo"]').text()).toContain('does not match')
    wrapper.unmount()
  })

  it('forgets the results of a run when it is closed', async () => {
    const wrapper = await panel([widget()])
    const m = useMarketplaceStore()
    m.state.results = { demo: { ok: true, version: '2.0.0' } }
    wrapper.unmount()
    expect(m.state.results).toEqual({})
  })
})

describe('the update-all dialog', () => {
  const entry = (id: string, added: string[]) => ({
    widget: widget({ id }),
    added: { subscriptions: added, commands: [], network: [] },
  })

  it('names every waiting widget, and says so when one asks for nothing new', async () => {
    const wrapper = mount(UpdateAllDialog, {
      attachTo: document.body,
      props: { entries: [entry('a', ['system.load']), entry('b', [])] },
    })
    await wrapper.vm.$nextTick()
    const entries = wrapper.findAll('.entry')
    expect(entries).toHaveLength(2)
    expect(entries[0].text()).toContain('system')
    // The ones asking nothing are named too: a list that dropped them would leave the user
    // guessing which of the two the dialog was actually about.
    expect(entries[1].find('.none').exists()).toBe(true)
    wrapper.unmount()
  })

  it('emits what the two buttons mean', async () => {
    const wrapper = mount(UpdateAllDialog, { attachTo: document.body, props: { entries: [entry('a', [])] } })
    await wrapper.vm.$nextTick()
    const buttons = wrapper.findAll('.actions button')
    await buttons[1].trigger('click')
    await buttons[0].trigger('click')
    expect(wrapper.emitted('accept')).toHaveLength(1)
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    wrapper.unmount()
  })
})

describe('the banner for widgets a screen is missing', () => {
  async function panel(widgets: MarketplaceWidget[]): Promise<ReturnType<typeof mount>> {
    serve(answer(widgets))
    const wrapper = mount(MarketplacePanel, { attachTo: document.body })
    await settle()
    await wrapper.vm.$nextTick()
    return wrapper
  }

  const placed = (over: Partial<MarketplaceWidget> = {}) =>
    widget({ installed: false, installedVersion: null, updateAvailable: false, placedOn: ['Home'], ...over })

  it('counts them and offers to install them', async () => {
    const wrapper = await panel([placed({ id: 'a' }), placed({ id: 'b' })])
    const banner = wrapper.find('.placed')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('2')
    await banner.find('button').trigger('click')
    expect(useMarketplaceStore().state.installMissingOpen).toBe(true)
    wrapper.unmount()
  })

  it('stays out of the way when every placed widget is installed', async () => {
    const wrapper = await panel([placed({ id: 'a', installed: true, installedVersion: '2.0.0' })])
    expect(wrapper.find('.placed').exists()).toBe(false)
    wrapper.unmount()
  })

  it('opens one dialog for the series, naming every widget', async () => {
    const wrapper = await panel([placed({ id: 'a' }), placed({ id: 'b' })])
    await wrapper.find('.placed button').trigger('click')
    await wrapper.vm.$nextTick()
    // The same dialog as "update all": one list, the permissions per widget, nothing downloaded
    // before an answer — written once so the two cannot drift.
    expect(wrapper.findAll('.entry')).toHaveLength(2)
    // …and it is about installing, not about updating: the lead line is the one thing a reused
    // dialog gets wrong silently.
    expect(wrapper.find('.lead').text()).not.toMatch(/nouvelle version|new version/)
    wrapper.unmount()
  })
})

describe('what a finished series calls itself', () => {
  async function panel(widgets: MarketplaceWidget[]): Promise<ReturnType<typeof mount>> {
    serve(answer(widgets))
    const wrapper = mount(MarketplacePanel, { attachTo: document.body })
    await settle()
    await wrapper.vm.$nextTick()
    return wrapper
  }

  it('says installed after an install and updated after an update', async () => {
    // The two series share every line of code that produces a result, which is precisely why the
    // verb is the thing that ends up wrong: a fresh install announced itself as an update.
    const wrapper = await panel([widget()])
    const m = useMarketplaceStore()
    m.setView('updates')
    m.state.results = { demo: { ok: true, version: '2.0.0' } }
    m.state.resultsAre = 'install'
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-widget="demo"] .note.ok').text()).toMatch(/installé|installed/)
    m.state.resultsAre = 'update'
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-widget="demo"] .note.ok').text()).toMatch(/mis à jour|updated/)
    wrapper.unmount()
  })
})

describe('the Available view, on shelves', () => {
  async function panel(widgets: MarketplaceWidget[]): Promise<ReturnType<typeof mount>> {
    serve(answer(widgets))
    const wrapper = mount(MarketplacePanel, { attachTo: document.body })
    await settle()
    await wrapper.vm.$nextTick()
    return wrapper
  }

  const listed = (w: ReturnType<typeof mount>) =>
    w.findAll('[data-widget]').map((r) => r.attributes('data-widget'))

  it('gives each category its own shelf, in the library order', async () => {
    const wrapper = await panel([
      widget({ id: 'nas', category: 'home', updateAvailable: false, installed: false }),
      widget({ id: 'runs', category: 'dev', updateAvailable: false, installed: false }),
    ])
    expect(wrapper.findAll('details.section')).toHaveLength(2)
    // `dev` comes before `home` in WIDGET_CATEGORIES, whatever order the index listed them in.
    expect(listed(wrapper)).toEqual(['runs', 'nas'])
    wrapper.unmount()
  })

  it('puts a widget with no category of its own on the Other shelf', async () => {
    const wrapper = await panel([widget({ id: 'plain', category: 'other', updateAvailable: false, installed: false })])
    const section = wrapper.find('details.section')
    expect(section.exists()).toBe(true)
    expect(section.text()).toMatch(/Autre|Other/)
    wrapper.unmount()
  })

  it('draws no shelf at all for a category nothing is on', async () => {
    const wrapper = await panel([widget({ id: 'runs', category: 'dev', updateAvailable: false, installed: false })])
    // Eight headings with seven blanks would read as a broken panel.
    expect(wrapper.findAll('details.section')).toHaveLength(1)
    wrapper.unmount()
  })

  it('leaves Installed and Updates flat, since they are short by definition', async () => {
    const wrapper = await panel([
      widget({ id: 'nas', category: 'home', installed: true, installedVersion: '1.0.0' }),
      widget({ id: 'runs', category: 'dev', installed: true, installedVersion: '1.0.0' }),
    ])
    useMarketplaceStore().setView('installed')
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('details.section')).toHaveLength(0)
    expect(listed(wrapper)).toHaveLength(2)
    wrapper.unmount()
  })
})

describe('themes in the panel', () => {
  function theme(over: Partial<MarketplaceTheme> = {}): MarketplaceTheme {
    return {
      id: 'nuit', version: '1.0.0',
      name: { fr: 'Nuit', en: 'Night' }, description: { fr: 'Sombre', en: 'Dark' },
      author: 'someone', license: 'MIT',
      tokens: { accent: '#58a6ff', bg: '#0d1117', surface: '#161b22', text: '#e6edf3' },
      size: 900, publishedAt: '2026-09-18T12:00:00.000Z',
      installed: false, installedVersion: null, updateAvailable: false,
      shadowsBuiltin: false, inUse: false,
      ...over,
    }
  }

  async function panel(themes: MarketplaceTheme[]): Promise<ReturnType<typeof mount>> {
    serve(answer([], { themes }))
    const wrapper = mount(MarketplacePanel, { attachTo: document.body })
    await settle()
    useMarketplaceStore().state.kind = 'theme'
    await wrapper.vm.$nextTick()
    return wrapper
  }

  it('draws the four tokens as swatches rather than asking for a preview image', async () => {
    const wrapper = await panel([theme()])
    const row = wrapper.find('[data-theme="nuit"]')
    expect(row.exists()).toBe(true)
    const swatches = row.findAll('.sw')
    expect(swatches).toHaveLength(4)
    // bg, surface, accent, text — the order the strip reads in, not the order the object has.
    expect(swatches[0].attributes('title')).toBe('bg')
    expect(swatches[2].attributes('title')).toBe('accent')
    wrapper.unmount()
  })

  it('writes nothing into the style attribute that is not the shape of a colour', async () => {
    // The server validates every token; this is the copy that does not depend on that.
    const wrapper = await panel([theme({ tokens: { accent: 'red; content: url(x)', bg: '#0d1117', surface: '#161b22', text: '#e6edf3' } })])
    const swatches = wrapper.findAll('[data-theme="nuit"] .sw')
    expect(swatches).toHaveLength(3)
    expect(wrapper.html()).not.toContain('url(x)')
    wrapper.unmount()
  })

  it('offers no consent dialog at all, because there is nothing to list', async () => {
    const wrapper = await panel([theme()])
    await wrapper.find('[data-theme="nuit"] .act button').trigger('click')
    await wrapper.vm.$nextTick()
    expect(useMarketplaceStore().state.consent).toBeNull()
    wrapper.unmount()
  })

  it('will not remove the theme the screen is painted with', async () => {
    const wrapper = await panel([theme({ installed: true, installedVersion: '1.0.0', inUse: true })])
    const remove = wrapper.find('[data-theme="nuit"] button.danger')
    expect(remove.exists()).toBe(true)
    expect(remove.attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-theme="nuit"]').text()).toMatch(/utilisé|in use/)
    wrapper.unmount()
  })

  it('follows the theme actually chosen, not the one the index was fetched with', async () => {
    // `inUse` comes with the entry, and the entry is fetched when the panel opens. Choosing this
    // theme in Screen → Theme afterwards left the card offering a Remove the server answers 409
    // to — found by doing exactly that on a bench server.
    const s = useAdminStore()
    s.state.config = config()
    const wrapper = await panel([theme({ installed: true, installedVersion: '1.0.0', inUse: false })])
    expect(wrapper.find('[data-theme="nuit"] button.danger').attributes('disabled')).toBeUndefined()

    s.state.config = { ...config(), display: { ...config().display, theme: 'nuit' } } as Config
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-theme="nuit"] button.danger').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('says so when a built-in already owns the id', async () => {
    const wrapper = await panel([theme({ id: 'fremkit', shadowsBuiltin: true })])
    expect(wrapper.find('[data-theme="fremkit"] button').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps the widget shelves and the placed-widget banner out of the theme list', async () => {
    serve(answer(
      [widget({ id: 'stale', placedOn: ['Home'], installed: false, updateAvailable: false })],
      { themes: [theme()] },
    ))
    const wrapper = mount(MarketplacePanel, { attachTo: document.body })
    await settle()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.placed').exists()).toBe(true)
    useMarketplaceStore().state.kind = 'theme'
    await wrapper.vm.$nextTick()
    // A banner about missing widgets has nothing to say on the Themes list.
    expect(wrapper.find('.placed').exists()).toBe(false)
    expect(wrapper.findAll('details.section')).toHaveLength(0)
    expect(wrapper.findAll('[data-theme]')).toHaveLength(1)
    wrapper.unmount()
  })

  it('says the registry has no theme rather than showing the widget message', async () => {
    const wrapper = await panel([])
    expect(wrapper.find('.note').text()).toMatch(/thème publié|theme published/)
    wrapper.unmount()
  })
})
