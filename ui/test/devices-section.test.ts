/**
 * @vitest-environment jsdom
 *
 * The Devices section, rendered against a mocked device api: the switch, the code while pairing
 * is open, the per-device screen picker, a screen made at a device's size, and the warning a
 * screen's removal gives about the devices showing it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { DeviceStatus, PublicDevice, PublicExtensionDevice, PublicIpadDevice } from '../src/shared/api'
import type { Config } from '../src/shared/types'

const device = (over: Partial<PublicIpadDevice> = {}): PublicDevice => ({
  id: 'dev-1', kind: 'ipad', name: 'Kitchen iPad', pairedAt: '2026-10-01T08:00:00.000Z', lastSeen: null,
  viewport: { width: 1376, height: 1032 }, screenId: null, ...over,
})
const extension = (over: Partial<PublicExtensionDevice> = {}): PublicDevice => ({
  id: 'ext-1', kind: 'extension', name: 'Chrome', pairedAt: '2026-10-02T08:00:00.000Z', lastSeen: null,
  origin: `chrome-extension://${'a'.repeat(32)}`, installId: '3a9c1d2e-5b6f-4a7b-8c9d-0e1f2a3b4c5d', connected: false, ...over,
})
const status = (over: Partial<DeviceStatus> = {}): DeviceStatus => ({
  enabled: false, listening: false, error: null, guessing: false, host: 'mac.example.local',
  addresses: ['192.0.2.10'], port: 4243, keyHash: null, fingerprint: null, devices: [], companionRequest: null, ...over,
})

const deviceApi = vi.hoisted(() => ({
  getDevices: vi.fn(),
  setDevicesEnabled: vi.fn(),
  newPairingCode: vi.fn(),
  patchDevice: vi.fn(),
  refuseCompanion: vi.fn(),
  unlockCompanion: vi.fn(),
  deleteDevice: vi.fn(),
  deleteAllDevices: vi.fn(),
  resetDeviceCertificate: vi.fn(),
}))
vi.mock('../src/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shared/api')>()
  return { ...actual, api: { ...actual.api, ...deviceApi } }
})

const { default: DevicesSection } = await import('../src/admin/DevicesSection.vue')
const { default: ScreenPane } = await import('../src/admin/settings/ScreenPane.vue')
const { useDevices } = await import('../src/admin/devices')
const { useAdminStore } = await import('../src/admin/store')

function config(): Config {
  return {
    version: 4,
    connections: [], secrets: { backend: 'file' }, locale: 'en',
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    labs: { devices: true, companion: true },
    widgets: {},
    screens: [
      { id: 'edge', name: 'Edge', kind: 'edge', display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 }, nav: [], pages: [{ id: 'home', name: 'Home', items: [] }] },
      { id: 'kitchen', name: 'Kitchen', kind: 'device', display: { cols: 34, rows: 24, cell: 40, autoCycleSeconds: 0, navHeight: 40, viewport: { width: 1376, height: 1032 }, orientation: 'landscape' }, nav: [], pages: [{ id: 'home', name: 'Home', items: [] }] },
    ],
  }
}

const stubs = { PageView: { template: '<div class="page-stub" />' } }

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) =>
    new Response(url === '/api/themes' ? '{"themes":{},"errors":[]}' : init?.body ?? '{}',
      { headers: { 'content-type': 'application/json' } })))
  for (const fn of Object.values(deviceApi)) fn.mockReset()
  deviceApi.getDevices.mockResolvedValue(status())
  deviceApi.newPairingCode.mockResolvedValue({ code: 'ABCD2345', expiresAt: Date.now() + 300_000, url: 'fremkit://pair?p=4243&c=ABCD2345&k=x' })
  deviceApi.patchDevice.mockImplementation(async (id: string, patch: { screenId?: string | null }) => device({ id, screenId: patch.screenId ?? null }))
  const d = useDevices()
  d.status.value = null
  d.offer.value = null
  d.error.value = ''
  d.pollError.value = ''
  const s = useAdminStore()
  s.state.config = config()
  s.state.manifests = {}
  s.selectScreen('edge')
})

afterEach(async () => {
  const s = useAdminStore()
  await s.flush()
  s.state.config = null
  vi.unstubAllGlobals()
})

describe('the devices section', () => {
  it('turns pairing on, then shows a code and its QR', async () => {
    deviceApi.setDevicesEnabled.mockResolvedValue(status({ enabled: true, listening: true, fingerprint: ['aardvark', 'absurd', 'woodlark', 'zulu'] }))
    const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    expect(wrapper.find('[data-test="pairing-code"]').exists()).toBe(false)
    await wrapper.find('input[type="checkbox"]').setValue(true)
    await flushPromises()
    expect(deviceApi.setDevicesEnabled).toHaveBeenCalledWith(true)
    expect(deviceApi.newPairingCode).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-test="pairing-code"]').text()).toBe('ABCD2345')
    expect(wrapper.find('.qr svg').exists()).toBe(true)
    expect(wrapper.find('[data-test="fingerprint"]').text()).toBe('Fingerprint: aardvark absurd woodlark zulu')
    expect(wrapper.text()).toContain('If the iPad shows these words, it is this Mac.')
    expect(wrapper.text()).not.toContain('Someone is trying')
    wrapper.unmount()
  })

  describe('which parts show', () => {
    const REQUEST = () => ({ requestId: 'r1', code: 'K7M2', name: 'Chrome', expiresAt: Date.now() + 60_000 })
    async function mountWith(labs: { devices: boolean; companion: boolean }, answer: DeviceStatus) {
      useAdminStore().state.config = { ...config(), labs }
      deviceApi.getDevices.mockResolvedValue(answer)
      const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
      await flushPromises()
      return wrapper
    }
    const ipadPart = (w: Awaited<ReturnType<typeof mountWith>>) => w.find('input[type="checkbox"]').exists()
    const extPart = (w: Awaited<ReturnType<typeof mountWith>>) => w.find('[data-test="extensions"]').exists()

    it('both flags off: an extension paired keeps its row, with rename and remove, but no request card and no iPad part', async () => {
      const w = await mountWith({ devices: false, companion: false }, status({ devices: [extension()], companionRequest: REQUEST() }))
      expect(extPart(w)).toBe(true)
      expect(w.find('[data-test="extension-name"]').exists()).toBe(true)
      expect(w.find('[data-test="extension-remove"]').exists()).toBe(true)
      expect(w.find('[data-test="companion-request"]').exists()).toBe(false)
      expect(ipadPart(w)).toBe(false)
      expect(w.find('[data-test="ipads-none"]').exists()).toBe(false)
      expect(w.find('[data-test="extensions-none"]').exists()).toBe(false)
      w.unmount()
    })

    it('only labs.companion on: the extension part with its request card and empty state, no iPad controls', async () => {
      const w = await mountWith({ devices: false, companion: true }, status({ companionRequest: REQUEST() }))
      expect(extPart(w)).toBe(true)
      expect(w.find('[data-test="companion-request"]').exists()).toBe(true)
      expect(w.find('[data-test="extensions-none"]').text()).toBe('No browser extension linked.')
      expect(ipadPart(w)).toBe(false)
      expect(w.find('[data-test="pairing-code"]').exists()).toBe(false)
      expect(w.text()).not.toContain('No paired iPad')
      w.unmount()
    })

    it('only labs.devices on: the iPad part, as on main, and no extension part', async () => {
      const w = await mountWith({ devices: true, companion: false }, status({ companionRequest: REQUEST() }))
      expect(ipadPart(w)).toBe(true)
      expect(w.find('[data-test="ipads-none"]').text()).toBe('No paired iPad.')
      expect(extPart(w)).toBe(false)
      expect(w.find('[data-test="companion-request"]').exists()).toBe(false)
      w.unmount()
    })

    it('both flags off: iPad pairing in use shows the iPad part, the listener on or an iPad paired', async () => {
      for (const answer of [status({ enabled: true }), status({ devices: [device()] })]) {
        const w = await mountWith({ devices: false, companion: false }, answer)
        expect(ipadPart(w)).toBe(true)
        expect(extPart(w)).toBe(false)
        w.unmount()
      }
    })

    it('each part has its own empty state, never beside a listed device of the other kind', async () => {
      const w = await mountWith({ devices: true, companion: true }, status({ devices: [device()] }))
      expect(w.find('[data-test="ipads-none"]').exists()).toBe(false)
      expect(w.find('[data-test="extensions-none"]').exists()).toBe(true)
      w.unmount()
      const x = await mountWith({ devices: true, companion: true }, status({ devices: [extension()] }))
      expect(x.find('[data-test="extensions-none"]').exists()).toBe(false)
      expect(x.find('[data-test="ipads-none"]').exists()).toBe(true)
      expect(x.text()).not.toContain('No paired device')
      x.unmount()
    })

    it('a part stays while the pane is open after its last device goes, until its flag turns off', async () => {
      const w = await mountWith({ devices: false, companion: false }, status({ devices: [extension()] }))
      expect(extPart(w)).toBe(true)
      useDevices().status.value = status()
      await flushPromises()
      expect(extPart(w)).toBe(true)
      expect(w.find('[data-test="extensions-none"]').exists()).toBe(true)
      // On, then off again: the rule is read anew, and nothing is paired any more.
      const s = useAdminStore()
      s.state.config = { ...config(), labs: { devices: false, companion: true } }
      await flushPromises()
      s.state.config = { ...config(), labs: { devices: false, companion: false } }
      await flushPromises()
      expect(extPart(w)).toBe(false)
      w.unmount()
    })

    it('Remove every iPad and the certificate reset are the iPad part\'s: an extension alone leaves Remove every iPad off', async () => {
      const w = await mountWith({ devices: true, companion: true }, status({ devices: [extension()] }))
      const removeAll = w.findAll('button').find((b) => b.text() === 'Remove every iPad')
      expect(removeAll).toBeDefined()
      expect(removeAll?.attributes('disabled')).toBeDefined()
      expect(w.text()).toContain('Browser extensions stay linked.')
      w.unmount()
      const x = await mountWith({ devices: true, companion: true }, status({ devices: [extension(), device()] }))
      expect(x.findAll('button').find((b) => b.text() === 'Remove every iPad')?.attributes('disabled')).toBeUndefined()
      x.unmount()
    })

    it('turning labs.companion on brings the request card without a reload', async () => {
      const w = await mountWith({ devices: false, companion: false }, status({ devices: [extension()], companionRequest: REQUEST() }))
      expect(w.find('[data-test="companion-request"]').exists()).toBe(false)
      useAdminStore().state.config = { ...config(), labs: { devices: false, companion: true } }
      await flushPromises()
      expect(w.find('[data-test="companion-request"]').exists()).toBe(true)
      w.unmount()
    })
  })

  it('lists an extension with no screen picker, and removes it', async () => {
    deviceApi.getDevices.mockResolvedValue(status({ devices: [extension({ connected: true })] }))
    deviceApi.deleteDevice.mockResolvedValue(undefined)
    const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    const row = wrapper.find('[data-test="extension"]')
    expect((row.find('[data-test="extension-name"]').element as HTMLInputElement).value).toBe('Chrome')
    expect(row.find('[data-test="extension-connected"]').text()).toBe('connected')
    expect(row.find('select').exists()).toBe(false)
    expect(row.text()).toContain('Paired')
    expect(wrapper.find('[data-test="extensions-none"]').exists()).toBe(false)
    await row.find('[data-test="extension-remove"]').trigger('click')
    await row.find('[data-test="extension-remove"]').trigger('click')
    await flushPromises()
    expect(deviceApi.deleteDevice).toHaveBeenCalledWith('ext-1')
    wrapper.unmount()
  })

  it('does not say connected for an extension whose socket is closed', async () => {
    deviceApi.getDevices.mockResolvedValue(status({ devices: [extension()] }))
    const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    expect(wrapper.find('[data-test="extension-connected"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows extensions and the request card while the network switch is off', async () => {
    deviceApi.getDevices.mockResolvedValue(status({
      enabled: false, listening: false, devices: [extension()],
      companionRequest: { requestId: 'req-1', code: 'AB2C', name: 'Chrome on Mac', expiresAt: Date.now() + 60_000 },
    }))
    const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    expect(wrapper.find('[data-test="extension"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="request-code"]').text()).toBe('AB2C')
    expect(wrapper.find('[data-test="request-name"]').text()).toBe('Chrome on Mac')
    expect(wrapper.find('[data-test="pairing-code"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows the short id of the asking extension, and of each linked one', async () => {
    deviceApi.getDevices.mockResolvedValue(status({
      devices: [extension({ origin: 'chrome-extension://lnckeodobpbbmfbdlpnegjpchgkehdlk' })],
      companionRequest: { requestId: 'req-1', code: 'AB2C', name: 'Chrome', extension: 'abcdef', expiresAt: Date.now() + 60_000 },
    }))
    const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    expect(wrapper.find('[data-test="request-extension"]').text()).toBe('extension abcdef…')
    expect(wrapper.find('[data-test="extension-id"]').text()).toBe('extension lnckeo…')
    wrapper.unmount()
  })

  it('offers Unlock pairing while pairing is locked, and calls it', async () => {
    deviceApi.getDevices.mockResolvedValue(status({ devices: [extension()], companionLocked: true }))
    deviceApi.unlockCompanion.mockResolvedValue(undefined)
    const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    expect(wrapper.find('[data-test="companion-locked"]').text()).toContain('Pairing locked after too many wrong codes')
    deviceApi.getDevices.mockResolvedValue(status({ devices: [extension()], companionLocked: false }))
    await wrapper.find('[data-test="companion-unlock"]').trigger('click')
    await flushPromises()
    expect(deviceApi.unlockCompanion).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-test="companion-locked"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('hides the request card, code included, while the server does not answer', async () => {
    deviceApi.getDevices.mockResolvedValue(status({
      companionRequest: { requestId: 'req-1', code: 'AB2C', name: 'Chrome', expiresAt: Date.now() + 60_000 },
    }))
    const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    expect(wrapper.find('[data-test="request-code"]').text()).toBe('AB2C')
    deviceApi.getDevices.mockRejectedValue(new Error('Fremkit is not answering'))
    await useDevices().refresh()
    await flushPromises()
    expect(wrapper.find('[data-test="companion-request"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('AB2C')
    wrapper.unmount()
  })

  it('shows the code to type in the browser, and only Refuse', async () => {
    deviceApi.getDevices.mockResolvedValue(status({
      companionRequest: { requestId: 'req-1', code: 'AB2C', name: 'Chrome', expiresAt: Date.now() + 60_000 },
    }))
    deviceApi.refuseCompanion.mockResolvedValue(undefined)
    const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    expect(wrapper.find('[data-test="request-type"]').text()).toBe('Type this code in your browser')
    expect(wrapper.find('[data-test="request-approve"]').exists()).toBe(false)
    await wrapper.find('[data-test="request-refuse"]').trigger('click')
    await flushPromises()
    expect(deviceApi.refuseCompanion).toHaveBeenCalledWith('req-1', 'AB2C')
    wrapper.unmount()
  })

  it('hides a request that has expired', async () => {
    deviceApi.getDevices.mockResolvedValue(status({
      companionRequest: { requestId: 'req-1', code: 'AB2C', name: 'Chrome', expiresAt: Date.now() - 1 },
    }))
    const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    expect(wrapper.find('[data-test="companion-request"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('renames an extension with PATCH name, and ignores an emptied name', async () => {
    deviceApi.getDevices.mockResolvedValue(status({ devices: [extension()] }))
    deviceApi.patchDevice.mockResolvedValue(extension({ name: 'Work Chrome' }))
    const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    const input = wrapper.find('[data-test="extension-name"]')
    await input.setValue('  ')
    await input.trigger('change')
    expect(deviceApi.patchDevice).not.toHaveBeenCalled()
    expect((input.element as HTMLInputElement).value).toBe('Chrome')
    await input.setValue('Work Chrome')
    await input.trigger('change')
    await flushPromises()
    expect(deviceApi.patchDevice).toHaveBeenCalledWith('ext-1', { name: 'Work Chrome' })
    wrapper.unmount()
  })

  it('says the port is taken and stays off', async () => {
    deviceApi.getDevices.mockResolvedValue(status({ error: 'portInUse' }))
    const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    expect(wrapper.find('[data-test="port-in-use"]').text()).toContain('Port 4243 is already used')
    expect((wrapper.find('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false)
    expect(deviceApi.newPairingCode).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('warns while someone is guessing codes', async () => {
    deviceApi.getDevices.mockResolvedValue(status({ enabled: true, listening: true, guessing: true }))
    const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    expect(wrapper.text()).toContain('Someone is trying random codes: the code is blocked for a minute.')
    wrapper.unmount()
  })

  it('attaches a device to the screen picked for it', async () => {
    deviceApi.getDevices.mockResolvedValue(status({ devices: [device({ screenId: 'kitchen' })] }))
    const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    const select = wrapper.find('[data-test="device"] select')
    // Device screens only, and "No screen".
    expect(select.findAll('option').map((o) => o.text())).toEqual(['No screen', 'Kitchen'])
    await select.setValue('')
    await flushPromises()
    expect(deviceApi.patchDevice).toHaveBeenCalledWith('dev-1', { screenId: null })
    wrapper.unmount()
  })

  it('attaches a picked screen only once a pending config save has landed', async () => {
    deviceApi.getDevices.mockResolvedValue(status({ devices: [device()] }))
    let land!: () => void
    const saved = new Promise<void>((resolve) => { land = resolve })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/config' && init?.method === 'PUT') await saved
      return new Response(init?.body ?? '{}', { headers: { 'content-type': 'application/json' } })
    }))
    const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    // An edit still waiting for its debounced save.
    useAdminStore().renameScreen('kitchen', 'Kitchen wall')
    await wrapper.find('[data-test="device"] select').setValue('kitchen')
    await flushPromises()
    expect(deviceApi.patchDevice).not.toHaveBeenCalled()
    land()
    await flushPromises()
    expect(deviceApi.patchDevice).toHaveBeenCalledWith('dev-1', { screenId: 'kitchen' })
    wrapper.unmount()
  })

  it('makes a screen at a device’s size and attaches the device to it', async () => {
    deviceApi.getDevices.mockResolvedValue(status({ devices: [device()] }))
    const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    expect(wrapper.text()).toContain('This iPad has no screen')
    await wrapper.find('[data-test="create-screen"]').trigger('click')
    expect((document.querySelector('form input') as HTMLInputElement).value).toBe('Kitchen iPad')
    expect(document.querySelector('[data-test="device-size"]')!.textContent).toBe('1376 × 1032 px')
    const add = [...document.querySelectorAll('form button')].find((b) => b.textContent?.trim() === 'Add') as HTMLButtonElement
    add.click()
    await flushPromises()
    const s = useAdminStore()
    expect(s.state.config!.screens[2]).toMatchObject({ id: 'kitchen-ipad', kind: 'device' })
    expect(deviceApi.patchDevice).toHaveBeenCalledWith('dev-1', { screenId: 'kitchen-ipad' })
    expect(document.querySelector('form')).toBeNull()
    wrapper.unmount()
  })

  it('attaches the device only once the new screen is saved', async () => {
    deviceApi.getDevices.mockResolvedValue(status({ devices: [device()] }))
    // The config save is held until the test lets it land, as a slow server would.
    let land!: () => void
    const saved = new Promise<void>((resolve) => { land = resolve })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/config' && init?.method === 'PUT') await saved
      return new Response(init?.body ?? '{}', { headers: { 'content-type': 'application/json' } })
    }))
    const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    await wrapper.find('[data-test="create-screen"]').trigger('click')
    const add = [...document.querySelectorAll('form button')].find((b) => b.textContent?.trim() === 'Add') as HTMLButtonElement
    add.click()
    await flushPromises()
    expect(useAdminStore().state.config!.screens[2]?.id).toBe('kitchen-ipad')
    expect(deviceApi.patchDevice).not.toHaveBeenCalled()
    land()
    await flushPromises()
    expect(deviceApi.patchDevice).toHaveBeenCalledWith('dev-1', { screenId: 'kitchen-ipad' })
    wrapper.unmount()
  })

  it('keeps a failed action’s error through a successful poll, until dismissed', async () => {
    deviceApi.getDevices.mockResolvedValue(status({ devices: [device()] }))
    deviceApi.deleteDevice.mockRejectedValue(new Error('unknown device'))
    const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    const remove = () => wrapper.find('[data-test="device"]').findAll('button').find((b) => /Remove|Confirm/.test(b.text()))!
    await remove().trigger('click')
    await remove().trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="action-error"]').text()).toContain('unknown device')
    await useDevices().refresh()
    await flushPromises()
    expect(deviceApi.getDevices.mock.calls.length).toBeGreaterThan(1)
    expect(wrapper.find('[data-test="action-error"]').text()).toContain('unknown device')
    await wrapper.find('[data-test="action-error"] button').trigger('click')
    expect(wrapper.find('[data-test="action-error"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('removes a device on the second tap only', async () => {
    deviceApi.getDevices.mockResolvedValue(status({ devices: [device()] }))
    deviceApi.deleteDevice.mockResolvedValue(undefined)
    const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    const remove = () => wrapper.find('[data-test="device"]').findAll('button').find((b) => /Remove|Confirm/.test(b.text()))!
    await remove().trigger('click')
    expect(deviceApi.deleteDevice).not.toHaveBeenCalled()
    expect(remove().text()).toBe('Confirm?')
    await remove().trigger('click')
    await flushPromises()
    expect(deviceApi.deleteDevice).toHaveBeenCalledWith('dev-1')
    wrapper.unmount()
  })
})

describe('removing a screen', () => {
  it('names the devices showing it', async () => {
    deviceApi.getDevices.mockResolvedValue(status({ devices: [device({ screenId: 'kitchen' })] }))
    const s = useAdminStore()
    s.selectScreen('kitchen')
    const wrapper = mount(ScreenPane, {
      attachTo: document.body,
      global: { stubs: { ...stubs, DevicesSection: true, NavWidgetsEditor: true, BackgroundPicker: true } },
    })
    await flushPromises()
    await wrapper.findAll('button').find((b) => b.text() === 'Delete this screen')!.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="remove-devices"]').text()).toBe('These devices will be left without a screen: Kitchen iPad.')
    wrapper.unmount()
  })
})
