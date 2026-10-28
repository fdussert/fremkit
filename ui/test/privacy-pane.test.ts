/**
 * @vitest-environment jsdom
 *
 * The Privacy pane's WSL section: shown on Windows only, one box per installed distribution (and
 * per ticked one that is no longer installed, so it can still be unticked), saved like every other
 * privacy switch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { Config } from '../src/shared/types'

const wslApi = vi.hoisted(() => ({ getWslDistros: vi.fn() }))
vi.mock('../src/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shared/api')>()
  return { ...actual, api: { ...actual.api, ...wslApi } }
})

const { default: PrivacyPane } = await import('../src/admin/settings/PrivacyPane.vue')
const { useAdminStore } = await import('../src/admin/store')
const { setLocale } = await import('../src/shared/i18n')

function config(wslDistros: string[] = []): Config {
  return {
    version: 4,
    connections: [], secrets: { backend: 'file' }, locale: 'en',
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false, wslDistros },
    labs: { devices: false },
    widgets: {},
    screens: [
      { id: 'edge', name: 'Edge', kind: 'edge', display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 }, nav: [], pages: [{ id: 'home', name: 'Home', items: [] }] },
    ],
  }
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  setLocale('en')
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    new Response(init?.body ?? '{}', { headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  wslApi.getWslDistros.mockReset()
  const s = useAdminStore()
  s.state.config = config()
})

afterEach(async () => {
  const s = useAdminStore()
  await s.flush()
  s.state.config = null
  vi.unstubAllGlobals()
})

const wslBoxes = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('.wsl-distros input[type="checkbox"]')

describe('the Privacy pane on Windows', () => {
  it('lists the installed distributions, none ticked by default', async () => {
    wslApi.getWslDistros.mockResolvedValue({ platform: 'win32', distros: ['Ubuntu-24.04', 'Debian'] })
    const wrapper = mount(PrivacyPane)
    await flushPromises()
    const boxes = wslBoxes(wrapper)
    expect(boxes).toHaveLength(2)
    expect(wrapper.find('.wsl-distros').text()).toContain('Ubuntu-24.04')
    expect(boxes.every((b) => !(b.element as HTMLInputElement).checked)).toBe(true)
    wrapper.unmount()
  })

  it('saves the ticked names through the config', async () => {
    wslApi.getWslDistros.mockResolvedValue({ platform: 'win32', distros: ['Ubuntu-24.04', 'Debian'] })
    const wrapper = mount(PrivacyPane)
    await flushPromises()
    await wslBoxes(wrapper)[1].setValue(true)
    const s = useAdminStore()
    expect(s.state.config!.privacy.wslDistros).toEqual(['Debian'])
    await s.flush()
    const put = fetchMock.mock.calls.find(([url, init]) => url === '/api/config' && (init as RequestInit | undefined)?.method === 'PUT')
    expect(put).toBeDefined()
    expect(JSON.parse(String((put![1] as RequestInit).body)).privacy.wslDistros).toEqual(['Debian'])
    await wslBoxes(wrapper)[1].setValue(false)
    expect(s.state.config!.privacy.wslDistros).toEqual([])
    wrapper.unmount()
  })

  it('still offers a ticked distribution that is no longer installed, so it can be unticked', async () => {
    useAdminStore().state.config = config(['Old'])
    wslApi.getWslDistros.mockResolvedValue({ platform: 'win32', distros: ['Ubuntu'] })
    const wrapper = mount(PrivacyPane)
    await flushPromises()
    const boxes = wslBoxes(wrapper)
    expect(boxes).toHaveLength(2)
    expect((boxes[1].element as HTMLInputElement).checked).toBe(true)
    wrapper.unmount()
  })
})

describe('the Privacy pane at the limit', () => {
  it('disables the unticked boxes once 16 are ticked, and says why', async () => {
    const names = Array.from({ length: 18 }, (_, i) => `d${i}`)
    useAdminStore().state.config = config(names.slice(0, 16))
    wslApi.getWslDistros.mockResolvedValue({ platform: 'win32', distros: names })
    const wrapper = mount(PrivacyPane)
    await flushPromises()
    const boxes = wslBoxes(wrapper).map((b) => b.element as HTMLInputElement)
    expect(boxes.slice(0, 16).every((b) => b.checked && !b.disabled)).toBe(true)
    expect(boxes.slice(16).every((b) => !b.checked && b.disabled)).toBe(true)
    expect(wrapper.find('.wsl-distros').text()).toContain('At most 16 distributions')
    // Unticking one frees a place.
    await wslBoxes(wrapper)[0].setValue(false)
    expect(useAdminStore().state.config!.privacy.wslDistros).toHaveLength(15)
    expect((wslBoxes(wrapper)[16].element as HTMLInputElement).disabled).toBe(false)
    expect(wrapper.find('.wsl-distros').text()).not.toContain('At most 16 distributions')
    wrapper.unmount()
  })
})

describe('the Privacy pane elsewhere', () => {
  it('renders no WSL section on a Mac', async () => {
    wslApi.getWslDistros.mockResolvedValue({ platform: 'darwin', distros: [] })
    const wrapper = mount(PrivacyPane)
    await flushPromises()
    expect(wrapper.find('.wsl-distros').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('WSL')
    wrapper.unmount()
  })

  it('renders no WSL section when the server cannot say', async () => {
    wslApi.getWslDistros.mockRejectedValue(new Error('HTTP 500'))
    const wrapper = mount(PrivacyPane)
    await flushPromises()
    expect(wrapper.find('.wsl-distros').exists()).toBe(false)
    wrapper.unmount()
  })
})
