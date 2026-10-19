/**
 * @vitest-environment jsdom
 *
 * iPad pairing and extra screens as an experimental feature: what the admin hides while
 * `labs.devices` is off (the Devices section, the screen selector and its "Add a screen" for a
 * single screen), the seven clicks on the version that reveal the switch, and the switch itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { Config, Screen } from '../src/shared/types'
import type { DeviceStatus, PublicDevice } from '../src/shared/api'

const getDevices = vi.hoisted(() => vi.fn())
vi.mock('../src/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shared/api')>()
  return { ...actual, api: { ...actual.api, getDevices } }
})

const status = (over: Partial<DeviceStatus> = {}): DeviceStatus => ({
  enabled: false, listening: false, error: null, guessing: false, host: 'mac.example.local',
  addresses: ['192.0.2.10'], port: 4243, keyHash: null, fingerprint: null, devices: [], companionRequest: null, ...over,
})
const paired: PublicDevice = {
  id: 'dev-1', kind: 'ipad', name: 'Kitchen iPad', pairedAt: '2026-10-01T08:00:00.000Z', lastSeen: null,
  viewport: { width: 1376, height: 1032 }, screenId: null,
}

const { default: ScreenSelector } = await import('../src/admin/ScreenSelector.vue')
const { default: SettingsWindow } = await import('../src/admin/settings/SettingsWindow.vue')
const { settingsPane, settingsQuery } = await import('../src/admin/settingsWindow')
const { useAdminStore } = await import('../src/admin/store')
const { useDevices } = await import('../src/admin/devices')
const labs = await import('../src/admin/labs')

const screen = (id: string, kind: Screen['kind'] = 'edge'): Screen => ({
  id, name: id.toUpperCase(), kind, display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 },
  nav: [], pages: [{ id: 'home', name: 'Home', items: [] }],
})

function config(devices: boolean | undefined, count: number): Config {
  return {
    version: 4,
    connections: [], secrets: { backend: 'file' }, locale: 'en',
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    ...(devices === undefined ? {} : { labs: { devices } }),
    widgets: {},
    screens: [screen('edge'), ...(count > 1 ? [screen('kitchen', 'device')] : [])],
  }
}

/** The settings window on a pane; Devices is an entry of its sidebar, the version is in About. */
function settings(pane: 'screen' | 'about' = 'screen') {
  settingsPane.value = pane
  settingsQuery.value = ''
  return mount(SettingsWindow, { attachTo: document.body, global: { stubs } })
}
function hasDevices(wrapper: ReturnType<typeof settings>): boolean {
  return wrapper.findAll('nav button.entry').some((b) => b.text() === 'Devices')
}

const stubs = {
  PageView: { template: '<div class="page-stub" />' },
  DevicesSection: true, NavWidgetsEditor: true, BackgroundPicker: true, DiagnosticsSection: true, HistorySection: true,
}

function seed(devices: boolean | undefined, count: number): void {
  const s = useAdminStore()
  s.state.config = config(devices, count)
  s.state.manifests = {}
  s.state.toast = ''
  s.selectScreen('edge')
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) =>
    new Response(url === '/api/themes' ? '{"themes":{},"errors":[]}' : init?.body ?? '{}',
      { headers: { 'content-type': 'application/json' } })))
  labs.resetLabsReveal()
  getDevices.mockReset()
  getDevices.mockRejectedValue(new Error('offline'))
  useDevices().status.value = null
})

afterEach(async () => {
  const s = useAdminStore()
  await s.flush()
  s.state.config = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('what the flag shows', () => {
  it('reads an absent flag as off', () => {
    expect(labs.labsDevices(config(undefined, 1))).toBe(false)
    expect(labs.labsDevices(null)).toBe(false)
  })

  for (const devices of [false, true]) {
    for (const count of [1, 2]) {
      // Intended: someone with several screens keeps seeing them — the selector *and* "Add a
      // screen" — whatever the flag says. The owner's rule; only a single screen hides them.
      const selector = devices || count > 1
      it(`flag ${devices ? 'on' : 'off'}, ${count} screen(s): selector and Add a screen ${selector ? 'shown' : 'hidden'}${!devices && count > 1 ? ' (several screens keep both, by design)' : ''}, Devices ${devices ? 'shown' : 'hidden'}`, async () => {
        seed(devices, count)
        expect(labs.showsScreens(config(devices, count))).toBe(selector)

        const sel = mount(ScreenSelector, { attachTo: document.body, global: { stubs } })
        expect(sel.find('nav.screens').exists()).toBe(selector)
        expect(sel.find('button.add').exists()).toBe(selector)
        sel.unmount()

        const insp = settings()
        await flushPromises()
        expect(hasDevices(insp)).toBe(devices)
        insp.unmount()
      })
    }
  }
})

describe('the Devices section while pairing is in use', () => {
  it('reads the status: listener on, or any paired device', () => {
    expect(labs.pairingInUse(null)).toBe(false)
    expect(labs.pairingInUse(status())).toBe(false)
    expect(labs.pairingInUse(status({ enabled: true }))).toBe(true)
    expect(labs.pairingInUse(status({ devices: [paired] }))).toBe(true)
    expect(labs.showsDevices(config(false, 1), status())).toBe(false)
    expect(labs.showsDevices(config(true, 1), status())).toBe(true)
    expect(labs.showsDevices(config(false, 1), status({ devices: [paired] }))).toBe(true)
  })

  for (const [name, answer, shown] of [
    ['the listener is on', status({ enabled: true }), true],
    ['a device is paired with the listener off', status({ devices: [paired] }), true],
    ['pairing is off and nothing is paired', status(), false],
  ] as const) {
    it(`flag off, ${name}: Devices ${shown ? 'shown' : 'hidden'}`, async () => {
      getDevices.mockResolvedValue(answer)
      seed(false, 1)
      const wrapper = settings()
      await flushPromises()
      expect(getDevices).toHaveBeenCalled()
      expect(hasDevices(wrapper)).toBe(shown)
      wrapper.unmount()
    })
  }

  it('is left out of the settings search while hidden', async () => {
    seed(false, 1)
    const wrapper = settings()
    await flushPromises()
    settingsQuery.value = 'iPad'
    await flushPromises()
    expect(wrapper.find('[data-section="screen.devices"]').exists()).toBe(false)
    wrapper.unmount()
    settingsQuery.value = ''
  })

  it('stays while the panel is open after the last device is unpaired', async () => {
    getDevices.mockResolvedValue(status({ devices: [paired] }))
    seed(false, 1)
    const wrapper = settings()
    await flushPromises()
    expect(hasDevices(wrapper)).toBe(true)
    useDevices().status.value = status()
    await flushPromises()
    expect(hasDevices(wrapper)).toBe(true)
    wrapper.unmount()
  })
})

describe('labs.companion', () => {
  const withCompanion = (companion: boolean | undefined): Config =>
    ({ ...config(false, 1), labs: { devices: false, ...(companion === undefined ? {} : { companion }) } })
  const manifest = (id: string) => ({ id }) as unknown as import('../src/shared/types').WidgetManifest

  it('reads an absent flag as off', () => {
    expect(labs.labsCompanion(null)).toBe(false)
    expect(labs.labsCompanion(config(true, 1))).toBe(false)
    expect(labs.labsCompanion(withCompanion(undefined))).toBe(false)
    expect(labs.labsCompanion(withCompanion(true))).toBe(true)
  })

  it('leaves Fremplay out of the widget lists while off, and only Fremplay', () => {
    const manifests = { clock: manifest('clock'), fremplay: manifest('fremplay') }
    expect(labs.widgetOffered(withCompanion(false), 'fremplay')).toBe(false)
    expect(labs.widgetOffered(withCompanion(false), 'clock')).toBe(true)
    expect(labs.offeredManifests(withCompanion(false), manifests).map((m) => m.id)).toEqual(['clock'])
    expect(labs.offeredManifests(withCompanion(true), manifests).map((m) => m.id)).toEqual(['clock', 'fremplay'])
  })

  it('counts a paired extension for its own part of the Devices pane, not for the iPad one', () => {
    const ext = { id: 'ext-1', kind: 'extension', name: 'Chrome', pairedAt: '2026-10-02T08:00:00.000Z', lastSeen: null,
      origin: `chrome-extension://${'a'.repeat(32)}`, installId: '3a9c1d2e-5b6f-4a7b-8c9d-0e1f2a3b4c5d', connected: false } as PublicDevice
    const off = withCompanion(false)
    expect(labs.pairingInUse(status({ devices: [ext] }))).toBe(false)
    expect(labs.extensionsPaired(status({ devices: [ext] }))).toBe(true)
    expect(labs.extensionsPaired(status({ devices: [paired] }))).toBe(false)
    expect(labs.showsIpads(off, status({ devices: [ext] }))).toBe(false)
    expect(labs.showsExtensions(off, status({ devices: [ext] }))).toBe(true)
    expect(labs.showsExtensions(off, status({ devices: [paired], enabled: true }))).toBe(false)
    expect(labs.showsExtensions(withCompanion(true), status())).toBe(true)
    expect(labs.showsIpads(withCompanion(true), status())).toBe(false)
    expect(labs.showsDevices(off, status({ devices: [ext] }))).toBe(true)
  })

  it('shows the Devices pane and the switches while on, as labs.devices does', () => {
    expect(labs.showsDevices(withCompanion(true), status())).toBe(true)
    expect(labs.showsDevices(withCompanion(false), status())).toBe(false)
    expect(labs.labsShown(withCompanion(true))).toBe(true)
    expect(labs.labsShown(withCompanion(false))).toBe(false)
  })

  it('has its own switch in About, under the same seven clicks, which writes the flag alone', async () => {
    seed(false, 1)
    const s = useAdminStore()
    const wrapper = settings('about')
    await flushPromises()
    const version = wrapper.find('[data-test="version"]')
    for (let i = 0; i < labs.REVEAL_TAPS - 1; i++) await version.trigger('click')
    expect(wrapper.find('[data-test="labs-companion"]').exists()).toBe(false)
    await version.trigger('click')
    await flushPromises()
    const box = wrapper.find('[data-test="labs-companion"] input')
    expect(wrapper.text()).toMatch(/Browser companion \(Fremplay\)|Compagnon de navigateur \(Fremplay\)/)
    expect((box.element as HTMLInputElement).checked).toBe(false)
    await box.setValue(true)
    expect(s.state.config!.labs).toEqual({ devices: false, companion: true })
    expect(hasDevices(wrapper)).toBe(true)
    await box.setValue(false)
    expect(s.state.config!.labs).toEqual({ devices: false, companion: false })
    expect(hasDevices(wrapper)).toBe(false)
    wrapper.unmount()
  })
})

describe('the seven clicks on the version', () => {
  it('reveal nothing before the seventh, then reveal once', () => {
    for (let i = 1; i < labs.REVEAL_TAPS; i++) expect(labs.tapVersion(1000 + i * 100)).toBe(false)
    expect(labs.labsShown(config(false, 1))).toBe(false)
    expect(labs.tapVersion(1700)).toBe(true)
    expect(labs.labsShown(config(false, 1))).toBe(true)
    expect(labs.tapVersion(1800)).toBe(false)
  })

  it('start over when they are too slow', () => {
    for (let i = 0; i < labs.REVEAL_TAPS - 1; i++) labs.tapVersion(i * 100)
    // The seventh comes after the window: it counts as the first of a new series.
    expect(labs.tapVersion(labs.REVEAL_WINDOW_MS + 1)).toBe(false)
    for (let i = 1; i < labs.REVEAL_TAPS - 1; i++) expect(labs.tapVersion(labs.REVEAL_WINDOW_MS + 1 + i * 100)).toBe(false)
    expect(labs.tapVersion(labs.REVEAL_WINDOW_MS + 1 + (labs.REVEAL_TAPS - 1) * 100)).toBe(true)
  })

  it('show the switch in About, focus it without a toast, and the switch writes the flag', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T08:00:00Z'))
    seed(false, 1)
    const s = useAdminStore()
    const wrapper = settings('about')
    await flushPromises()
    const version = wrapper.find('[data-test="version"]')
    // The version text, not a button: no role, but a tab stop for the keyboard path.
    expect(version.element.tagName).toBe('P')
    expect(version.attributes('role')).toBeUndefined()
    expect(version.attributes('tabindex')).toBe('0')
    for (let i = 0; i < labs.REVEAL_TAPS - 1; i++) await version.trigger('click')
    expect(wrapper.find('[data-test="labs-devices"]').exists()).toBe(false)
    await version.trigger('click')
    await flushPromises()
    const box = wrapper.find('[data-test="labs-devices"] input')
    // The box takes the focus, which scrolls it into view and announces it; no error toast.
    expect(document.activeElement).toBe(box.element)
    expect(s.state.toast).toBe('')
    expect(wrapper.text()).toMatch(/Experimental features|Fonctions expérimentales/)
    expect((box.element as HTMLInputElement).checked).toBe(false)

    await box.setValue(true)
    expect(s.state.config!.labs).toEqual({ devices: true })
    expect(hasDevices(wrapper)).toBe(true)
    await box.setValue(false)
    expect(s.state.config!.labs).toEqual({ devices: false })
    expect(hasDevices(wrapper)).toBe(false)
    // Still there once turned off in this session, so it can be turned back on.
    expect(wrapper.find('[data-test="labs-devices"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('can be pressed from the keyboard: seven presses of Enter on the version', async () => {
    seed(false, 1)
    const wrapper = settings('about')
    await flushPromises()
    const version = wrapper.find('[data-test="version"]')
    for (let i = 0; i < labs.REVEAL_TAPS - 1; i++) await version.trigger('keydown', { key: 'Enter' })
    expect(wrapper.find('[data-test="labs-devices"]').exists()).toBe(false)
    await version.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(wrapper.find('[data-test="labs-devices"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('do not count a held Enter: key repeats are ignored', async () => {
    seed(false, 1)
    const wrapper = settings('about')
    await flushPromises()
    const version = wrapper.find('[data-test="version"]')
    await version.trigger('keydown', { key: 'Enter' })
    for (let i = 0; i < 20; i++) await version.trigger('keydown', { key: 'Enter', repeat: true })
    await flushPromises()
    expect(wrapper.find('[data-test="labs-devices"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('leave the switch in sight while the flag is on, revealed or not', async () => {
    seed(true, 1)
    const wrapper = settings('about')
    await flushPromises()
    const box = wrapper.find('[data-test="labs-devices"] input')
    expect((box.element as HTMLInputElement).checked).toBe(true)
    await box.setValue(false)
    expect(useAdminStore().state.config!.labs).toEqual({ devices: false })
    wrapper.unmount()
  })
})
