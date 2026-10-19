import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore } from '../src/config/store.js'
import { DEFAULT_CONFIG } from '../src/config/schema.js'

/** A minimal v4 config: one Edge screen with one empty page. */
const v4 = (pageId: string, name: string) => ({
  version: 4,
  screens: [{ id: 'edge', name: 'Xeneon Edge', kind: 'edge', pages: [{ id: pageId, name }] }],
})
/** A minimal v3 file, as an older release wrote it. */
const v3 = (pageId: string, name: string) => ({ version: 3, pages: [{ id: pageId, name }] })

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'fremkit-')) })

/** The rescued file is suffixed with an epoch so a second failure never clobbers the first. */
async function corruptFile(d: string): Promise<string> {
  const found = (await readdir(d)).filter((f) => f.startsWith('fremkit.json.corrupt-'))
  expect(found).toHaveLength(1)
  return found[0]
}

describe('ConfigStore', () => {
  it('creates the default config when the file is missing', async () => {
    const store = new ConfigStore(join(dir, 'fremkit.json'))
    const cfg = await store.load()
    expect(cfg).toEqual(DEFAULT_CONFIG)
    expect(JSON.parse(await readFile(join(dir, 'fremkit.json'), 'utf8'))).toEqual(DEFAULT_CONFIG)
  })
  it('loads an existing file', async () => {
    const file = join(dir, 'fremkit.json')
    await writeFile(file, JSON.stringify({ version: 1, pages: [{ id: 'x', name: 'X' }] }))
    const store = new ConfigStore(file)
    expect((await store.load()).screens[0].pages[0].id).toBe('x')
  })
  it('save validates, writes, keeps a .bak and notifies', async () => {
    const file = join(dir, 'fremkit.json')
    const store = new ConfigStore(file)
    await store.load()
    const seen: unknown[] = []
    store.onChange((c) => seen.push(c))
    const saved = await store.save(v4('p2', 'Deux'))
    expect(saved.screens[0].pages[0].id).toBe('p2')
    expect(store.get().screens[0].pages[0].id).toBe('p2')
    expect(seen).toHaveLength(1)
    expect(JSON.parse(await readFile(file + '.bak', 'utf8'))).toEqual(DEFAULT_CONFIG)
    await expect(stat(file + '.tmp')).rejects.toThrow()
  })
  it('round-trips a page background through the file', async () => {
    const file = join(dir, 'fremkit.json')
    const store = new ConfigStore(file)
    await store.load()
    const cfg = v4('p', 'P')
    const background = { color: '#101820', image: 'dunes.webp', fit: 'contain' }
    ;(cfg.screens[0].pages[0] as Record<string, unknown>).background = background
    await store.save(cfg)
    expect(JSON.parse(await readFile(file, 'utf8')).screens[0].pages[0].background).toEqual(background)
    const reread = new ConfigStore(file)
    expect((await reread.load()).screens[0].pages[0].background).toEqual(background)
  })
  it('save rejects an invalid config and keeps the old one', async () => {
    const store = new ConfigStore(join(dir, 'fremkit.json'))
    await store.load()
    await expect(store.save({ version: 4, screens: [] })).rejects.toThrow()
    expect(store.get()).toEqual(DEFAULT_CONFIG)
  })
  it('recovers from the .bak when the main file is corrupt', async () => {
    const file = join(dir, 'fremkit.json')
    await writeFile(file, '{ not json')
    await writeFile(file + '.bak', JSON.stringify(v4('saved', 'Sauvée')))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cfg = await new ConfigStore(file).load()
    err.mockRestore()
    expect(cfg.screens[0].pages[0].id).toBe('saved')
    expect(JSON.parse(await readFile(file, 'utf8')).screens[0].pages[0].id).toBe('saved')
    expect(await readFile(join(dir, await corruptFile(dir)), 'utf8')).toBe('{ not json')
  })
  it('falls back to the defaults when the main file is corrupt and there is no .bak', async () => {
    const file = join(dir, 'fremkit.json')
    await writeFile(file, '{ "version": 42')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cfg = await new ConfigStore(file).load()
    err.mockRestore()
    expect(cfg).toEqual(DEFAULT_CONFIG)
    expect(await readFile(join(dir, await corruptFile(dir)), 'utf8')).toBe('{ "version": 42')
  })

  it('serializes overlapping updates so neither read-modify-write is lost', async () => {
    const store = new ConfigStore(join(dir, 'fremkit.json'))
    await store.load()
    await Promise.all([
      store.update((c) => ({ ...c, connections: [...c.connections, { id: 'a-1', type: 'x', name: 'A', fields: {} }] })),
      store.update((c) => ({ ...c, connections: [...c.connections, { id: 'b-1', type: 'x', name: 'B', fields: {} }] })),
    ])
    expect(store.get().connections.map((c) => c.id).sort()).toEqual(['a-1', 'b-1'])
    expect(JSON.parse(await readFile(join(dir, 'fremkit.json'), 'utf8')).connections).toHaveLength(2)
  })

  it('hands update a copy, so a thrown mutation leaves the config untouched', async () => {
    const store = new ConfigStore(join(dir, 'fremkit.json'))
    await store.load()
    const before = structuredClone(store.get())
    await expect(store.update((c) => { c.screens = []; throw new Error('nope') })).rejects.toThrow('nope')
    expect(store.get()).toEqual(before)
  })
  it('is degraded, and leaves the file alone, when valid JSON cannot be migrated', async () => {
    const file = join(dir, 'fremkit.json')
    const unknown = JSON.stringify({ version: 99, pages: [{ id: 'mine', name: 'Mienne' }] })
    await writeFile(file, unknown)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = new ConfigStore(file)
    const cfg = await store.load()
    err.mockRestore()
    expect(cfg).toEqual(DEFAULT_CONFIG)
    expect(store.degraded).toBe(true)
    expect(await readFile(file, 'utf8')).toBe(unknown)
    expect((await readdir(dir)).sort()).toEqual(['fremkit.json'])
  })
  it('a successful load clears the degraded flag', async () => {
    const file = join(dir, 'fremkit.json')
    await writeFile(file, JSON.stringify({ version: 99, pages: [{ id: 'mine', name: 'Mienne' }] }))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = new ConfigStore(file)
    await store.load()
    expect(store.degraded).toBe(true)
    await writeFile(file, JSON.stringify(v4('ok', 'OK')))
    expect((await store.load()).screens[0].pages[0].id).toBe('ok')
    err.mockRestore()
    expect(store.degraded).toBe(false)
  })

  it('writes fremkit.v3.json once', async () => {
    const file = join(dir, 'fremkit.json')
    const original = JSON.stringify(v3('mine', 'Mienne'), null, 2)
    await writeFile(file, original)
    const store = new ConfigStore(file)
    expect((await store.load()).version).toBe(4)
    // The rollback copy is the file exactly as the older release left it, byte for byte.
    expect(await readFile(join(dir, 'fremkit.v3.json'), 'utf8')).toBe(original)
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(4)

    // A second v3 file migrated later (a restore, a hand edit) never replaces the first copy.
    await writeFile(file, JSON.stringify(v3('other', 'Autre')))
    expect((await store.load()).screens[0].pages[0].id).toBe('other')
    expect(await readFile(join(dir, 'fremkit.v3.json'), 'utf8')).toBe(original)
  })
  it('writes no v3 copy for a v4 file', async () => {
    const file = join(dir, 'fremkit.json')
    await writeFile(file, JSON.stringify(v4('home', 'Home')))
    await new ConfigStore(file).load()
    expect(await readdir(dir)).toEqual(['fremkit.json'])
  })
  it('keeps the v3 copy when it recovers from a v3 .bak', async () => {
    const file = join(dir, 'fremkit.json')
    const bak = JSON.stringify(v3('saved', 'Sauvée'))
    await writeFile(file, '{ not json')
    await writeFile(file + '.bak', bak)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cfg = await new ConfigStore(file).load()
    err.mockRestore()
    expect(cfg.version).toBe(4)
    expect(cfg.screens[0].pages[0].id).toBe('saved')
    expect(await readFile(join(dir, 'fremkit.v3.json'), 'utf8')).toBe(bak)
  })
  it('writes no v3 copy when it recovers from a v4 .bak', async () => {
    const file = join(dir, 'fremkit.json')
    await writeFile(file, '{ not json')
    await writeFile(file + '.bak', JSON.stringify(v4('saved', 'Sauvée')))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await new ConfigStore(file).load()
    err.mockRestore()
    expect((await readdir(dir)).filter((f) => f.endsWith('.v3.json'))).toEqual([])
  })
})
