import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WidgetCatalog } from '../src/widgets/catalog.js'

/** The widgets the repository actually ships, as the server reads them at boot. */
const SHIPPED = fileURLToPath(new URL('../../widgets', import.meta.url))

let dir: string
let installed: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'widgets-'))
  installed = await mkdtemp(join(tmpdir(), 'installed-'))
})

async function into(root: string, id: string, manifest: unknown, withIndex = true) {
  await mkdir(join(root, id))
  if (manifest !== undefined) await writeFile(join(root, id, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  if (withIndex) await writeFile(join(root, id, 'index.html'), '<html></html>')
}

async function widget(id: string, manifest: unknown, withIndex = true) {
  await into(dir, id, manifest, withIndex)
}

const valid = (id: string) => ({ id, name: id, version: '1.0.0', minSize: [4, 2], defaultSize: [4, 2] })

describe('WidgetCatalog with an installed folder', () => {
  it('reads both folders and says which is which', async () => {
    await widget('clock', valid('clock'))
    await into(installed, 'synology', valid('synology'))
    const cat = new WidgetCatalog(dir, installed)
    await cat.scan()
    expect([...cat.manifests.keys()].sort()).toEqual(['clock', 'synology'])
    expect(cat.entry('clock')!.source).toBe('builtin')
    expect(cat.entry('synology')!.source).toBe('installed')
    expect(cat.folderOf('synology')).toBe(join(installed, 'synology'))
    expect(cat.errors).toEqual([])
  })

  it('never lets an installed widget stand in for a built-in of the same id', async () => {
    // The installer refuses the collision with a 409; this is what happens if a folder is
    // dropped in by hand anyway. The built-in keeps the id and the intruder is an error.
    await widget('clock', valid('clock'))
    await into(installed, 'clock', { ...valid('clock'), name: 'Not the clock' })
    const cat = new WidgetCatalog(dir, installed)
    await cat.scan()
    expect(cat.get('clock')!.name).toBe('clock')
    expect(cat.entry('clock')!.source).toBe('builtin')
    expect(cat.errors).toEqual([{ id: 'clock', error: 'id "clock" is already a built-in widget' }])
  })

  it('tolerates an installed folder that does not exist yet', async () => {
    await widget('clock', valid('clock'))
    const cat = new WidgetCatalog(dir, join(installed, 'nope'))
    await cat.scan()
    expect([...cat.manifests.keys()]).toEqual(['clock'])
    expect(cat.errors).toEqual([])
  })

  it('a rescan picks up a widget appearing in the installed folder', async () => {
    const cat = new WidgetCatalog(dir, installed)
    await cat.scan()
    expect(cat.manifests.size).toBe(0)
    await into(installed, 'synology', valid('synology'))
    await cat.scan()
    expect(cat.entry('synology')!.source).toBe('installed')
  })
})

describe('WidgetCatalog', () => {
  it('loads a valid widget with defaults', async () => {
    await widget('clock', valid('clock'))
    const cat = new WidgetCatalog(dir)
    await cat.scan()
    const m = cat.get('clock')!
    expect(m.subscriptions).toEqual([])
    expect(m.commands).toEqual([])
    expect(m.permissions.network).toEqual([])
    expect(cat.errors).toEqual([])
  })
  it('reports invalid json, schema errors, id mismatch and missing index.html', async () => {
    await widget('bad-json', '{ not json')
    await widget('bad-schema', { id: 'bad-schema', name: 'x' })
    await widget('mismatch', valid('other'))
    await widget('no-index', valid('no-index'), false)
    await writeFile(join(dir, 'stray.txt'), 'x')
    const cat = new WidgetCatalog(dir)
    await cat.scan()
    expect(cat.manifests.size).toBe(0)
    const ids = cat.errors.map((e) => e.id).sort()
    expect(ids).toEqual(['bad-json', 'bad-schema', 'mismatch', 'no-index'])
  })
  it('rescan drops removed widgets', async () => {
    await widget('clock', valid('clock'))
    const cat = new WidgetCatalog(dir)
    await cat.scan()
    expect(cat.manifests.size).toBe(1)
    await widget('cpu', valid('cpu'))
    await cat.scan()
    expect([...cat.manifests.keys()].sort()).toEqual(['clock', 'cpu'])
  })
  it('accepts every widget the repository ships', async () => {
    const cat = new WidgetCatalog(SHIPPED)
    await cat.scan()
    expect(cat.errors).toEqual([])
    expect([...cat.manifests.keys()]).toEqual(expect.arrayContaining(['clock', 'homey-devices', 'homey-flows', 'shortcuts', 'clipboard', 'service-status', 'cleanshot']))
    const shortcuts = cat.get('shortcuts')!
    expect(shortcuts.commands).toEqual(['shortcuts'])
    expect(shortcuts.minSize).toEqual([8, 4])
    expect(shortcuts.defaultSize).toEqual([16, 8])
    expect(Object.keys(shortcuts.settingsSchema.buttons.itemSchema ?? {})).toEqual(['label', 'kind', 'target'])
    const cleanshot = cat.get('cleanshot')!
    expect(cleanshot.subscriptions).toEqual([])
    expect(cleanshot.commands).toEqual(['cleanshot'])
    expect(cleanshot.minSize).toEqual([8, 4])
    expect(cleanshot.defaultSize).toEqual([12, 6])
    expect(cleanshot.settingsSchema.columns.default).toBe(3)
    const clipboard = cat.get('clipboard')!
    expect(clipboard.subscriptions).toEqual(['clipboard'])
    expect(clipboard.commands).toEqual(['clipboard'])
    expect(clipboard.minSize).toEqual([8, 4])
    expect(clipboard.defaultSize).toEqual([16, 8])
    expect([...cat.manifests.keys()]).toEqual(expect.arrayContaining(['clock', 'homey-devices', 'homey-flows', 'network', 'battery']))
  })
  it('gives the system widgets the sizes and channels their providers publish on', async () => {
    const cat = new WidgetCatalog(SHIPPED)
    await cat.scan()
    const network = cat.get('network')!
    expect(network.subscriptions).toEqual(['network'])
    expect([network.minSize, network.defaultSize]).toEqual([[8, 4], [12, 4]])
    const battery = cat.get('battery')!
    expect(battery.subscriptions).toEqual(['battery'])
    expect([battery.minSize, battery.defaultSize]).toEqual([[8, 4], [8, 6]])
    const status = cat.get('service-status')!
    expect(status.subscriptions).toEqual([])
    expect(status.commands).toEqual(['service-status'])
    expect(status.minSize).toEqual([8, 4])
    expect(status.defaultSize).toEqual([8, 6])
    expect(status.compact).toEqual({ width: 4 })
    expect(Object.keys(status.settingsSchema.services.itemSchema ?? {})).toEqual(['name', 'kind', 'url'])
    expect(status.settingsSchema.interval.default).toBe(30)
    expect(status.settingsSchema.columns.default).toBe(2)
  })
  it('marks every widget with the folder it came from', async () => {
    await widget('clock', valid('clock'))
    const cat = new WidgetCatalog(dir)
    await cat.scan()
    expect(cat.entry('clock')!.source).toBe('builtin')
    expect(cat.folderOf('clock')).toBe(join(dir, 'clock'))
    expect(cat.folderOf('nope')).toBeUndefined()
  })

  it('tolerates a missing widgets dir', async () => {
    const cat = new WidgetCatalog(join(dir, 'nope'))
    await cat.scan()
    expect(cat.manifests.size).toBe(0)
  })
})
