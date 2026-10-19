/**
 * @vitest-environment jsdom
 *
 * Day and night themes: which id the page paints, that the first paint is already the night
 * theme at night, that the `theme` channel switches it live (with a crossfade where the browser
 * has one), and the admin's controls under the theme picker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import type { Config, ThemeInForce, ThemesResponse } from '../src/shared/types'

const themeInfo = (id: string, variables: Record<string, string>) =>
  ({ id, name: id, version: '1.0.0', tokens: {}, variables })
const CATALOG = {
  fremkit: themeInfo('fremkit', { '--accent': '#d9b36a', '--bg': '#0b0d10' }),
  edge: themeInfo('edge', { '--accent': '#ffae42', '--bg': '#1b2026' }),
}

function config(extra: Partial<Config> = {}): Config {
  return {
    version: 4,
    theme: 'fremkit',
    connections: [], secrets: { backend: 'file' }, locale: 'en',
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    widgets: {},
    screens: [{
      id: 'edge', name: 'Edge', kind: 'edge',
      display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 },
      nav: [], pages: [{ id: 'home', name: 'Home', items: [] }],
    }],
    ...extra,
  } as Config
}

const night: ThemeInForce = { id: 'edge', phase: 'night', scheduled: true, next: { at: '2026-10-19T05:12:00.000Z', to: 'day' } }
const day: ThemeInForce = { id: 'fremkit', phase: 'day', scheduled: true, next: { at: '2026-10-19T16:40:00.000Z', to: 'night' } }

function serve(inForce?: ThemeInForce): void {
  const body: ThemesResponse = { themes: CATALOG, errors: [], ...(inForce ? { inForce } : {}) }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })))
}

/** A socket whose `theme` channel the test speaks on. */
function fakeSocket() {
  const subs = new Map<string, (data: unknown) => void>()
  return {
    subscribe: (channel: string, cb: (data: unknown) => void) => { subs.set(channel, cb); return () => subs.delete(channel) },
    push: (channel: string, data: unknown) => subs.get(channel)?.(data),
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>((r) => setTimeout(r, 0))
}
const accent = () => document.documentElement.style.getPropertyValue('--accent')
const schedule = { night: 'edge', schedule: 'fixed' as const, dayAt: '07:00', nightAt: '21:00' }

beforeEach(() => { document.documentElement.removeAttribute('style'); document.documentElement.removeAttribute('data-theme-vars') })
afterEach(() => { vi.unstubAllGlobals(); delete (document as { startViewTransition?: unknown }).startViewTransition })

describe('themeIdInForce', () => {
  it('is the night theme only when the config has one and the server says it is night', async () => {
    const { themeIdInForce } = await import('../src/shared/theme')
    expect(themeIdInForce(config(), night)).toBe('fremkit')
    expect(themeIdInForce(config({ themeSchedule: schedule }), night)).toBe('edge')
    expect(themeIdInForce(config({ themeSchedule: schedule }), day)).toBe('fremkit')
    // Not heard from the server yet: the day theme, as today.
    expect(themeIdInForce(config({ themeSchedule: schedule }), null)).toBe('fremkit')
    expect(themeIdInForce(null, night)).toBeUndefined()
  })
})

describe('useConfigTheme with a night theme', () => {
  it('paints the night theme on the first paint at night, never the day one first', async () => {
    vi.resetModules()
    const { useConfigTheme } = await import('../src/shared/theme')
    serve(night)
    const seen: string[] = []
    const observer = new MutationObserver(() => seen.push(accent()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    useConfigTheme(ref(config({ themeSchedule: schedule })))
    await settle()
    observer.disconnect()
    expect(accent()).toBe('#ffae42')
    expect(seen.filter(Boolean)).not.toContain('#d9b36a')
  })

  it('switches a paired device, whose config names only the night theme, at night', async () => {
    // What `deviceConfigView` sends: the night id and nothing about where or when.
    vi.resetModules()
    const { followThemeSchedule, useConfigTheme } = await import('../src/shared/theme')
    serve(day)
    const socket = fakeSocket()
    followThemeSchedule(socket)
    useConfigTheme(ref(config({ themeSchedule: { night: 'edge' } as Config['themeSchedule'] })))
    await settle()
    expect(accent()).toBe('#d9b36a')
    socket.push('theme', night)
    await settle()
    expect(accent()).toBe('#ffae42')
  })

  it('switches live on the theme channel, through a view transition where there is one', async () => {
    vi.resetModules()
    const { followThemeSchedule, useConfigTheme } = await import('../src/shared/theme')
    serve(day)
    const transition = vi.fn((cb: () => Promise<void> | void) => { void cb() })
    ;(document as { startViewTransition?: unknown }).startViewTransition = transition
    const socket = fakeSocket()
    followThemeSchedule(socket)
    useConfigTheme(ref(config({ themeSchedule: schedule })))
    await settle()
    expect(accent()).toBe('#d9b36a')
    expect(transition).not.toHaveBeenCalled()

    socket.push('theme', night)
    await settle()
    expect(transition).toHaveBeenCalledTimes(1)
    expect(accent()).toBe('#ffae42')

    socket.push('theme', day)
    await settle()
    expect(accent()).toBe('#d9b36a')
  })

  it('repaints at once, with no fade, when the night theme is changed rather than the phase', async () => {
    vi.resetModules()
    const { useConfigTheme } = await import('../src/shared/theme')
    serve(night)
    const transition = vi.fn((cb: () => void) => cb())
    ;(document as { startViewTransition?: unknown }).startViewTransition = transition
    const cfg = ref(config({ themeSchedule: { ...schedule, night: 'fremkit' } }))
    useConfigTheme(cfg)
    await settle()
    expect(accent()).toBe('#d9b36a')
    cfg.value = config({ themeSchedule: schedule })
    await settle()
    expect(accent()).toBe('#ffae42')
    expect(transition).not.toHaveBeenCalled()
  })

  it('ignores a malformed message on the channel', async () => {
    vi.resetModules()
    const { followThemeSchedule, useThemeInForce } = await import('../src/shared/theme')
    const socket = fakeSocket()
    followThemeSchedule(socket)
    socket.push('theme', { phase: 'dusk' })
    socket.push('theme', null)
    expect(useThemeInForce().value).toBeNull()
  })
})

describe('the admin night theme controls', () => {
  beforeEach(() => { serve(night) })

  async function mountIt(cfg: Config) {
    vi.resetModules()
    const { useAdminStore } = await import('../src/admin/store')
    const { default: ThemeSchedule } = await import('../src/admin/ThemeSchedule.vue')
    const s = useAdminStore()
    s.state.config = cfg
    s.state.manifests = {}
    s.selectScreen('edge')
    const wrapper = mount(ThemeSchedule, { attachTo: document.body })
    await flushPromises()
    return { s, wrapper }
  }

  it('turns a night theme on with another theme than the day one, and off again', async () => {
    const { s, wrapper } = await mountIt(config())
    expect(wrapper.find('select').exists()).toBe(false)
    await wrapper.find('input[type="checkbox"]').setValue(true)
    expect(s.state.config!.themeSchedule).toEqual({ night: 'edge', schedule: 'sun', dayAt: '07:00', nightAt: '21:00' })
    expect((wrapper.find('select').element as HTMLSelectElement).value).toBe('edge')
    await wrapper.find('input[type="checkbox"]').setValue(false)
    expect(s.state.config!).not.toHaveProperty('themeSchedule')
    wrapper.unmount()
  })

  it('takes the place a screen brightness already has, and offers it again once changed', async () => {
    const cfg = config()
    cfg.screens[0].brightness = {
      dayNight: { enabled: true, day: 80, night: 30, schedule: 'sun', latitude: 48.8566, longitude: 2.3522, dayAt: '07:00', nightAt: '21:00', rampMinutes: 20 },
      followMac: { enabled: false, scale: 1, offset: 0 },
    }
    const { s, wrapper } = await mountIt(cfg)
    await wrapper.find('input[type="checkbox"]').setValue(true)
    expect(s.state.config!.themeSchedule).toMatchObject({ latitude: 48.8566, longitude: 2.3522 })
    expect(wrapper.find('[data-test="theme-reuse-place"]').exists()).toBe(false)

    s.apply((c) => { c.themeSchedule!.latitude = 51.5072; c.themeSchedule!.longitude = -0.1276 })
    await flushPromises()
    const reuse = wrapper.find('[data-test="theme-reuse-place"]')
    expect(reuse.text()).toBe('Use the place set for the brightness of “Edge”')
    await reuse.trigger('click')
    expect(s.state.config!.themeSchedule).toMatchObject({ latitude: 48.8566, longitude: 2.3522 })
    wrapper.unmount()
  })

  it('says which theme is in force and when the next switch is', async () => {
    const { wrapper } = await mountIt(config({ themeSchedule: schedule }))
    expect(wrapper.find('[data-test="theme-status"]').text()).toMatch(/^Night theme in force · day at \d\d:\d\d$/)
    wrapper.unmount()
  })
})
