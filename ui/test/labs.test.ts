/**
 * @vitest-environment jsdom
 *
 * The admin's experimental features, with no flag left: iPad pairing and extra screens are not
 * one any more (the Devices pane, the screen selector and its "Add a screen" on a fresh config),
 * nor the browser companion; the seven clicks on the version still reveal the block, which says
 * there is nothing to try.
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
  id: 'dev-1', kind: 'tablet', platform: 'ios', name: 'Kitchen iPad', pairedAt: '2026-10-01T08:00:00.000Z', lastSeen: null,
  viewport: { width: 1376, height: 1032 }, screenId: null,
}

const { default: ScreenSelector } = await import('../src/admin/ScreenSelector.vue')
const { default: SettingsWindow } = await import('../src/admin/settings/SettingsWindow.vue')
const { default: AboutPane } = await import('../src/admin/settings/AboutPane.vue')
const { settingsPane, settingsQuery } = await import('../src/admin/settingsWindow')
const { useAdminStore } = await import('../src/admin/store')
const { useDevices } = await import('../src/admin/devices')
const labs = await import('../src/admin/labs')

const screen = (id: string, kind: Screen['kind'] = 'edge'): Screen => ({
  id, name: id.toUpperCase(), kind, display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 },
  nav: [], pages: [{ id: 'home', name: 'Home', items: [] }],
})

/** `labs` as given, absent when undefined: a 0.5.0 file may still say `{ companion: false }`. */
function config(labsValue: Record<string, boolean> | undefined, count: number): Config {
  return {
    version: 4,
    connections: [], secrets: { backend: 'file' }, locale: 'en',
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    ...(labsValue === undefined ? {} : { labs: labsValue }),
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

function seed(labsValue: Record<string, boolean> | undefined, count: number): void {
  const s = useAdminStore()
  s.state.config = config(labsValue, count)
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

describe('iPad pairing and extra screens, for everyone', () => {
  for (const labsValue of [undefined, {}, { devices: false, companion: false }] as (Record<string, boolean> | undefined)[]) {
    for (const count of [1, 2]) {
      it(`labs ${JSON.stringify(labsValue) ?? 'absent'}, ${count} screen(s): selector, Add a screen and Devices shown`, async () => {
        seed(labsValue, count)
        const sel = mount(ScreenSelector, { attachTo: document.body, global: { stubs } })
        expect(sel.find('nav.screens').exists()).toBe(true)
        expect(sel.find('button.add').exists()).toBe(true)
        sel.unmount()

        const insp = settings()
        await flushPromises()
        expect(hasDevices(insp)).toBe(true)
        insp.unmount()
      })
    }
  }

  it('finds the Devices pane in the settings search on a fresh config, by the iPad or the browser', async () => {
    seed(undefined, 1)
    const wrapper = settings()
    await flushPromises()
    // "Chrome" and "App Store" are only in the store lines; "extension" in the extensions part.
    for (const query of ['iPad', 'Chrome', 'App Store', 'extension']) {
      settingsQuery.value = query
      await flushPromises()
      expect(wrapper.find('[data-section="screen.devices"]').exists(), query).toBe(true)
    }
    wrapper.unmount()
    settingsQuery.value = ''
  })
})

describe('labsShown', () => {
  it('is false with no flag on and nothing revealed, a 0.5.0 file included', () => {
    expect(labs.labsShown(null)).toBe(false)
    expect(labs.labsShown(config(undefined, 1))).toBe(false)
    expect(labs.labsShown(config({}, 1))).toBe(false)
    expect(labs.labsShown(config({ companion: false }, 1))).toBe(false)
  })
  it('is true while any flag is on, so a flag added later needs nothing here', () => {
    expect(labs.labsShown(config({ later: true }, 1))).toBe(true)
  })

  it('has a third switch for Fremdev, which writes its key and leaves the others', async () => {
    seed(false, 1)
    const s = useAdminStore()
    const wrapper = settings('about')
    await flushPromises()
    const version = wrapper.find('[data-test="version"]')
    for (let i = 0; i < labs.REVEAL_TAPS; i++) await version.trigger('click')
    await flushPromises()
    const box = wrapper.find('[data-test="labs-fremdev"] input')
    expect(box.exists()).toBe(true)
    await box.setValue(true)
    expect(s.state.config!.labs).toEqual({ devices: false, fremdev: true })
    expect(labs.labsCompanion(s.state.config)).toBe(false)
    expect(labs.labsFremdev(s.state.config)).toBe(true)
    wrapper.unmount()
  })
})

describe('the seven clicks on the version', () => {
  it('reveal nothing before the seventh, then reveal once', () => {
    for (let i = 1; i < labs.REVEAL_TAPS; i++) expect(labs.tapVersion(1000 + i * 100)).toBe(false)
    expect(labs.labsShown(config({}, 1))).toBe(false)
    expect(labs.tapVersion(1700)).toBe(true)
    expect(labs.labsShown(config({}, 1))).toBe(true)
    expect(labs.tapVersion(1800)).toBe(false)
  })

  it('start over when they are too slow', () => {
    for (let i = 0; i < labs.REVEAL_TAPS - 1; i++) labs.tapVersion(i * 100)
    // The seventh comes after the window: it counts as the first of a new series.
    expect(labs.tapVersion(labs.REVEAL_WINDOW_MS + 1)).toBe(false)
    for (let i = 1; i < labs.REVEAL_TAPS - 1; i++) expect(labs.tapVersion(labs.REVEAL_WINDOW_MS + 1 + i * 100)).toBe(false)
    expect(labs.tapVersion(labs.REVEAL_WINDOW_MS + 1 + (labs.REVEAL_TAPS - 1) * 100)).toBe(true)
  })

  it('show the block in About, saying there is nothing to try, focused and without a toast', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T08:00:00Z'))
    seed({}, 1)
    const s = useAdminStore()
    const wrapper = settings('about')
    await flushPromises()
    const version = wrapper.find('[data-test="version"]')
    // The version text, not a button: no role, but a tab stop for the keyboard path.
    expect(version.element.tagName).toBe('P')
    expect(version.attributes('role')).toBeUndefined()
    expect(version.attributes('tabindex')).toBe('0')
    for (let i = 0; i < labs.REVEAL_TAPS - 1; i++) await version.trigger('click')
    expect(wrapper.find('[data-test="labs"]').exists()).toBe(false)
    await version.trigger('click')
    await flushPromises()
    const block = wrapper.find('[data-test="labs"]')
    // With no box to focus, the block takes the focus: it scrolls into view and is announced.
    expect(document.activeElement).toBe(block.element)
    expect(s.state.toast).toBe('')
    expect(block.text()).toMatch(/Experimental features|Fonctions expérimentales/)
    expect(wrapper.find('[data-test="labs-none"]').text()).toMatch(/No experimental features right now|Aucune fonction expérimentale/)
    // Neither iPad pairing nor the companion is behind a switch any more.
    expect(block.findAll('input')).toHaveLength(0)
    expect(block.text()).not.toMatch(/iPad|Fremplay|companion|compagnon/i)
    wrapper.unmount()
  })

  it('can be pressed from the keyboard: seven presses of Enter on the version', async () => {
    seed({}, 1)
    const wrapper = settings('about')
    await flushPromises()
    const version = wrapper.find('[data-test="version"]')
    for (let i = 0; i < labs.REVEAL_TAPS - 1; i++) await version.trigger('keydown', { key: 'Enter' })
    expect(wrapper.find('[data-test="labs"]').exists()).toBe(false)
    await version.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(wrapper.find('[data-test="labs"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('do not count a held Enter: key repeats are ignored', async () => {
    seed({}, 1)
    const wrapper = settings('about')
    await flushPromises()
    const version = wrapper.find('[data-test="version"]')
    await version.trigger('keydown', { key: 'Enter' })
    for (let i = 0; i < 20; i++) await version.trigger('keydown', { key: 'Enter', repeat: true })
    await flushPromises()
    expect(wrapper.find('[data-test="labs"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('a flag in the block, as the next one will be', () => {
  // No flag exists today: this one is given to the pane the way `LAB_FLAGS` will give a real one.
  const FLAG = { key: 'later' as never, label: 'admin.inspector.screen.labs', hint: 'admin.inspector.screen.labs.none' }
  const about = () => mount(AboutPane, { attachTo: document.body, props: { flags: [FLAG] }, global: { stubs } })

  it('renders its box, writes labs[key], keeps the other flags, and undoes', async () => {
    seed({ other: true }, 1)
    const s = useAdminStore()
    const wrapper = about()
    await flushPromises()
    // Shown without the clicks: a flag is on.
    const box = wrapper.find('[data-test="labs-later"] input')
    expect((box.element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.find('[data-test="labs-none"]').exists()).toBe(false)
    await box.setValue(true)
    expect(s.state.config!.labs).toEqual({ other: true, later: true })
    await box.setValue(false)
    expect(s.state.config!.labs).toEqual({ other: true, later: false })
    s.undo()
    expect(s.state.config!.labs).toEqual({ other: true, later: true })
    wrapper.unmount()
  })

  it('takes the focus on the seven clicks, rather than the block', async () => {
    seed({}, 1)
    const wrapper = about()
    await flushPromises()
    const version = wrapper.find('[data-test="version"]')
    for (let i = 0; i < labs.REVEAL_TAPS; i++) await version.trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.find('[data-test="labs-later"] input').element)
    wrapper.unmount()
  })
})
