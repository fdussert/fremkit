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
/** What the server answers to an upload, and the status of a delete; tests override them. */
let uploadAnswer: string
let deleteStatus: number
beforeEach(() => {
  uploadAnswer = '2-logo.svg'
  deleteStatus = 200
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/tile-icons' && !init?.method) return Response.json({ names: ['1-nas.svg'] })
    if (url === '/api/tile-icons' && init?.method === 'POST') return Response.json({ name: uploadAnswer }, { status: 201 })
    if (url.startsWith('/api/tile-icons/') && init?.method === 'DELETE') {
      return deleteStatus === 200 ? Response.json({ ok: true }) : Response.json({ error: `refused ${deleteStatus}` }, { status: deleteStatus })
    }
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
/** Opens the picker on c-2, which wears the imported file, so it lands on the files tab. */
async function openOnFile(): Promise<ReturnType<typeof mountFor>> {
  const w = mountFor('c-2')
  await w.find('[data-action="change"]').trigger('click')
  await flushPromises()
  return w
}
/** Hands `file` to the hidden file input, as the browser's chooser would. */
async function chooseFile(w: ReturnType<typeof mountFor>, file: File): Promise<void> {
  const input = w.find('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
  // FileReader answers on its own task, after the microtasks flushPromises drains: wait for the
  // upload to go out (or for the refusal), then for its answer.
  await vi.waitFor(() => expect(posted().length > 0 || w.find('.err').exists()).toBe(true))
  await flushPromises()
}
const posted = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')

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
  it('does nothing when its caption, the None text or the hint is tapped', async () => {
    const w = mountFor('c-1')
    for (const sel of ['.lbl', '.none', '.field-hint']) await w.find(sel).trigger('click')
    await flushPromises()
    expect(tile('c-1').icon).toBeUndefined()
    expect(w.find('.picker').exists()).toBe(false)
  })
  it('keeps a Close button while the picker is open with no icon', async () => {
    const w = mountFor('c-1', { ...MANIFEST, icon: 'github' } as WidgetManifest)
    await w.find('[data-action="add"]').trigger('click')
    await flushPromises()
    await w.find('[data-action="change"]').trigger('click')
    expect(w.find('.picker').exists()).toBe(false)
  })
  it('closes the picker when the title is turned off', async () => {
    const w = mountFor('c-2')
    await w.find('[data-action="change"]').trigger('click')
    await flushPromises()
    useAdminStore().updateInstance('c-2', { showTitle: false })
    await flushPromises()
    useAdminStore().updateInstance('c-2', { showTitle: true })
    await flushPromises()
    expect(w.find('.picker').exists()).toBe(false)
  })
  it('switches a file back to tinted by dropping the key', async () => {
    tile('c-2').icon = { kind: 'file', name: '1-nas.svg', tint: false }
    const w = await openOnFile()
    await w.find('.tint input').setValue(true)
    expect(tile('c-2').icon).toEqual({ kind: 'file', name: '1-nas.svg' })
    expect(tile('c-2').icon).not.toHaveProperty('tint')
  })
  it('refuses a file over 256 KB without calling the server', async () => {
    const w = await openOnFile()
    await chooseFile(w, new File([new Uint8Array(256 * 1024 + 1)], 'big.png', { type: 'image/png' }))
    expect(posted()).toHaveLength(0)
    expect(w.find('.err').text()).toMatch(/256/)
  })
  it('imports a file into the library and applies it to the tile', async () => {
    const w = await openOnFile()
    await chooseFile(w, new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }))
    expect(posted()).toHaveLength(1)
    expect(tile('c-2').icon).toEqual({ kind: 'file', name: '2-logo.svg' })
    expect(w.findAll('[data-delete]').map((d) => d.attributes('data-delete'))).toEqual(['1-nas.svg', '2-logo.svg'])
  })
  it('lists a name the server answers twice only once', async () => {
    uploadAnswer = '1-nas.svg'
    const w = await openOnFile()
    await chooseFile(w, new File(['<svg/>'], 'nas.svg', { type: 'image/svg+xml' }))
    expect(w.findAll('[data-delete]').map((d) => d.attributes('data-delete'))).toEqual(['1-nas.svg'])
  })
  it('keeps the file and says why when the server refuses the delete', async () => {
    deleteStatus = 500
    const w = await openOnFile()
    const del = w.find('[data-delete="1-nas.svg"]')
    await del.trigger('click')
    await del.trigger('click')
    await flushPromises()
    expect(w.find('[data-delete="1-nas.svg"]').exists()).toBe(true)
    expect(w.find('.err').text()).toMatch(/refused 500/)
  })
  it('drops a file the server no longer has without an error', async () => {
    deleteStatus = 404
    const w = await openOnFile()
    const del = w.find('[data-delete="1-nas.svg"]')
    await del.trigger('click')
    await del.trigger('click')
    await flushPromises()
    expect(w.find('[data-delete="1-nas.svg"]').exists()).toBe(false)
    expect(w.find('.err').exists()).toBe(false)
  })
  it('forgets a half-confirmed delete when another tile is selected', async () => {
    tile('c-1').icon = { kind: 'file', name: '1-nas.svg' }
    const w = await openOnFile()
    await w.find('[data-delete="1-nas.svg"]').trigger('click')
    expect(w.find('[data-delete="1-nas.svg"]').classes()).toContain('danger')
    await w.setProps({ instance: tile('c-1') })
    await w.find('[data-action="change"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-delete="1-nas.svg"]').classes()).not.toContain('danger')
  })
})
