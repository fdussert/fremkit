/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import TileIconPicker from '../src/admin/TileIconPicker.vue'
import { useAdminStore } from '../src/admin/store'
import type { Config, WidgetManifest } from '../src/shared/types'

const MANIFEST = {
  id: 'clock', name: { fr: 'Horloge', en: 'Clock' }, version: '1.0.0', sdk: 1, icon: 'clock',
  minSize: [8, 4], defaultSize: [16, 4], subscriptions: [], commands: [], settingsSchema: {}, permissions: { network: [] },
} as unknown as WidgetManifest

function config(): Config {
  return {
    version: 3, locale: 'en',
    display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 },
    connections: [], secrets: { backend: 'file' },
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    pages: [{ id: 'home', name: 'Home', widgets: [
      { instanceId: 'c-1', widgetId: 'clock', x: 0, y: 0, w: 16, h: 4, showTitle: true, settings: {} },
      { instanceId: 'c-2', widgetId: 'clock', x: 16, y: 0, w: 16, h: 4, showTitle: true, settings: {}, icon: { kind: 'file', name: '1-nas.svg' } },
    ] }],
  } as unknown as Config
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/tile-icons' && !init?.method) return Response.json({ names: ['1-nas.svg'] })
    if (url.startsWith('/api/tile-icons/') && init?.method === 'DELETE') return Response.json({ ok: true })
    // The store's debounced save: echo the config back, as the server does.
    if (url === '/api/config' && init?.method === 'PUT') return new Response(init.body as string, { headers: { 'content-type': 'application/json' } })
    return Response.json({})
  })
  vi.stubGlobal('fetch', fetchMock)
  const s = useAdminStore()
  s.state.config = config()
  s.state.pageIndex = 0
})
afterEach(() => { vi.unstubAllGlobals() })

const tile = (id: string) => useAdminStore().state.config!.pages[0].widgets.find((w) => w.instanceId === id)!
const mountFor = (id: string, manifest: WidgetManifest | undefined = MANIFEST) =>
  mount(TileIconPicker, { props: { instance: tile(id), manifest }, attachTo: document.body })

describe('the Icon field', () => {
  it('adds the suggested pictogram in one tap and opens the picker', async () => {
    const w = mountFor('c-1')
    await w.find('[data-action="add"]').trigger('click')
    await flushPromises()
    expect(tile('c-1').icon).toEqual({ kind: 'lucide', name: 'clock' })
    expect(w.find('.picker').exists()).toBe(true)
  })
  it('only opens the picker when the manifest suggests nothing choosable', async () => {
    const w = mountFor('c-1', { ...MANIFEST, icon: 'github' } as WidgetManifest)
    await w.find('[data-action="add"]').trigger('click')
    await flushPromises()
    expect(tile('c-1').icon).toBeUndefined()
    expect(w.find('.picker').exists()).toBe(true)
  })
  it('is disabled while the title is hidden', () => {
    tile('c-1').showTitle = false
    const w = mountFor('c-1')
    expect(w.find('[data-action="add"]').exists()).toBe(false)
    // Either language: the admin's locale follows the config, applied by a watcher.
    expect(w.text()).toMatch(/title|titre/i)
  })
  it('switches a file between tinted and its own colours', async () => {
    const w = mountFor('c-2')
    await w.find('[data-action="change"]').trigger('click')
    await flushPromises()
    await w.find('.tint input').setValue(false)
    expect(tile('c-2').icon).toEqual({ kind: 'file', name: '1-nas.svg', tint: false })
  })
  it('deletes an imported icon on the second tap, clearing it from every tile first', async () => {
    const w = mountFor('c-2')
    await w.find('[data-action="change"]').trigger('click')
    await flushPromises()
    const del = w.find('[data-delete="1-nas.svg"]')
    await del.trigger('click')
    expect(fetchMock).not.toHaveBeenCalledWith('/api/tile-icons/1-nas.svg', expect.objectContaining({ method: 'DELETE' }))
    expect(del.text()).toMatch(/1/)
    await del.trigger('click')
    await flushPromises()
    expect(tile('c-2').icon).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('/api/tile-icons/1-nas.svg', expect.objectContaining({ method: 'DELETE' }))
  })
  it('shows a referenced file that is no longer in the library as missing', async () => {
    tile('c-2').icon = { kind: 'file', name: '9-gone.svg' }
    const w = mountFor('c-2')
    await w.find('[data-action="change"]').trigger('click')
    await flushPromises()
    expect(w.find('.missing').exists()).toBe(true)
  })
})
