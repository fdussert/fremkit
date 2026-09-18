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
  it('counts only the built-in folder in builtinIds', async () => {
    await widget('clock', valid('clock'))
    await into(installed, 'synology', valid('synology'))
    const cat = new WidgetCatalog(dir, installed)
    await cat.scan()
    expect([...cat.builtinIds]).toEqual(['clock'])
  })

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
    // The sentence is the repository's own and comes out in the process's language; what matters
    // is that the refusal names the id and says it is a built-in.
    expect(cat.errors).toHaveLength(1)
    expect(cat.errors[0].id).toBe('clock')
    expect(cat.errors[0].error).toMatch(/clock/)
    expect(cat.errors[0].error).toMatch(/intégré|built-in/)
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
    expect([...cat.manifests.keys()]).toEqual(expect.arrayContaining(['clock', 'spotify', 'volume', 'shortcuts', 'clipboard', 'service-status', 'weather']))
    const shortcuts = cat.get('shortcuts')!
    expect(shortcuts.commands).toEqual(['shortcuts'])
    expect(shortcuts.minSize).toEqual([8, 4])
    expect(shortcuts.defaultSize).toEqual([16, 8])
    expect(Object.keys(shortcuts.settingsSchema.buttons.itemSchema ?? {})).toEqual(['label', 'kind', 'target'])
    const status = cat.get('service-status')!
    expect(status.subscriptions).toEqual([])
    expect(status.commands).toEqual(['service-status'])
    expect(status.minSize).toEqual([8, 4])
    expect(status.defaultSize).toEqual([8, 6])
    expect(status.settingsSchema.columns.default).toBe(2)
    const clipboard = cat.get('clipboard')!
    expect(clipboard.subscriptions).toEqual(['clipboard'])
    expect(clipboard.commands).toEqual(['clipboard'])
    expect(clipboard.minSize).toEqual([8, 4])
    expect(clipboard.defaultSize).toEqual([16, 8])
    expect([...cat.manifests.keys()]).toEqual(expect.arrayContaining(['clock', 'cpu', 'memory', 'network', 'battery']))
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
  it('remembers a built-in folder\'s id even when its manifest cannot be read', async () => {
    // The id is taken by the folder existing, not by its manifest parsing — otherwise a broken
    // built-in frees its name for an installed widget to take, and the next fix has two folders
    // claiming it.
    await widget('broken', '{ not json')
    await widget('clock', valid('clock'))
    const cat = new WidgetCatalog(dir)
    await cat.scan()
    expect(cat.entry('broken')).toBeUndefined()
    expect(cat.errors.map((e) => e.id)).toEqual(['broken'])
    expect([...cat.builtinIds].sort()).toEqual(['broken', 'clock'])
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
