/**
 * @vitest-environment jsdom
 *
 * "Import a layout…" while iPad screens are an experimental feature that is off: the dialog says
 * before the import that the file's iPad screens will be skipped, and the toast says so after.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { Config, ImportPreview, LayoutFile } from '../src/shared/types'

const readLayout = vi.hoisted(() => vi.fn())
vi.mock('../src/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shared/api')>()
  return { ...actual, api: { ...actual.api, readLayout } }
})

const { default: ShareImportDialog } = await import('../src/admin/ShareImportDialog.vue')
const { useAdminStore } = await import('../src/admin/store')
const { share } = await import('../src/admin/share')

function config(devices: boolean): Config {
  return {
    version: 4, connections: [], secrets: { backend: 'file' }, locale: 'en',
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    labs: { devices },
    widgets: {},
    screens: [{ id: 'edge', name: 'Edge', kind: 'edge', display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 }, nav: [], pages: [{ id: 'home', name: 'Home', items: [] }] }],
  }
}

/** A setup file with the Edge and a tablet, both empty. */
function preview(kinds: ('edge' | 'device')[] = ['edge', 'device']): ImportPreview {
  const screen = (name: string, kind: 'edge' | 'device') => ({
    name, kind, display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 }, nav: [], pages: [{ name: 'Home', items: [] }],
  })
  const layout = { format: 'fremkit-layout', version: 1, scope: 'setup', widgets: {}, catalog: {}, images: {},
    screens: kinds.map((k, i) => screen(k === 'edge' ? `Desk ${i}` : `Tablet ${i}`, k)) } as unknown as LayoutFile
  return {
    layout, shippedBackground: '',
    report: { scope: 'setup', screens: 2, pages: 2, tiles: 0, widgets: [], connections: [], images: [], dropped: { settings: 0, placements: 0, images: 0 } },
  } as unknown as ImportPreview
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
    new Response(init?.body ?? '{"widgets":[],"themes":[],"connections":[],"types":[]}', { headers: { 'content-type': 'application/json' } })))
  readLayout.mockResolvedValue(preview())
  share.importing = { raw: {}, fileName: 'setup.json' }
})

afterEach(async () => {
  const s = useAdminStore()
  await s.flush()
  s.state.config = null
  s.state.toast = ''
  share.importing = null
  vi.unstubAllGlobals()
})

describe('importing a setup with an iPad screen', () => {
  for (const devices of [false, true]) {
    it(`flag ${devices ? 'on: imports it' : 'off: says it skips it, then does'}`, async () => {
      const s = useAdminStore()
      s.state.config = config(devices)
      s.state.manifests = {}
      s.selectScreen('edge')
      const wrapper = mount(ShareImportDialog, { attachTo: document.body })
      await flushPromises()
      expect(wrapper.find('[data-test="devices-skipped"]').exists()).toBe(!devices)
      if (!devices) expect(wrapper.find('[data-test="devices-skipped"]').text()).toMatch(/Experimental features|Fonctions expérimentales/)
      const apply = wrapper.findAll('button').at(-1)!
      await apply.trigger('click')
      await flushPromises()
      expect(s.state.config!.screens.map((x) => x.kind)).toEqual(devices ? ['edge', 'edge', 'device'] : ['edge', 'edge'])
      expect(/Experimental features|Fonctions expérimentales/.test(s.state.toast)).toBe(!devices)
      wrapper.unmount()
    })
  }
})

describe('importing a file with nothing but iPad screens while they are hidden', () => {
  it('imports nothing and says so, rather than "imported"', async () => {
    readLayout.mockResolvedValue(preview(['device']))
    const s = useAdminStore()
    s.state.config = config(false)
    s.state.manifests = {}
    s.selectScreen('edge')
    const before = JSON.stringify(s.state.config!.screens)
    const wrapper = mount(ShareImportDialog, { attachTo: document.body })
    await flushPromises()
    await wrapper.findAll('button').at(-1)!.trigger('click')
    await flushPromises()
    expect(JSON.stringify(s.state.config!.screens)).toBe(before)
    expect(s.state.toast).toMatch(/^(Nothing was imported|Rien n’a été importé)/)
    wrapper.unmount()
  })
})
