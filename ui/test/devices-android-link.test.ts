/**
 * @vitest-environment jsdom
 *
 * The Android download link of the Devices section: shown with the rest of the tablet part, under
 * the same rule (`showsIpads`), pointing at the stable name of the newest release's APK, and
 * found by the settings search.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { DeviceStatus } from '../src/shared/api'
import type { Config } from '../src/shared/types'

const status = (over: Partial<DeviceStatus> = {}): DeviceStatus => ({
  enabled: false, listening: false, error: null, guessing: false, host: 'mac.example.local',
  addresses: ['192.0.2.10'], port: 4243, keyHash: null, fingerprint: null, devices: [], companionRequest: null, ...over,
})

const deviceApi = vi.hoisted(() => ({
  getDevices: vi.fn(),
  newPairingCode: vi.fn(),
}))
vi.mock('../src/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shared/api')>()
  return { ...actual, api: { ...actual.api, ...deviceApi } }
})

const { default: DevicesSection } = await import('../src/admin/DevicesSection.vue')
const { useDevices } = await import('../src/admin/devices')
const { useAdminStore } = await import('../src/admin/store')
const { searchSettings } = await import('../src/admin/settingsWindow')
const { en } = await import('../src/shared/locales/en')
const { fr } = await import('../src/shared/locales/fr')

function config(devices: boolean): Config {
  return {
    version: 4,
    connections: [], secrets: { backend: 'file' }, locale: 'en',
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    labs: { devices, companion: false },
    widgets: {},
    screens: [
      { id: 'edge', name: 'Edge', kind: 'edge', display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 }, nav: [], pages: [{ id: 'home', name: 'Home', items: [] }] },
    ],
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })))
  for (const fn of Object.values(deviceApi)) fn.mockReset()
  deviceApi.getDevices.mockResolvedValue(status())
  const d = useDevices()
  d.status.value = null
  d.offer.value = null
  d.error.value = ''
  d.pollError.value = ''
})

afterEach(async () => {
  const s = useAdminStore()
  await s.flush()
  s.state.config = null
  vi.unstubAllGlobals()
})

describe('the Android download link', () => {
  it('points at the newest release’s APK and opens outside the admin', async () => {
    useAdminStore().state.config = config(true)
    const w = mount(DevicesSection)
    await flushPromises()
    const a = w.get('[data-test="android-apk"]')
    expect(a.attributes('href')).toBe('https://github.com/fdussert/fremkit/releases/latest/download/Fremkit-Android.apk')
    expect(a.attributes('target')).toBe('_blank')
    expect(a.attributes('rel')).toContain('noopener')
    expect(a.text()).toBe(en['admin.devices.androidApk'])
    w.unmount()
  })

  it('stays hidden with the tablet part while tablets are off and nothing is paired', async () => {
    useAdminStore().state.config = config(false)
    const w = mount(DevicesSection)
    await flushPromises()
    expect(w.find('[data-test="android-apk"]').exists()).toBe(false)
    w.unmount()
  })

  it('is found by the settings search, in both languages', () => {
    expect(searchSettings('android', (k) => en[k] ?? k)?.get('devices')?.has('screen.devices')).toBe(true)
    expect(searchSettings('android', (k) => fr[k] ?? k)?.get('devices')?.has('screen.devices')).toBe(true)
  })
})
