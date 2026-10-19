/**
 * @vitest-environment jsdom
 *
 * The browser extension on the Edge: the pairing prompt, and the page a share lands on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import type { Config } from '../src/shared/types'
import { createRevealTracker } from '../src/dashboard/companionReveal'

const fake = vi.hoisted(() => ({
  subs: new Map<string, Set<(data: unknown) => void>>(),
  config: null as unknown,
  refuse: vi.fn(async (_id: string, _code: string) => {}),
  /** The mocked socket's status, to drop the connection from a test. */
  status: null as unknown as { value: string },
}))

vi.mock('../src/shared/socket', async () => {
  const { ref } = await import('vue')
  const socket = {
    status: ref('open'),
    subscribe(channel: string, cb: (data: unknown) => void) {
      let set = fake.subs.get(channel)
      if (!set) { set = new Set(); fake.subs.set(channel, set) }
      set.add(cb)
      return () => { set!.delete(cb) }
    },
    command: async () => undefined,
  }
  fake.status = socket.status
  return { useSocket: () => socket }
})
vi.mock('../src/shared/api', () => ({
  api: {
    getWidgets: async () => ({ widgets: {} }),
    getConfig: async () => fake.config,
    refuseCompanion: (id: string, code: string) => fake.refuse(id, code),
  },
}))
vi.mock('../src/shared/theme', () => ({ useConfigTheme: () => {}, followThemeSchedule: () => () => {} }))

function push(channel: string, data: unknown): void {
  fake.subs.get(channel)?.forEach((cb) => cb(data))
}

const NOW = 1_000_000
const pairing = (over: Record<string, unknown> = {}) =>
  ({ requestId: 'r1', code: 'K7M2', name: 'Companion on Chrome', expiresAt: NOW + 120_000, ...over })

describe('the pairing prompt', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); fake.refuse.mockClear() })
  afterEach(() => { vi.useRealTimers() })

  async function mountPrompt(p: unknown) {
    const { default: CompanionPrompt } = await import('../src/dashboard/CompanionPrompt.vue')
    return mount(CompanionPrompt, { props: { pairing: p as never } })
  }

  it('shows the code to type in the browser and the name, and no Allow', async () => {
    const w = await mountPrompt(pairing())
    expect(w.find('[data-test="companion-code"]').text()).toBe('K7M2')
    expect(w.text()).toContain('Companion on Chrome')
    expect(w.text()).toContain('Tapez ce code dans votre navigateur')
    // Typing the code into the extension is the approval: nothing here can give one.
    expect(w.findAll('button').map((b) => b.classes())).toEqual([['refuse']])
  })

  it('shows the first characters of the asking extension\'s id', async () => {
    const w = await mountPrompt(pairing({ extension: 'lnckeo' }))
    expect(w.find('[data-test="companion-extension"]').text()).toBe('extension lnckeo…')
    const none = await mountPrompt(pairing())
    expect(none.find('[data-test="companion-extension"]').exists()).toBe(false)
  })

  it('calls refuse on Refuser at once, with the code on show', async () => {
    const w = await mountPrompt(pairing())
    await w.find('button.refuse').trigger('click')
    expect(fake.refuse).toHaveBeenCalledWith('r1', 'K7M2')
  })

  it('shows its own short error when the answer fails, not the server\'s sentence', async () => {
    // What the server sends for a request that expired between the snapshot and the tap.
    fake.refuse.mockRejectedValueOnce(Object.assign(new Error('this connection request no longer exists or was already answered'), { status: 404 }))
    const w = await mountPrompt(pairing())
    await w.find('button.refuse').trigger('click')
    await flushPromises()
    expect(w.find('.error').text()).toBe('Réponse impossible, réessayez')
  })

  it('says how many other browsers were turned away while the request waited', async () => {
    const quiet = await mountPrompt(pairing({ turnedAway: 0 }))
    expect(quiet.find('[data-test="turned-away"]').exists()).toBe(false)
    const w = await mountPrompt(pairing({ turnedAway: 3 }))
    expect(w.find('[data-test="turned-away"]').text()).toContain('(3)')
  })

  it('says the request changed when the server answers 409', async () => {
    fake.refuse.mockRejectedValueOnce(Object.assign(new Error('the request changed: check the code'), { status: 409 }))
    const w = await mountPrompt(pairing())
    await w.find('button.refuse').trigger('click')
    await flushPromises()
    expect(w.find('.error').text()).toBe('La demande a changé : vérifiez le code')
  })

  it('keeps Refuse disabled after it went through, until another request comes', async () => {
    fake.refuse.mockResolvedValue(undefined)
    const w = await mountPrompt(pairing())
    await w.find('button.refuse').trigger('click')
    await flushPromises()
    expect(w.find('button.refuse').attributes('disabled')).toBeDefined()
    // A second tap before the snapshot hides the prompt sends nothing and shows no error.
    await w.find('button.refuse').trigger('click')
    await flushPromises()
    expect(fake.refuse).toHaveBeenCalledTimes(1)
    expect(w.find('.error').exists()).toBe(false)
    await w.setProps({ pairing: pairing({ expiresAt: NOW + 60_000 }) as never })
    expect(w.find('button.refuse').attributes('disabled')).toBeDefined()
    await w.setProps({ pairing: pairing({ requestId: 'r2' }) as never })
    expect(w.find('button.refuse').attributes('disabled')).toBeUndefined()
  })

  it('frees Refuse after a failure, to try again', async () => {
    fake.refuse.mockRejectedValueOnce(new Error('HTTP 500'))
    const w = await mountPrompt(pairing())
    await w.find('button.refuse').trigger('click')
    await flushPromises()
    expect(w.find('button.refuse').attributes('disabled')).toBeUndefined()
  })

  it('hides at expiresAt even before the next snapshot', async () => {
    const w = await mountPrompt(pairing())
    expect(w.find('.companion-prompt').exists()).toBe(true)
    vi.advanceTimersByTime(120_001)
    await nextTick()
    expect(w.find('.companion-prompt').exists()).toBe(false)
  })

  it('renders nothing for a request already expired', async () => {
    const w = await mountPrompt(pairing({ expiresAt: NOW - 1 }))
    expect(w.find('.companion-prompt').exists()).toBe(false)
  })
})

describe('the reveal tracker', () => {
  const snap = (seq: number, screenId = 'edge', pageIndex = 1) => ({ reveal: { seq, screenId, pageIndex } })

  it('records the first snapshot without acting', () => {
    const t = createRevealTracker()
    expect(t.observe(snap(4), 'edge')).toBeNull()
  })

  it('selects the page once per seq, and again when the seq differs (a restart)', () => {
    const t = createRevealTracker()
    t.observe({ reveal: null }, 'edge')
    expect(t.observe(snap(1, 'edge', 2), 'edge')).toBe(2)
    expect(t.observe(snap(1, 'edge', 2), 'edge')).toBeNull()
    expect(t.observe(snap(2, 'edge', 0), 'edge')).toBe(0)
    t.observe({ reveal: null }, 'edge')
    expect(t.observe(snap(1, 'edge', 3), 'edge')).toBe(3)
  })

  it('ignores a reveal for another screen', () => {
    const t = createRevealTracker()
    t.observe({ reveal: null }, 'edge')
    expect(t.observe(snap(1, 'pad'), 'edge')).toBeNull()
  })

  it('does not act on a reconnect snapshot after reset', () => {
    const t = createRevealTracker()
    t.observe({ reveal: null }, 'edge')
    t.reset()
    expect(t.observe(snap(7), 'edge')).toBeNull()
    expect(t.observe(snap(8), 'edge')).toBe(1)
  })
})

describe('the dashboard and the companion channel', () => {
  const config = (): Config => ({
    version: 4, theme: 'fremkit', connections: [], secrets: { backend: 'file' }, locale: 'en',
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    labs: { devices: false, companion: true },
    widgets: {},
    screens: [{
      id: 'edge', name: 'edge', kind: 'edge',
      display: { cols: 20, rows: 10, cell: 40, autoCycleSeconds: 0 }, nav: [],
      pages: [0, 1, 2].map((i) => ({ id: `p${i}`, name: `P${i}`, items: [] })),
    }],
  } as unknown as Config)
  const PageStub = defineComponent({
    props: { page: { type: Object, required: true } },
    setup: (props) => () => {
      const page = props.page as { id: string; items: { instanceId: string }[] }
      return h('div', { class: 'page-stub', 'data-items': page.items.map((i) => i.instanceId).join(',') }, page.id)
    },
  })

  /** A bar item, as an element carrying its instance id (NavBar sets `data-nav-instance`). */
  const CompactStub = defineComponent({ setup: () => () => h('div', { class: 'compact-stub' }) })

  async function mountApp(href: string) {
    const url = new URL(href)
    vi.stubGlobal('location', { protocol: url.protocol, search: url.search, host: url.host, href: url.href, reload: vi.fn() })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"id":"d1","name":"Pad","screenId":"edge"}', { status: 200 })))
    const { default: App } = await import('../src/dashboard/App.vue')
    const wrapper = mount(App, { global: { stubs: { PageView: PageStub, CompactWidgetFrame: CompactStub } }, attachTo: document.body })
    await flushPromises(); await nextTick()
    return wrapper
  }

  beforeEach(() => { vi.resetModules(); fake.subs.clear(); fake.config = config() })
  afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

  const state = (over: Record<string, unknown>) => ({ pairing: null, reveal: null, ...over })

  it('a reveal for this screen selects its page once per seq', async () => {
    const w = await mountApp('http://127.0.0.1:4242/')
    push('companion', state({}))
    push('companion', state({ reveal: { seq: 1, screenId: 'edge', pageIndex: 2 } }))
    await nextTick()
    expect(w.find('.page-stub').text()).toBe('p2')
    w.unmount()
  })

  it('a reload with a share already revealed does not jump', async () => {
    const w = await mountApp('http://127.0.0.1:4242/')
    push('companion', state({ reveal: { seq: 3, screenId: 'edge', pageIndex: 2 } }))
    await nextTick()
    expect(w.find('.page-stub').text()).toBe('p0')
    w.unmount()
  })

  it('a reveal for another screen does nothing', async () => {
    const w = await mountApp('http://127.0.0.1:4242/')
    push('companion', state({}))
    push('companion', state({ reveal: { seq: 1, screenId: 'other', pageIndex: 2 } }))
    await nextTick()
    expect(w.find('.page-stub').text()).toBe('p0')
    w.unmount()
  })

  it('a remote page never subscribes to the channel', async () => {
    const w = await mountApp('https://example.local:4243/')
    expect(fake.subs.get('companion')?.size ?? 0).toBe(0)
    w.unmount()
  })

  it('shows the prompt while a request is pending and drops it when it leaves the snapshot', async () => {
    const w = await mountApp('http://127.0.0.1:4242/')
    push('companion', state({ pairing: { requestId: 'r1', code: 'K7M2', name: 'Companion', expiresAt: Date.now() + 60_000 } }))
    await nextTick()
    expect(w.find('.companion-prompt').exists()).toBe(true)
    push('companion', state({}))
    await nextTick()
    expect(w.find('.companion-prompt').exists()).toBe(false)
    w.unmount()
  })

  it('drops the code as soon as the socket is not open, and shows it again only from a new snapshot', async () => {
    const w = await mountApp('http://127.0.0.1:4242/')
    push('companion', state({ pairing: { requestId: 'r1', code: 'K7M2', name: 'Companion', expiresAt: Date.now() + 60_000 } }))
    await nextTick()
    expect(w.find('.companion-prompt').exists()).toBe(true)
    fake.status.value = 'connecting'
    await nextTick()
    expect(w.find('.companion-prompt').exists()).toBe(false)
    expect(w.text()).not.toContain('K7M2')
    // Back online, the stale code does not come back by itself.
    fake.status.value = 'open'
    await nextTick()
    expect(w.find('.companion-prompt').exists()).toBe(false)
    push('companion', state({ pairing: { requestId: 'r2', code: 'P4Q9', name: 'Companion', expiresAt: Date.now() + 60_000 } }))
    await nextTick()
    expect(w.find('.companion-prompt').text()).toContain('P4Q9')
    w.unmount()
  })

  it('shows no prompt while labs.companion is off', async () => {
    for (const labs of [{ devices: false, companion: false }, { devices: true }, undefined]) {
      fake.config = { ...(config() as object), labs } as unknown as Config
      vi.resetModules()
      const w = await mountApp('http://127.0.0.1:4242/')
      push('companion', state({ pairing: { requestId: 'r1', code: 'K7M2', name: 'Companion', expiresAt: Date.now() + 60_000 } }))
      await nextTick()
      expect(w.find('.companion-prompt').exists(), JSON.stringify(labs)).toBe(false)
      w.unmount()
    }
  })

  /** Fremplay on p1 alone and in the bar, a clock beside a Fremplay on p2. */
  const withFremplay = (companion: boolean): Config => {
    const c = config() as unknown as { labs: object; widgets: Record<string, unknown>; screens: { nav: unknown[]; pages: { id: string; items: unknown[] }[] }[] }
    c.labs = { devices: false, companion }
    c.widgets = {
      fp: { widgetId: 'fremplay', showTitle: false, settings: {} },
      fp2: { widgetId: 'fremplay', showTitle: false, settings: {} },
      bar: { widgetId: 'fremplay', showTitle: false, settings: {} },
      clock: { widgetId: 'clock', showTitle: false, settings: {} },
    }
    const at = (instanceId: string, x = 0) => ({ instanceId, x, y: 0, w: 4, h: 4 })
    c.screens[0].pages[1].items = [at('fp')]
    c.screens[0].pages[2].items = [at('clock'), at('fp2', 5)]
    c.screens[0].nav = [{ instanceId: 'bar', slot: 'left' }]
    return c as unknown as Config
  }

  it('draws no Fremplay while labs.companion is off, drops the page that held only one, and restores it', async () => {
    fake.config = withFremplay(false)
    const w = await mountApp('http://127.0.0.1:4242/')
    // p1 held only Fremplay: two pages left, the second being p2 without its Fremplay.
    expect(w.findAll('[data-nav-instance]')).toHaveLength(0)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    await nextTick()
    expect(w.find('.page-stub').text()).toBe('p2')
    expect(w.find('.page-stub').attributes('data-items')).toBe('clock')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    await nextTick()
    expect(w.find('.page-stub').text()).toBe('p0')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
    await nextTick()
    expect(w.find('.page-stub').text()).toBe('p2')
    // The switch on again: the config never lost them, so they come back in place, and the page
    // shown stays the one it was.
    push('config', withFremplay(true))
    await flushPromises(); await nextTick()
    expect(w.find('.page-stub').text()).toBe('p2')
    expect(w.find('.page-stub').attributes('data-items')).toBe('clock,fp2')
    expect(w.findAll('[data-nav-instance]').map((e) => e.attributes('data-nav-instance'))).toEqual(['bar'])
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
    await nextTick()
    expect(w.find('.page-stub').text()).toBe('p1')
    // Off again while on p1, which drops out: the page now at its place.
    push('config', withFremplay(false))
    await flushPromises(); await nextTick()
    expect(w.find('.page-stub').text()).toBe('p2')
    w.unmount()
  })

  it('a paired device draws its Fremplay tiles with the switch on and leaves them out with it off', async () => {
    // The device's view of the config: one screen, its widgets, and labs.companion alone.
    const deviceView = (companion: boolean) => {
      const c = withFremplay(companion) as unknown as Record<string, unknown>
      return { version: c.version, theme: c.theme, locale: c.locale, labs: { companion }, widgets: c.widgets, screens: c.screens } as unknown as Config
    }
    const device = async () => { push('device', { id: 'd1', name: 'Pad', screenId: 'edge', brightness: null }); await flushPromises(); await nextTick() }
    fake.config = deviceView(true)
    const on = await mountApp('https://example.local:4243/')
    await device()
    expect(on.findAll('.page-stub')).toHaveLength(1)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    await nextTick()
    expect(on.find('.page-stub').text()).toBe('p1')
    expect(on.find('.page-stub').attributes('data-items')).toBe('fp')
    on.unmount()
    vi.resetModules()
    fake.config = deviceView(false)
    const off = await mountApp('https://example.local:4243/')
    await device()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    await nextTick()
    expect(off.find('.page-stub').text()).toBe('p2')
    expect(off.find('.page-stub').attributes('data-items')).toBe('clock')
    off.unmount()
  })

  it('a dashboard that has just loaded turns to the Fremplay page when a share is live', async () => {
    const c = withFremplay(true) as unknown as { screens: { nav: unknown[] }[] }
    c.screens[0].nav = []
    fake.config = c as unknown as Config
    const w = await mountApp('http://127.0.0.1:4242/')
    push('companion', state({ tab: { state: 'sharing' } }))
    await nextTick()
    expect(w.find('.page-stub').text()).toBe('p1')
    // Once: a later snapshot of the same share leaves the page the user turned to.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
    await nextTick()
    push('companion', state({ tab: { state: 'sharing' } }))
    await nextTick()
    expect(w.find('.page-stub').text()).toBe('p0')
    w.unmount()
  })

  describe('after a server restart, the share coming back seconds after the kiosk', () => {
    const NOW = 1_800_000_000_000
    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW) })
    afterEach(() => { vi.useRealTimers() })
    const placed = () => {
      const c = withFremplay(true) as unknown as { screens: { nav: unknown[] }[] }
      c.screens[0].nav = []
      return c as unknown as Config
    }

    it('lands on the Fremplay page when the share shows a few seconds after the load', async () => {
      fake.config = placed()
      const w = await mountApp('http://127.0.0.1:4242/')
      // The server is back before the extension: the first snapshot has no share.
      push('companion', state({ tab: { state: 'idle' }, extensions: { connected: 0, paired: 1 } }))
      await nextTick()
      expect(w.find('.page-stub').text()).toBe('p0')
      vi.setSystemTime(NOW + 4_000)
      push('companion', state({ tab: { state: 'sharing' } }))
      await nextTick()
      expect(w.find('.page-stub').text()).toBe('p1')
      w.unmount()
    })

    it('does not move once the window after the load has passed', async () => {
      fake.config = placed()
      const w = await mountApp('http://127.0.0.1:4242/')
      push('companion', state({ tab: { state: 'idle' } }))
      vi.setSystemTime(NOW + 16_000)
      push('companion', state({ tab: { state: 'sharing' } }))
      await nextTick()
      expect(w.find('.page-stub').text()).toBe('p0')
      w.unmount()
    })

    it('a dashboard that stayed loaded is not moved when its socket comes back over a live share', async () => {
      fake.config = placed()
      const w = await mountApp('http://127.0.0.1:4242/')
      push('companion', state({ tab: { state: 'idle' } }))
      await nextTick()
      vi.setSystemTime(NOW + 60_000)
      fake.status.value = 'connecting'
      await nextTick()
      fake.status.value = 'open'
      await nextTick()
      push('companion', state({ tab: { state: 'sharing' } }))
      await nextTick()
      expect(w.find('.page-stub').text()).toBe('p0')
      w.unmount()
    })

    it('lands once: a share that goes and comes back within the window does not move it again', async () => {
      fake.config = placed()
      const w = await mountApp('http://127.0.0.1:4242/')
      push('companion', state({ tab: { state: 'sharing' } }))
      await nextTick()
      expect(w.find('.page-stub').text()).toBe('p1')
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
      push('companion', state({ tab: { state: 'idle' } }))
      vi.setSystemTime(NOW + 5_000)
      push('companion', state({ tab: { state: 'sharing' } }))
      await nextTick()
      expect(w.find('.page-stub').text()).toBe('p0')
      w.unmount()
    })
  })

  it('does not land anywhere when nothing is shared, the bar holds the widget, or the switch is off', async () => {
    for (const [cfg, tab] of [
      [withFremplay(true), { state: 'idle' }],
      [withFremplay(true), { state: 'sharing' }],
      [withFremplay(false), { state: 'sharing' }],
    ] as const) {
      fake.config = cfg
      vi.resetModules()
      const w = await mountApp('http://127.0.0.1:4242/')
      push('companion', state({ tab }))
      await nextTick()
      expect(w.find('.page-stub').text()).toBe('p0')
      w.unmount()
    }
  })
})

describe('landingPage', () => {
  const screen = (nav: string[], pages: string[][]) => ({
    nav: nav.map((instanceId) => ({ instanceId, slot: 'left' as const })),
    pages: pages.map((ids, i) => ({ id: `p${i}`, name: '', items: ids.map((instanceId) => ({ instanceId, x: 0, y: 0, w: 1, h: 1 })) })),
  })
  const cfg = (companion: boolean) => ({
    labs: { devices: false, companion },
    widgets: { fp: { widgetId: 'fremplay', showTitle: false, settings: {} }, c: { widgetId: 'clock', showTitle: false, settings: {} } },
  }) as unknown as Config

  it('is the first page holding Fremplay while a share is live', async () => {
    const { landingPage } = await import('../src/dashboard/companionReveal')
    expect(landingPage({ tab: { state: 'sharing' } }, cfg(true), screen([], [['c'], ['c', 'fp'], ['fp']]))).toBe(1)
    expect(landingPage({ tab: { state: 'idle' } }, cfg(true), screen([], [['c'], ['fp']]))).toBeNull()
    expect(landingPage({}, cfg(true), screen([], [['c'], ['fp']]))).toBeNull()
    expect(landingPage({ tab: { state: 'sharing' } }, cfg(false), screen([], [['c'], ['fp']]))).toBeNull()
    expect(landingPage({ tab: { state: 'sharing' } }, cfg(true), screen(['fp'], [['c'], ['fp']]))).toBeNull()
    expect(landingPage({ tab: { state: 'sharing' } }, cfg(true), screen([], [['c']]))).toBeNull()
  })
})
