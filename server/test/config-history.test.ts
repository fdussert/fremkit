import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema, type Config } from '../src/config/schema.js'
import { ConfigHistory, HISTORY_ID_RE } from '../src/config/history.js'
import { ConfigStore } from '../src/config/store.js'

/** A v4 config whose only page is called `name`. */
const cfg = (name: string): Config => ConfigSchema.parse({
  version: 4,
  screens: [{ id: 'edge', name: 'Xeneon Edge', kind: 'edge', pages: [{ id: 'home', name }] }],
})

let dir: string
let clock: number
const now = () => clock
const MIN = 60_000

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fremkit-history-'))
  clock = Date.UTC(2026, 9, 18, 12, 0, 0)
})

const history = (opts: ConstructorParameters<typeof ConfigHistory>[1] = {}) =>
  new ConfigHistory(join(dir, 'history'), { now, ...opts })
const snapshots = async () => (await readdir(join(dir, 'history'))).filter((n) => HISTORY_ID_RE.test(n.replace(/\.json$/, '')))

describe('ConfigHistory', () => {
  it('records the state it replaces first, then the new one', async () => {
    const h = history()
    await h.recordChange(cfg('A'), cfg('B'), 'save')
    const list = await h.list()
    expect(list.map((e) => e.kind)).toEqual(['save', 'earlier'])
    expect(list[0].summary.pagesRenamed).toEqual([{ screen: 'Xeneon Edge', from: 'A', to: 'B' }])
    expect(list[1].summary.first).toBe(true)
    expect((await h.read(list[1].id))!.config.screens[0].pages[0].name).toBe('A')
  })

  it('coalesces a burst of saves into one entry, the last state winning', async () => {
    const h = history()
    await h.recordChange(cfg('A'), cfg('B'), 'save')
    clock += 30_000
    await h.recordChange(cfg('B'), cfg('C'), 'save')
    clock += 30_000
    await h.recordChange(cfg('C'), cfg('D'), 'save')
    const list = await h.list()
    expect(list).toHaveLength(2)
    expect((await h.read(list[0].id))!.config.screens[0].pages[0].name).toBe('D')
    // The summary is against the version below, not against the step before.
    expect(list[0].summary.pagesRenamed).toEqual([{ screen: 'Xeneon Edge', from: 'A', to: 'D' }])
    expect(list[0].savedAt).toBe(clock)
    expect(await snapshots()).toHaveLength(2)
  })

  it('opens a new entry once the window has passed', async () => {
    const h = history()
    await h.recordChange(cfg('A'), cfg('B'), 'save')
    clock += 2 * MIN + 1
    await h.recordChange(cfg('B'), cfg('C'), 'save')
    expect((await h.list()).map((e) => e.kind)).toEqual(['save', 'save', 'earlier'])
  })

  it('drops a burst that comes back to where it started', async () => {
    const h = history()
    await h.recordChange(cfg('A'), cfg('A'), 'save')
    clock += 10_000
    await h.recordChange(cfg('A'), cfg('B'), 'save')
    clock += 10_000
    await h.recordChange(cfg('B'), cfg('A'), 'save')
    expect((await h.list()).map((e) => e.kind)).toEqual(['earlier'])
  })

  it('records nothing for a save that changes nothing', async () => {
    const h = history()
    await h.recordChange(cfg('A'), cfg('B'), 'save')
    clock += 5 * MIN
    await h.recordChange(cfg('B'), cfg('B'), 'save')
    expect(await h.list()).toHaveLength(2)
  })

  it('never coalesces into or over a restore, so the version before it stays', async () => {
    const h = history()
    await h.recordChange(cfg('A'), cfg('B'), 'save')
    clock += 10_000
    await h.recordChange(cfg('B'), cfg('Z'), 'restore')
    clock += 10_000
    await h.recordChange(cfg('Z'), cfg('Z2'), 'save')
    const list = await h.list()
    expect(list.map((e) => e.kind)).toEqual(['save', 'restore', 'save', 'earlier'])
    expect((await h.read(list[2].id))!.config.screens[0].pages[0].name).toBe('B')
  })

  it('caps by count, never dropping the newest', async () => {
    const h = history({ maxEntries: 3 })
    for (let i = 0; i < 6; i++) {
      clock += 3 * MIN
      await h.recordChange(cfg(`P${i}`), cfg(`P${i + 1}`), 'save')
    }
    const list = await h.list()
    expect(list).toHaveLength(3)
    expect((await h.read(list[0].id))!.config.screens[0].pages[0].name).toBe('P6')
    expect(await snapshots()).toHaveLength(3)
  })

  it('caps by age, never dropping the newest', async () => {
    const h = history({ maxAgeMs: 10 * MIN })
    await h.recordChange(cfg('A'), cfg('B'), 'save')
    clock += 60 * MIN
    await h.recordChange(cfg('B'), cfg('C'), 'save')
    const list = await h.list()
    expect(list).toHaveLength(1)
    expect((await h.read(list[0].id))!.config.screens[0].pages[0].name).toBe('C')
  })

  it('writes 0600 files in a 0700 folder', async () => {
    const h = history()
    await h.recordChange(cfg('A'), cfg('B'), 'save')
    expect((await stat(join(dir, 'history'))).mode & 0o777).toBe(0o700)
    for (const name of await readdir(join(dir, 'history'))) {
      expect((await stat(join(dir, 'history', name))).mode & 0o777).toBe(0o600)
    }
  })

  it('rebuilds a lost index from the snapshot files', async () => {
    await history().recordChange(cfg('A'), cfg('B'), 'save')
    await rm(join(dir, 'history', 'index.json'))
    const list = await history().list()
    expect(list).toHaveLength(2)
    expect(list[0].summary.pagesRenamed).toEqual([{ screen: 'Xeneon Edge', from: 'A', to: 'B' }])
  })

  it('refuses an id that is not one of its own', async () => {
    const h = history()
    await h.recordChange(cfg('A'), cfg('B'), 'save')
    await writeFile(join(dir, 'secret.json'), '{}')
    expect(await h.read('../secret')).toBeNull()
    expect(await h.read('0000000000000-abcdef')).toBeNull()
  })
})

describe('ConfigStore with a history', () => {
  it('keeps the file as the older release wrote it before migrating it', async () => {
    const file = join(dir, 'fremkit.json')
    await writeFile(file, JSON.stringify({ version: 3, pages: [{ id: 'old', name: 'Old' }] }))
    const store = new ConfigStore(file, { history: history() })
    await store.load()
    const list = await store.history!.list()
    expect(list.map((e) => e.kind)).toEqual(['before-migration'])
    const raw = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'history', `${list[0].id}.json`), 'utf8'))
    expect(raw.version).toBe(3)
    expect((await store.history!.read(list[0].id))!.config.screens[0].pages[0].name).toBe('Old')

    // The next save is compared with the migrated dashboard, not recorded as a format change.
    clock += MIN
    const next = structuredClone(store.get())
    next.screens[0].pages[0].name = 'New'
    await store.save(next)
    const after = await store.history!.list()
    expect(after.map((e) => e.kind)).toEqual(['save', 'before-migration'])
    expect(after[0].summary.pagesRenamed).toEqual([{ screen: 'Xeneon Edge', from: 'Old', to: 'New' }])
  })

  it('records the reason a save gives', async () => {
    const file = join(dir, 'fremkit.json')
    await writeFile(file, JSON.stringify(cfg('A')))
    const store = new ConfigStore(file, { history: history() })
    await store.load()
    await store.save(cfg('B'), { reason: 'import' })
    expect((await store.history!.list()).map((e) => e.kind)).toEqual(['import', 'earlier'])
  })

  it('still saves when the history cannot be written', async () => {
    const file = join(dir, 'fremkit.json')
    await writeFile(file, JSON.stringify(cfg('A')))
    // A file where the folder should be: every history write fails.
    await writeFile(join(dir, 'history'), 'not a folder')
    const store = new ConfigStore(file, { history: history() })
    await store.load()
    const saved = await store.save(cfg('B'))
    expect(saved.screens[0].pages[0].name).toBe('B')
  })
})
