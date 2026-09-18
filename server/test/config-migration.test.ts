import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateConfig } from '../src/config/migrate.js'
import { ConfigStore } from '../src/config/store.js'
import { DEFAULT_CONFIG } from '../src/config/schema.js'

const v1 = {
  version: 1,
  display: { cols: 32, rows: 8, cell: 80, autoCycleSeconds: 30 },
  pages: [{ id: 'home', name: 'Home', widgets: [{ instanceId: 'clock-1', widgetId: 'clock', x: 4, y: 1, w: 8, h: 2, settings: { seconds: true } }] }],
}

describe('migrateConfig', () => {
  it('doubles the grid and every instance, and fills the new fields', () => {
    const c = migrateConfig(v1)
    expect(c.version).toBe(2)
    expect(c.display).toEqual({ cols: 64, rows: 16, cell: 40, autoCycleSeconds: 30 })
    expect(c.pages[0].widgets[0]).toEqual({
      instanceId: 'clock-1', widgetId: 'clock', x: 8, y: 2, w: 16, h: 4,
      showTitle: true, settings: { seconds: true },
    })
  })
  it('treats a config without a version as v1', () => {
    const { version, ...noVersion } = v1
    expect(version).toBe(1)
    expect(migrateConfig(noVersion).display.cols).toBe(64)
  })
  it('accepts a v2 config unchanged', () => {
    const c2 = migrateConfig(v1)
    expect(migrateConfig(c2)).toEqual(c2)
  })
  it('rejects an unknown version with a clear message', () => {
    // Translated now, so match either language rather than the French wording.
    expect(() => migrateConfig({ ...v1, version: 7 })).toThrow(/(version de config inconnue|unknown config version).*7/)
  })
})

describe('ConfigStore migration', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'fremkit-mig-')) })

  it('rewrites a v1 file as v2 and keeps the original as .bak', async () => {
    const file = join(dir, 'fremkit.json')
    await writeFile(file, JSON.stringify(v1, null, 2))
    const cfg = await new ConfigStore(file).load()
    expect(cfg.version).toBe(2)
    expect(JSON.parse(await readFile(file, 'utf8')).display.cell).toBe(40)
    expect(JSON.parse(await readFile(file + '.bak', 'utf8'))).toEqual(v1)
  })
  it('leaves a v2 file untouched (no .bak rewrite)', async () => {
    const file = join(dir, 'fremkit.json')
    await writeFile(file, JSON.stringify(migrateConfig(v1), null, 2))
    const before = await readFile(file, 'utf8')
    await new ConfigStore(file).load()
    expect(await readFile(file, 'utf8')).toBe(before)
    await expect(readFile(file + '.bak', 'utf8')).rejects.toThrow()
  })
  it('serves the defaults on an unknown version and leaves the file untouched', async () => {
    const file = join(dir, 'fremkit.json')
    const original = JSON.stringify({ ...v1, version: 7 })
    await writeFile(file, original)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cfg = await new ConfigStore(file).load()
    const logged = err.mock.calls.join(' ')
    err.mockRestore()
    expect(cfg).toEqual(DEFAULT_CONFIG)
    // A file we cannot interpret is never rewritten: the next start retries against it.
    expect(await readFile(file, 'utf8')).toBe(original)
    expect(await readdir(dir)).toEqual(['fremkit.json'])
    expect(logged).toMatch(/(version de config inconnue|unknown config version).*7/)
  })

  it('renames an unparsable file to .corrupt-<epoch> and recovers from the .bak', async () => {
    const file = join(dir, 'fremkit.json')
    await writeFile(file, '{ not json')
    await writeFile(file + '.bak', JSON.stringify(migrateConfig(v1)))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cfg = await new ConfigStore(file).load()
    err.mockRestore()
    expect(cfg.pages[0].id).toBe('home')
    expect(JSON.parse(await readFile(file, 'utf8')).pages[0].id).toBe('home')
    const corrupt = (await readdir(dir)).filter((f) => f.startsWith('fremkit.json.corrupt-'))
    expect(corrupt).toHaveLength(1)
    expect(await readFile(join(dir, corrupt[0]), 'utf8')).toBe('{ not json')
  })

  it('never overwrites a pre-existing .corrupt file', async () => {
    const file = join(dir, 'fremkit.json')
    await writeFile(file + '.corrupt-1', 'first casualty')
    await writeFile(file, '{ not json either')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await new ConfigStore(file).load()
    err.mockRestore()
    expect(await readFile(file + '.corrupt-1', 'utf8')).toBe('first casualty')
    expect((await readdir(dir)).filter((f) => f.startsWith('fremkit.json.corrupt-'))).toHaveLength(2)
  })
})

describe('privacy.claudeAccountUsage on an older config', () => {
  const page = (widgets: object[]) => ({ id: 'home', name: 'Accueil', widgets })
  const widget = (widgetId: string) => ({ instanceId: 'a', widgetId, x: 0, y: 0, w: 8, h: 4 })

  it('starts off for a config that does not show the widget', () => {
    const cfg = migrateConfig({ version: 2, pages: [page([widget('clock')])] })
    expect(cfg.privacy.claudeAccountUsage).toBe(false)
  })

  it('starts on for a config that already shows it on a page', () => {
    // Those gauges were working before the opt-in existed; an upgrade must not blank them.
    const cfg = migrateConfig({ version: 2, pages: [page([widget('claude-usage')])] })
    expect(cfg.privacy.claudeAccountUsage).toBe(true)
  })

  it('starts on for a config that shows it in the navigation bar', () => {
    const cfg = migrateConfig({
      version: 2,
      display: { navWidgets: [{ instanceId: 'n1', widgetId: 'claude-usage' }] },
      pages: [page([widget('clock')])],
    })
    expect(cfg.privacy.claudeAccountUsage).toBe(true)
  })

  it('respects the field once the file carries it, either way', () => {
    const withWidget = (claudeAccountUsage: boolean) => migrateConfig({
      version: 2, privacy: { claudeAccountUsage }, pages: [page([widget('claude-usage')])],
    }).privacy.claudeAccountUsage
    // Turning it off on a dashboard that shows the widget is a choice, not a config to repair.
    expect(withWidget(false)).toBe(false)
    expect(withWidget(true)).toBe(true)
    expect(migrateConfig({ version: 2, privacy: { claudeAccountUsage: true }, pages: [page([widget('clock')])] })
      .privacy.claudeAccountUsage).toBe(true)
  })

  it('applies the same rule to a v1 file', () => {
    const v1page = (widgetId: string) => ({ id: 'home', name: 'Accueil', widgets: [{ instanceId: 'a', widgetId, x: 0, y: 0, w: 4, h: 2 }] })
    expect(migrateConfig({ version: 1, pages: [v1page('claude-usage')] }).privacy.claudeAccountUsage).toBe(true)
    expect(migrateConfig({ version: 1, pages: [v1page('clock')] }).privacy.claudeAccountUsage).toBe(false)
  })

  it('leaves a fresh install off', () => {
    expect(DEFAULT_CONFIG.privacy.claudeAccountUsage).toBe(false)
  })
})

describe('renamed stored values', () => {
  const withModel = (model: string) => ({
    version: 2,
    connections: [{ id: 'bambu-1', type: 'bambu', name: 'Imprimante', fields: { host: '192.0.2.10', serial: 'P1', model } }],
    pages: [{ id: 'home', name: 'Accueil', widgets: [] }],
  })

  it('turns a Bambu model of "autre" into "other"', () => {
    // A French word had been written into the user's file, where every other stored value is
    // English. The two mean the same thing to cameraTransport(), so nobody loses a selection.
    const cfg = migrateConfig(withModel('autre'))
    expect(cfg.connections[0].fields.model).toBe('other')
  })

  it('leaves every other model alone', () => {
    for (const model of ['H2C', 'X1C', 'A1 mini', 'other', '']) {
      expect(migrateConfig(withModel(model)).connections[0].fields.model, model).toBe(model)
    }
  })

  it('touches no other type and no other field', () => {
    const cfg = migrateConfig({
      version: 2,
      connections: [{ id: 'gh-1', type: 'github', name: 'GitHub', fields: { host: 'autre' } }],
      pages: [{ id: 'home', name: 'Accueil', widgets: [] }],
    })
    expect(cfg.connections[0].fields.host).toBe('autre')
  })
})

describe('marketplace consent', () => {
  it('is empty in a config written before it existed, and left alone in one that has it', () => {
    const before = migrateConfig({ version: 2, pages: [{ id: 'p', name: 'P', widgets: [] }] })
    expect(before.marketplace).toEqual({ installed: {} })

    const record = {
      version: '1.0.0', registry: 'fremkit-sietch', installedAt: '2026-09-18T12:00:00.000Z',
      consentedPermissions: { subscriptions: ['synology:*'], commands: [], network: [] },
    }
    const kept = migrateConfig({
      version: 2, pages: [{ id: 'p', name: 'P', widgets: [] }],
      marketplace: { installed: { 'synology-storage': record } },
    })
    expect(kept.marketplace.installed['synology-storage']).toEqual(record)
  })

  it('is empty after a v1 migration, which predates the marketplace', () => {
    const v1 = migrateConfig({ display: { cols: 32, rows: 8, cell: 80, autoCycleSeconds: 0 }, pages: [{ id: 'p', name: 'P', widgets: [] }] })
    expect(v1.marketplace).toEqual({ installed: {} })
  })

  it('refuses a record that does not say what was granted', () => {
    expect(() => migrateConfig({
      version: 2, pages: [{ id: 'p', name: 'P', widgets: [] }],
      marketplace: { installed: { demo: { version: '1.0.0', registry: 'r', installedAt: 'x' } } },
    })).toThrow()
  })
})
