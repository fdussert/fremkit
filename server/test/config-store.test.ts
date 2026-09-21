import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore } from '../src/config/store.js'
import { DEFAULT_CONFIG } from '../src/config/schema.js'

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
    expect((await store.load()).pages[0].id).toBe('x')
  })
  it('save validates, writes, keeps a .bak and notifies', async () => {
    const file = join(dir, 'fremkit.json')
    const store = new ConfigStore(file)
    await store.load()
    const seen: unknown[] = []
    store.onChange((c) => seen.push(c))
    const next = { version: 3, pages: [{ id: 'p2', name: 'Deux' }] }
    const saved = await store.save(next)
    expect(saved.pages[0].id).toBe('p2')
    expect(store.get().pages[0].id).toBe('p2')
    expect(seen).toHaveLength(1)
    expect(JSON.parse(await readFile(file + '.bak', 'utf8'))).toEqual(DEFAULT_CONFIG)
    await expect(stat(file + '.tmp')).rejects.toThrow()
  })
  it('save rejects an invalid config and keeps the old one', async () => {
    const store = new ConfigStore(join(dir, 'fremkit.json'))
    await store.load()
    await expect(store.save({ version: 3, pages: [] })).rejects.toThrow()
    expect(store.get()).toEqual(DEFAULT_CONFIG)
  })
  it('recovers from the .bak when the main file is corrupt', async () => {
    const file = join(dir, 'fremkit.json')
    await writeFile(file, '{ not json')
    await writeFile(file + '.bak', JSON.stringify({ version: 3, pages: [{ id: 'saved', name: 'Sauvée' }] }))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cfg = await new ConfigStore(file).load()
    err.mockRestore()
    expect(cfg.pages[0].id).toBe('saved')
    expect(JSON.parse(await readFile(file, 'utf8')).pages[0].id).toBe('saved')
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
    await expect(store.update((c) => { c.pages = []; throw new Error('nope') })).rejects.toThrow('nope')
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
    await writeFile(file, JSON.stringify({ version: 3, pages: [{ id: 'ok', name: 'OK' }] }))
    expect((await store.load()).pages[0].id).toBe('ok')
    err.mockRestore()
    expect(store.degraded).toBe(false)
  })
})
